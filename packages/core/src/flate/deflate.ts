import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { updateAdler32 } from './adler32.ts';
import { BitWriter } from './bitWriter.ts';
import { writeCompressedBlock } from './deflateBlock.ts';
import { tokenize } from './lz77.ts';

/** Selects compression level 0–9, default 6; invalid levels raise InvalidArgumentError without a reason, and compressed input blocks are at most 1 MiB under RFC 1951, 3.2. */
export interface DeflateOptions {
  /** Compression level from 0 (stored blocks) to 9; defaults to 6. */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

// Input is tokenized and Huffman-coded in blocks of at most this many bytes; a block never has more tokens than bytes.
const BLOCK_BYTES = 1024 * 1024;

const compressionLevel = (options?: DeflateOptions): number => {
  const level = options?.level ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > 9) throw new InvalidArgumentError('compression level must be from 0 to 9');
  return level;
};

// RFC 1951, 3.2.4 limits stored blocks to 65,535 bytes and writes LEN followed by one's complement NLEN.
const writeStored = (writer: BitWriter, data: Uint8Array, final: boolean): void => {
  let offset = 0;
  do {
    const length = Math.min(65535, data.length - offset);
    writer.writeBits(final && offset + length === data.length ? 1 : 0, 3);
    writer.alignByte();
    writer.writeByte(length & 255);
    writer.writeByte(length >>> 8);
    writer.writeByte(~length & 255);
    writer.writeByte((~length >>> 8) & 255);
    writer.writeBytes(data.subarray(offset, offset + length));
    offset += length;
  } while (offset < data.length);
};

// Writes data as Huffman-coded blocks of at most BLOCK_BYTES; tokens holds at least min(data.length, BLOCK_BYTES) entries.
const writeCompressed = (writer: BitWriter, data: Uint8Array, { final, level, tokens }: { final: boolean; level: number; tokens: Uint32Array }): void => {
  if (data.length === 0) {
    if (final) writeCompressedBlock(writer, { words: new Uint32Array(), count: 0 }, true);
    return;
  }
  for (let offset = 0; offset < data.length; offset += BLOCK_BYTES) {
    const end = Math.min(offset + BLOCK_BYTES, data.length);
    const count = tokenize(data.subarray(offset, end), level, tokens);
    writeCompressedBlock(writer, { words: tokens, count }, final && end === data.length);
  }
};

/** Compresses bytes into a raw DEFLATE stream. */
export const deflateRaw = (data: Uint8Array, options?: DeflateOptions): Uint8Array => {
  const level = compressionLevel(options);
  const writer = new BitWriter();
  if (level === 0) writeStored(writer, data, true);
  else writeCompressed(writer, data, { final: true, level, tokens: new Uint32Array(Math.min(data.length, BLOCK_BYTES)) });
  return writer.finish();
};

/**
 * Compresses data given in pieces into a zlib stream, holding at most one block of input at a time, so that the uncompressed data never has to exist in one buffer.
 * The output is the same as deflateZlib gives for the pieces joined.
 */
export class ZlibDeflater {
  private readonly level: number;
  // Stored blocks hold at most 65,535 bytes, so a whole number of them fills a buffered block at level 0.
  private readonly blockBytes: number;
  private readonly writer = new BitWriter();
  private block = new Uint8Array(0);
  private used = 0;
  private tokens = new Uint32Array(0);
  private checksum = 1;

  constructor(options?: DeflateOptions) {
    this.level = compressionLevel(options);
    this.blockBytes = this.level === 0 ? 65535 * 16 : BLOCK_BYTES;
    // RFC 1950, 2.2 stores CMF/FLG with FCHECK making the header divisible by 31.
    let flevel = 3;
    if (this.level <= 1) flevel = 0;
    else if (this.level <= 5) flevel = 1;
    else if (this.level === 6) flevel = 2;
    const baseFlag = flevel << 6;
    this.writer.writeByte(0x78);
    this.writer.writeByte(baseFlag + ((31 - ((0x78 * 256 + baseFlag) % 31)) % 31));
  }

  private encode(data: Uint8Array, final: boolean): void {
    if (this.level === 0) {
      writeStored(this.writer, data, final);
      return;
    }
    if (this.tokens.length < data.length) this.tokens = new Uint32Array(data.length);
    writeCompressed(this.writer, data, { final, level: this.level, tokens: this.tokens });
  }

  write(data: Uint8Array): void {
    this.checksum = updateAdler32(this.checksum, data);
    let offset = 0;
    while (offset < data.length) {
      if (this.used === this.blockBytes) {
        this.encode(this.block, false);
        this.used = 0;
      }
      // A whole block with more input after it is encoded in place; the last block waits for finish, which marks it final.
      if (this.used === 0 && data.length - offset > this.blockBytes) {
        this.encode(data.subarray(offset, offset + this.blockBytes), false);
        offset += this.blockBytes;
        continue;
      }
      const length = Math.min(data.length - offset, this.blockBytes - this.used);
      if (this.block.length < this.used + length) {
        const grown = new Uint8Array(Math.min(this.blockBytes, Math.max(this.used + length, this.block.length * 2)));
        grown.set(this.block.subarray(0, this.used));
        this.block = grown;
      }
      this.block.set(data.subarray(offset, offset + length), this.used);
      this.used += length;
      offset += length;
    }
  }

  drain(): Uint8Array {
    return this.writer.drain();
  }

  /** Writes the final block and the Adler-32 trailer, in big-endian order (RFC 1950, 2.2). */
  finish(): Uint8Array {
    this.encode(this.block.subarray(0, this.used), true);
    this.used = 0;
    this.writer.alignByte();
    for (const shift of [24, 16, 8, 0]) this.writer.writeByte(Math.floor(this.checksum / 2 ** shift) % 256);
    return this.writer.finish();
  }
}

/** Pushes uncompressed bytes and finishes one zlib stream; writing after finish raises InvalidArgumentError without a reason, while RFC 1950, 2.2 defines its header and trailer. */
export interface DeflateStream {
  push: (data: Uint8Array) => Uint8Array[];
  finish: () => Uint8Array;
}

/** Emits complete zlib bytes after each input block while retaining only the current block and pending bits; it holds at most one block of input: 1 MiB, or 1,048,560 bytes at level 0. */
export const createDeflateStream = (options?: DeflateOptions): DeflateStream => {
  const encoder = new ZlibDeflater(options);
  let finished = false;
  return {
    push(data) {
      if (finished) throw new InvalidArgumentError('deflate stream is finished');
      const parts: Uint8Array[] = [];
      for (let offset = 0; offset < data.length; offset += 65536) {
        encoder.write(data.subarray(offset, offset + 65536));
        const part = encoder.drain();
        if (part.length > 0) parts.push(part);
      }
      return parts;
    },
    finish() {
      if (finished) throw new InvalidArgumentError('deflate stream is finished');
      finished = true;
      return encoder.finish();
    },
  };
};

/** Compresses bytes into a zlib stream with an Adler-32 trailer. */
export const deflateZlib = (data: Uint8Array, options?: DeflateOptions): Uint8Array => {
  const deflater = new ZlibDeflater(options);
  deflater.write(data);
  return deflater.finish();
};

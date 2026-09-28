import { ByteWriter } from '../bytes/byteWriter.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { adler32, updateAdler32 } from './adler32.ts';
import { BitReader } from './bitReader.ts';
import { ChunkedInflateOutput } from './chunkedInflateOutput.ts';
import { Huffman } from './huffman.ts';
import { CODE_LENGTH_ORDER, DISTANCE_BASE, DISTANCE_EXTRA, FIXED_DISTANCE_LENGTHS, FIXED_LITERAL_LENGTHS, LENGTH_BASE, LENGTH_EXTRA } from './tables.ts';

/** A nonfatal trailing-data, truncated-trailer, or checksum finding at a compressed byte offset under RFC 1950, 2.2. */
export interface FlateWarning {
  readonly code: 'trailing-data' | 'truncated-trailer' | 'checksum-mismatch';
  readonly offset: number;
}

/** Caps decoded output at 256 MiB by default; invalid caps raise InvalidArgumentError without a reason and output past the cap raises ResourceLimitError under RFC 1950 and RFC 1951. */
export interface InflateOptions {
  /** Largest decoded size accepted, in bytes; larger output throws ResourceLimitError. Defaults to 256 MiB. */
  maxOutputBytes?: number;
}

export interface ChunkedInflateOptions extends InflateOptions {
  /** Receives trailer warnings before the first decoded chunk is yielded. */
  onWarning?: (warning: FlateWarning) => void;
  /** Whether to decode from a copy of the input; defaults to true. With false the caller's buffer is read directly and must not change until iteration ends. */
  copyInput?: boolean;
}

interface DecodedRaw {
  data: Uint8Array;
  bytesConsumed: number;
}

interface InflatedZlib {
  data: Uint8Array;
  warnings: FlateWarning[];
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const maxOutputBytes = (options?: InflateOptions): number => {
  const limit = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new InvalidArgumentError('maxOutputBytes must be a non-negative integer');
  return limit;
};

class InflateOutput {
  private readonly bytes = new ByteWriter();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  private reserve(additional: number): void {
    if (this.bytes.length + additional > this.limit) throw new ResourceLimitError(`inflated data exceeds maxOutputBytes (${String(this.limit)} bytes)`);
  }

  push(byte: number): void {
    this.reserve(1);
    this.bytes.writeByte(byte);
  }

  copy(distance: number, length: number, offset: number): void {
    if (distance < 1 || distance > this.bytes.length || distance > 32768) throw new ParseError('invalid backward distance', offset);
    this.reserve(length);
    this.bytes.copyBack(distance, length);
  }

  toUint8Array(): Uint8Array {
    return this.bytes.toUint8Array();
  }
}

const FIXED: [Huffman, Huffman] = [new Huffman(FIXED_LITERAL_LENGTHS, 0), new Huffman(FIXED_DISTANCE_LENGTHS, 0)];

const repeatCount = (symbol: number, reader: BitReader): number => {
  if (symbol === 16) return reader.readBits(2) + 3;
  if (symbol === 17) return reader.readBits(3) + 3;
  return reader.readBits(7) + 11;
};

const dynamicTrees = (reader: BitReader): [Huffman, Huffman] => {
  // RFC 1951, 3.2.7 encodes the code-length alphabet in a fixed permutation, then run-length encodes the two trees.
  const literalCount = reader.readBits(5) + 257;
  const distanceCount = reader.readBits(5) + 1;
  // RFC 1951, 3.2.7 gives HLIT the range "(257 - 286)". Its HDIST range is "(1 - 32)", but 3.2.6 says "distance codes 30-31 cannot occur in the compressed data", and zlib's inflate rejects more than 30 distance codes, so this decoder does too.
  const headerOffset = Math.ceil(reader.bitPosition / 8);
  if (literalCount > 286) throw new ParseError(`dynamic block declares ${String(literalCount)} literal/length codes; at most 286 are allowed`, headerOffset);
  if (distanceCount > 30) throw new ParseError(`dynamic block declares ${String(distanceCount)} distance codes; at most 30 are allowed`, headerOffset);
  const codeCount = reader.readBits(4) + 4;
  const codeLengths = Array.from({ length: 19 }, () => 0);
  for (let index = 0; index < codeCount; index++) codeLengths[CODE_LENGTH_ORDER[index] ?? 0] = reader.readBits(3);
  const codeTree = new Huffman(codeLengths, Math.ceil(reader.bitPosition / 8));
  const lengths: number[] = [];
  const total = literalCount + distanceCount;
  while (lengths.length < total) {
    const symbol = codeTree.read(reader);
    if (symbol <= 15) lengths.push(symbol);
    else {
      if (symbol === 16 && lengths.length === 0) throw new ParseError('missing previous code length', Math.ceil(reader.bitPosition / 8));
      const repeated = symbol === 16 ? (lengths.at(-1) ?? 0) : 0;
      const count = repeatCount(symbol, reader);
      for (let index = 0; index < count; index++) lengths.push(repeated);
    }
    if (lengths.length > total) throw new ParseError('too many code lengths', Math.ceil(reader.bitPosition / 8));
  }
  if (lengths[256] === 0) throw new ParseError('missing end-of-block code', Math.ceil(reader.bitPosition / 8));
  return [
    new Huffman(lengths.slice(0, literalCount), Math.ceil(reader.bitPosition / 8)),
    new Huffman(lengths.slice(literalCount), Math.ceil(reader.bitPosition / 8)),
  ];
};

const decodeCompressed = (reader: BitReader, output: InflateOutput, trees: readonly [Huffman, Huffman]): void => {
  // RFC 1951, 3.2.5 maps symbols 257-285 to lengths and distance symbols 0-29 to backward distances.
  for (;;) {
    const symbol = trees[0].read(reader);
    if (symbol < 256) output.push(symbol);
    else if (symbol === 256) return;
    else {
      const index = symbol - 257;
      const base = LENGTH_BASE[index];
      if (base === undefined) throw new ParseError('invalid length code', Math.ceil(reader.bitPosition / 8));
      const length = base + reader.readBits(LENGTH_EXTRA[index] ?? 0);
      // RFC 1951, 3.2.7: "One distance code of zero bits means that there are no distance codes used at all (the data is all literals)."
      if (trees[1].empty) throw new ParseError('distance code used with an empty distance tree', Math.ceil(reader.bitPosition / 8));
      const distanceCode = trees[1].read(reader);
      const distanceBase = DISTANCE_BASE[distanceCode];
      if (distanceBase === undefined) throw new ParseError('invalid distance code', Math.ceil(reader.bitPosition / 8));
      const distance = distanceBase + reader.readBits(DISTANCE_EXTRA[distanceCode] ?? 0);
      output.copy(distance, length, Math.ceil(reader.bitPosition / 8));
    }
  }
};

const decodeRaw = (data: Uint8Array, limit: number): DecodedRaw => {
  const reader = new BitReader(data);
  const output = new InflateOutput(limit);
  let last = 0;
  while (last === 0) {
    last = reader.readBits(1);
    const blockType = reader.readBits(2);
    if (blockType === 0) {
      // RFC 1951, 3.2.4 aligns stored blocks and checks LEN against one's complement NLEN.
      reader.alignByte();
      const length = reader.readBits(16);
      const complement = reader.readBits(16);
      if (((length ^ complement) & 0xffff) !== 0xffff) throw new ParseError('invalid stored block length', Math.ceil(reader.bitPosition / 8));
      for (let index = 0; index < length; index++) output.push(reader.readBits(8));
    } else if (blockType === 1 || blockType === 2) {
      const trees = blockType === 1 ? FIXED : dynamicTrees(reader);
      decodeCompressed(reader, output, trees);
    } else throw new ParseError('reserved deflate block type', Math.ceil(reader.bitPosition / 8));
  }
  return { data: output.toUint8Array(), bytesConsumed: Math.ceil(reader.bitPosition / 8) };
};

/** Decodes a raw DEFLATE stream under the output limit. */
export const inflateRaw = (data: Uint8Array, options?: InflateOptions): Uint8Array => decodeRaw(data, maxOutputBytes(options)).data;

/** Decodes a zlib stream and reports recoverable wrapper warnings. */
export const inflateZlib = (data: Uint8Array, options?: InflateOptions): InflatedZlib => {
  const limit = maxOutputBytes(options);
  // RFC 1950, 2.2 requires CM=8, CINFO≤7, a header divisible by 31, and a preset dictionary marker when FDICT is set.
  if (data.length < 2) throw new ParseError('truncated zlib header', data.length);
  const cmf = data[0] ?? 0;
  const flg = data[1] ?? 0;
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || (cmf * 256 + flg) % 31 !== 0) throw new ParseError('invalid zlib header', 0);
  if ((flg & 0x20) !== 0) throw new UnsupportedFeatureError('preset dictionaries are unsupported');
  const decoded = decodeRaw(data.subarray(2), limit);
  const trailerOffset = decoded.bytesConsumed + 2;
  const warnings: FlateWarning[] = [];
  // RFC 1950, 2.2 ends the stream with a four-byte ADLER32 field; without all four bytes there is no checksum to compare.
  if (data.length - trailerOffset < 4) warnings.push({ code: 'truncated-trailer', offset: trailerOffset });
  else {
    // RFC 1950, 2.2 stores the Adler-32 checksum most-significant byte first.
    const expected =
      ((data[trailerOffset] ?? 0) * 16777216 +
        (data[trailerOffset + 1] ?? 0) * 65536 +
        (data[trailerOffset + 2] ?? 0) * 256 +
        (data[trailerOffset + 3] ?? 0)) >>>
      0;
    if (adler32(decoded.data) !== expected) warnings.push({ code: 'checksum-mismatch', offset: trailerOffset });
    if (data.length > trailerOffset + 4) warnings.push({ code: 'trailing-data', offset: trailerOffset + 4 });
  }
  return { data: decoded.data, warnings };
};

const decodeCompressedChunks = function* (reader: BitReader, output: ChunkedInflateOutput, trees: readonly [Huffman, Huffman]): Generator<Uint8Array> {
  // RFC 1951, 3.2.5 maps symbols 257-285 to lengths and distance symbols 0-29 to backward distances.
  for (;;) {
    const symbol = trees[0].read(reader);
    if (symbol < 256) output.push(symbol);
    else if (symbol === 256) return;
    else {
      const index = symbol - 257;
      const base = LENGTH_BASE[index];
      if (base === undefined) throw new ParseError('invalid length code', Math.ceil(reader.bitPosition / 8));
      const length = base + reader.readBits(LENGTH_EXTRA[index] ?? 0);
      if (trees[1].empty) throw new ParseError('distance code used with an empty distance tree', Math.ceil(reader.bitPosition / 8));
      const distanceCode = trees[1].read(reader);
      const distanceBase = DISTANCE_BASE[distanceCode];
      if (distanceBase === undefined) throw new ParseError('invalid distance code', Math.ceil(reader.bitPosition / 8));
      output.copy(distanceBase + reader.readBits(DISTANCE_EXTRA[distanceCode] ?? 0), length, Math.ceil(reader.bitPosition / 8));
    }
    const chunk = output.take();
    if (chunk !== undefined) yield chunk;
  }
};

const checkChunkTrailer = (config: { data: Uint8Array; trailerOffset: number; checksum: number; warnings: FlateWarning[] | undefined }): void => {
  // RFC 1950, 2.2: the four-byte Adler-32 trailer follows the deflate blocks.
  const { data, trailerOffset, checksum, warnings } = config;
  if (data.length - trailerOffset < 4) warnings?.push({ code: 'truncated-trailer', offset: trailerOffset });
  else {
    const expected = new DataView(data.buffer, data.byteOffset + trailerOffset, 4).getUint32(0);
    if (checksum !== expected) warnings?.push({ code: 'checksum-mismatch', offset: trailerOffset });
    if (data.length > trailerOffset + 4) warnings?.push({ code: 'trailing-data', offset: trailerOffset + 4 });
  }
};

const decodeChunks = function* (data: Uint8Array, limit: number, warnings?: FlateWarning[]): Generator<Uint8Array> {
  if (data.length < 2) throw new ParseError('truncated zlib header', data.length);
  const cmf = data[0] ?? 0;
  const flg = data[1] ?? 0;
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || (cmf * 256 + flg) % 31 !== 0) throw new ParseError('invalid zlib header', 0);
  if ((flg & 0x20) !== 0) throw new UnsupportedFeatureError('preset dictionaries are unsupported');
  const reader = new BitReader(data.subarray(2));
  const output = new ChunkedInflateOutput(limit);
  let checksum = 1;
  let last = 0;
  while (last === 0) {
    last = reader.readBits(1);
    const blockType = reader.readBits(2);
    if (blockType === 0) {
      reader.alignByte();
      const length = reader.readBits(16);
      const complement = reader.readBits(16);
      if (((length ^ complement) & 0xffff) !== 0xffff) throw new ParseError('invalid stored block length', Math.ceil(reader.bitPosition / 8));
      for (let index = 0; index < length; index++) output.push(reader.readBits(8));
      let chunk = output.take();
      while (chunk !== undefined) {
        checksum = updateAdler32(checksum, chunk);
        yield chunk;
        chunk = output.take();
      }
    } else if (blockType === 1 || blockType === 2) {
      const trees = blockType === 1 ? FIXED : dynamicTrees(reader);
      for (const chunk of decodeCompressedChunks(reader, output, trees)) {
        checksum = updateAdler32(checksum, chunk);
        yield chunk;
      }
    } else throw new ParseError('reserved deflate block type', Math.ceil(reader.bitPosition / 8));
  }
  const rest = output.finish();
  checksum = updateAdler32(checksum, rest);
  if (rest.length > 0) yield rest;
  checkChunkTrailer({ data, trailerOffset: Math.ceil(reader.bitPosition / 8) + 2, checksum, warnings });
};

/** Inflates a zlib stream with a 32 KiB history window and at most one 64 KiB output chunk. */
export const inflateChunks = function* (data: Uint8Array, options?: ChunkedInflateOptions): Generator<Uint8Array> {
  const limit = maxOutputBytes(options);
  const copy = options?.copyInput === false ? data : Uint8Array.from(data);
  const warnings: FlateWarning[] = [];
  const scan = decodeChunks(copy, limit, warnings);
  let complete = false;
  while (!complete) complete = scan.next().done === true;
  for (const warning of warnings) options?.onWarning?.(warning);
  yield* decodeChunks(copy, limit);
};

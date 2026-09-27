import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { adler32 } from './adler32.ts';
import { BitReader } from './bitReader.ts';
import { Huffman } from './huffman.ts';

export interface FlateWarning {
  readonly code: 'trailing-data' | 'truncated-trailer' | 'checksum-mismatch';
  readonly offset: number;
}

export interface InflateOptions {
  /** Largest decoded size accepted, in bytes; larger output throws ResourceLimitError. Defaults to 256 MiB. */
  maxOutputBytes?: number;
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
  private bytes: Uint8Array;
  private used = 0;
  private readonly limit: number;

  // Capacity never exceeds the limit, so a write that fits the buffer is within the limit.
  constructor(limit: number) {
    this.limit = limit;
    this.bytes = new Uint8Array(Math.min(256, limit));
  }

  get length(): number {
    return this.used;
  }

  private reserve(additional: number): void {
    const needed = this.used + additional;
    if (needed <= this.bytes.length) return;
    if (needed > this.limit) throw new ResourceLimitError(`inflated data exceeds maxOutputBytes (${String(this.limit)} bytes)`);
    let capacity = Math.max(this.bytes.length, 1);
    while (capacity < needed) capacity *= 2;
    capacity = Math.min(capacity, this.limit);
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
  }

  push(byte: number): void {
    this.reserve(1);
    this.bytes[this.used++] = byte;
  }

  copy(distance: number, length: number, offset: number): void {
    if (distance < 1 || distance > this.used || distance > 32768) throw new ParseError('invalid backward distance', offset);
    this.reserve(length);
    for (let index = 0; index < length; index++) {
      this.bytes[this.used] = this.bytes[this.used - distance] ?? 0;
      this.used++;
    }
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.used);
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12_289, 16_385, 24_577,
];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const fixedTrees = (): [Huffman, Huffman] => {
  // RFC 1951, 3.2.6 gives fixed literal/length code widths and five-bit distance codes.
  const literalLengths = Array.from({ length: 288 }, () => 0);
  for (let symbol = 0; symbol < 288; symbol++) {
    if (symbol < 144) literalLengths[symbol] = 8;
    else if (symbol < 256) literalLengths[symbol] = 9;
    else if (symbol < 280) literalLengths[symbol] = 7;
    else literalLengths[symbol] = 8;
  }
  return [
    new Huffman(literalLengths, 0),
    new Huffman(
      Array.from({ length: 32 }, () => 5),
      0,
    ),
  ];
};

const FIXED = fixedTrees();

const repeatCount = (symbol: number, reader: BitReader): number => {
  if (symbol === 16) return reader.readBits(2) + 3;
  if (symbol === 17) return reader.readBits(3) + 3;
  return reader.readBits(7) + 11;
};

const dynamicTrees = (reader: BitReader): [Huffman, Huffman] => {
  // RFC 1951, 3.2.7 encodes the code-length alphabet in a fixed permutation, then run-length encodes the two trees.
  const literalCount = reader.readBits(5) + 257;
  const distanceCount = reader.readBits(5) + 1;
  const codeCount = reader.readBits(4) + 4;
  const codeLengths = Array.from({ length: 19 }, () => 0);
  for (let index = 0; index < codeCount; index++) codeLengths[CODE_ORDER[index] ?? 0] = reader.readBits(3);
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

export const inflateRaw = (data: Uint8Array, options?: InflateOptions): Uint8Array => decodeRaw(data, maxOutputBytes(options)).data;

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

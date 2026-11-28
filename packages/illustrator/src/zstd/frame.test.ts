import { InvalidArgumentError } from '@pdfwright/core';
import fc from 'fast-check';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeRawFrame, encodeZstandardFrame, normalizeZstandardFrame } from './frame.ts';

const samples = (length: number): Uint8Array => {
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    output[index] = (index * 37 + Math.floor(index / 127)) % 256;
  }
  return output;
};

/** Bytes below `alphabet` from a linear congruential generator, so small alphabets repeat and 256 does not. */
const seeded = (length: number, seed: number, alphabet: number): Uint8Array => {
  const output = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = (state >>> 24) % alphabet;
  }
  return output;
};

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const EMPTY_LAST_RAW_BLOCK = [1, 0, 0] as const;
const littleEndian = (value: bigint, size: number): Array<number> => Array.from({ length: size }, (_, index) => Number((value >> BigInt(index * 8)) & 255n));
const blockHeader = (frame: Uint8Array, position: number) => {
  // RFC 8878, 3.1.1.2: Last_Block is bit 0, Block_Type bits 1-2 and Block_Size the remaining 21 bits.
  const header = (frame[position] ?? 0) | ((frame[position + 1] ?? 0) << 8) | ((frame[position + 2] ?? 0) << 16);
  return { last: (header & 1) === 1, type: (header >> 1) & 3, size: header >>> 3 };
};

describe('raw Zstandard frames', () => {
  it('writes the observed frame header and one empty final block', () => {
    expect(encodeRawFrame(new Uint8Array())).toStrictEqual(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58, 1, 0, 0]));
  });

  it('splits input at 128 KiB and marks only the final block', () => {
    const frame = encodeRawFrame(samples(131_073));
    expect(frame.slice(6, 9)).toStrictEqual(new Uint8Array([0, 0, 16]));
    expect(frame.slice(131_081, 131_084)).toStrictEqual(new Uint8Array([9, 0, 0]));
  });

  it('round-trips boundary and large inputs through an independent decoder', () => {
    for (const length of [0, 1, 127, 131_071, 131_072, 131_073, 270_000]) {
      const input = samples(length);
      expect(decompress(encodeRawFrame(input))).toStrictEqual(input);
    }
  });

  it('removes a single-segment content size and checksum', () => {
    const blocks = encodeRawFrame(new Uint8Array([1, 2, 3, 4, 5])).slice(6);
    const caller = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x24, 5, ...blocks, 7, 8, 9, 10]);
    const normalized = normalizeZstandardFrame(caller);
    expect(normalized.slice(0, 6)).toStrictEqual(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]));
    expect(decompress(normalized)).toStrictEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('keeps a larger single-segment window when needed', () => {
    const input = samples(2_097_153);
    const blocks = encodeRawFrame(input).slice(6);
    const caller = new Uint8Array(9 + blocks.length);
    caller.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 1, 0, 32, 0]);
    caller.set(blocks, 9);
    const normalized = normalizeZstandardFrame(caller);
    expect(normalized[5]).toBe(0x59);
    const decoded = decompress(normalized);
    expect(decoded).toHaveLength(input.length);
    expect(decoded[0]).toBe(input[0]);
    expect(decoded[2_097_152]).toBe(input[2_097_152]);
  });

  it('walks an RLE block by its one-byte body before removing a checksum', () => {
    const caller = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 4, 0x58, 0x43, 6, 0, 17, 0, 0, 0, 0]);
    const normalized = normalizeZstandardFrame(caller);
    expect(decompress(normalized)).toStrictEqual(new Uint8Array(200).fill(17));
  });

  it('rejects dictionary IDs, skippable frames and trailing bytes', () => {
    const skippable = new Uint8Array([0x50, 0x2a, 0x4d, 0x18]);
    const dictionary = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 0x58, 0]);
    const frame = encodeRawFrame(new Uint8Array([1]));
    const trailing = new Uint8Array([...frame, 0]);
    expect(() => normalizeZstandardFrame(skippable)).toThrow('ordinary Zstandard frame');
    expect(() => normalizeZstandardFrame(dictionary)).toThrow('dictionaries are unsupported');
    expect(() => normalizeZstandardFrame(trailing)).toThrow('trailing or missing bytes');
  });

  it('compresses repeated native text and preserves random bytes', () => {
    const repeated = new TextEncoder().encode('0 1 0 0 0 Xy\r'.repeat(5000));
    const compressed = encodeZstandardFrame(repeated);
    expect(compressed.length).toBeLessThan(repeated.length / 4);
    expect(decompress(compressed)).toStrictEqual(repeated);
    expect(encodeZstandardFrame(repeated)).toStrictEqual(compressed);
    const random = samples(30_000);
    expect(decompress(encodeZstandardFrame(random))).toStrictEqual(random);
  });

  // RFC 8878, 3.1.1.1.1 and 3.1.1.2: header bits 3 and 4 are reserved, Block_Type 3 is reserved, and Block_Size never exceeds 128 KiB.
  it.each([
    { name: 'reserved bit 3', frame: [...MAGIC, 0x08, 0x58, ...EMPTY_LAST_RAW_BLOCK], message: /reserved header bits/u },
    { name: 'reserved bit 4', frame: [...MAGIC, 0x10, 0x58, ...EMPTY_LAST_RAW_BLOCK], message: /reserved header bits/u },
    { name: 'a three-byte input', frame: [0x28, 0xb5, 0x2f], message: /truncated Zstandard frame/u },
    { name: 'a missing window descriptor', frame: [...MAGIC, 0], message: /truncated Zstandard frame/u },
    { name: 'a block body past the end', frame: [...MAGIC, 0, 0x58, (5 << 3) | 1, 0, 0, 1, 2], message: /truncated Zstandard block/u },
    { name: 'a missing final block', frame: [...MAGIC, 0, 0x58, 1 << 3, 0, 0, 9], message: /truncated Zstandard frame/u },
    { name: 'block type 3', frame: [...MAGIC, 0, 0x58, (3 << 1) | 1, 0, 0], message: /invalid Zstandard block/u },
    { name: 'a 131,073-byte block', frame: [...MAGIC, 0, 0x58, ...littleEndian((131_073n << 3n) | 1n, 3)], message: /invalid Zstandard block/u },
    { name: 'a missing checksum', frame: [...MAGIC, 4, 0x58, (1 << 3) | 1, 0, 0, 9], message: /trailing or missing bytes/u },
    { name: 'a three-byte checksum', frame: [...MAGIC, 4, 0x58, (1 << 3) | 1, 0, 0, 9, 1, 2, 3], message: /trailing or missing bytes/u },
  ])('rejects $name with InvalidArgumentError', ({ frame, message }) => {
    const normalize = () => normalizeZstandardFrame(new Uint8Array(frame));
    expect(normalize).toThrow(InvalidArgumentError);
    expect(normalize).toThrow(message);
  });

  it('accepts a 131,072-byte block', () => {
    const frame = encodeRawFrame(samples(131_072));
    expect(normalizeZstandardFrame(frame)).toStrictEqual(frame);
  });

  // RFC 8878, 3.1.1.1.1: Frame_Content_Size_Flag selects a 0-, 2-, 4- or 8-byte field, and a single-segment frame with flag 0 has a 1-byte field.
  // RFC 8878, 3.1.1.1.4: the 2-byte form stores the size minus 256.
  it.each([
    { name: 'single-segment, 1-byte size', descriptor: 0x20, window: [], size: [200], length: 200 },
    { name: 'single-segment, 2-byte size', descriptor: 0x60, window: [], size: littleEndian(300n - 256n, 2), length: 300 },
    { name: 'single-segment, 4-byte size', descriptor: 0xa0, window: [], size: littleEndian(300n, 4), length: 300 },
    { name: 'single-segment, 8-byte size', descriptor: 0xe0, window: [], size: littleEndian(300n, 8), length: 300 },
    { name: 'windowed, no size', descriptor: 0x00, window: [0x40], size: [], length: 300 },
    { name: 'windowed, 2-byte size', descriptor: 0x40, window: [0x40], size: littleEndian(300n - 256n, 2), length: 300 },
    { name: 'windowed, 4-byte size', descriptor: 0x80, window: [0x40], size: littleEndian(300n, 4), length: 300 },
    { name: 'windowed, 8-byte size and checksum', descriptor: 0xc4, window: [0x40], size: littleEndian(300n, 8), length: 300 },
  ])('removes the $name header fields', ({ descriptor, window, size, length }) => {
    const input = samples(length);
    const blocks = encodeZstandardFrame(input).slice(6);
    const checksum = (descriptor & 4) === 0 ? [] : [1, 2, 3, 4];
    const normalized = normalizeZstandardFrame(new Uint8Array([...MAGIC, descriptor, ...window, ...size, ...blocks, ...checksum]));
    expect(normalized).toStrictEqual(new Uint8Array([...MAGIC, 0, 0x58, ...blocks]));
    expect(decompress(normalized)).toStrictEqual(input);
  });

  // RFC 8878, 3.1.1.1.2: Window_Size = 2 ** (10 + Exponent) * (1 + Mantissa / 8), and a single-segment window is the content size.
  it.each([
    { name: 'window 0x50', header: [0x00, 0x50], descriptor: 0x58 },
    { name: 'window 0x58', header: [0x00, 0x58], descriptor: 0x58 },
    { name: 'window 0x59', header: [0x00, 0x59], descriptor: 0x59 },
    { name: 'window 0x60', header: [0x00, 0x60], descriptor: 0x60 },
    { name: 'content size 2,097,152', header: [0xa0, ...littleEndian(2_097_152n, 4)], descriptor: 0x58 },
    { name: 'content size 2,097,153', header: [0xa0, ...littleEndian(2_097_153n, 4)], descriptor: 0x59 },
    { name: 'content size 2 ** 32', header: [0xe0, ...littleEndian(2n ** 32n, 8)], descriptor: 0xb0 },
    { name: 'content size 2 ** 32 + 1', header: [0xe0, ...littleEndian(2n ** 32n + 1n, 8)], descriptor: 0xb1 },
    { name: 'content size 15 * 2 ** 38', header: [0xe0, ...littleEndian(15n * 2n ** 38n, 8)], descriptor: 0xff },
  ])('writes window descriptor $descriptor for $name', ({ header, descriptor }) => {
    const normalized = normalizeZstandardFrame(new Uint8Array([...MAGIC, ...header, ...EMPTY_LAST_RAW_BLOCK]));
    expect(normalized).toStrictEqual(new Uint8Array([...MAGIC, 0, descriptor, ...EMPTY_LAST_RAW_BLOCK]));
  });

  it('rejects a single-segment content size beyond window descriptor 255', () => {
    const frame = new Uint8Array([...MAGIC, 0xe0, ...littleEndian(15n * 2n ** 38n + 1n, 8), ...EMPTY_LAST_RAW_BLOCK]);
    expect(() => normalizeZstandardFrame(frame)).toThrow(InvalidArgumentError);
    expect(() => normalizeZstandardFrame(frame)).toThrow(/beyond the RFC descriptor range/u);
  });

  it.each([131_072, 131_073, 262_145])('round-trips %d repetitive bytes through the compressed encoder, deterministically', length => {
    const input = seeded(length, 20_261_128, 4);
    const compressed = encodeZstandardFrame(input);
    expect(decompress(compressed)).toStrictEqual(input);
    expect(encodeZstandardFrame(input)).toStrictEqual(compressed);
  });

  it('writes a raw block for incompressible input and a compressed block for repetitive input', () => {
    const input = new Uint8Array(131_072 + 131_072);
    input.set(seeded(131_072, 987_654_321, 256));
    input.set(new TextEncoder().encode('0 1 0 0 0 Xy\r'.repeat(10_083)).subarray(0, 131_072), 131_072);
    const frame = encodeZstandardFrame(input);
    const first = blockHeader(frame, 6);
    const second = blockHeader(frame, 9 + first.size);
    // RFC 8878, 3.1.1.2.2: Block_Type 0 is Raw_Block and 2 is Compressed_Block.
    expect(first).toStrictEqual({ last: false, type: 0, size: 131_072 });
    expect(second).toMatchObject({ last: true, type: 2 });
    expect(second.size).toBeLessThan(131_072 / 4);
    expect(frame).toHaveLength(9 + first.size + 3 + second.size);
    expect(decompress(frame)).toStrictEqual(input);
  });
});

describe('properties', () => {
  // Lengths stay inside one block, whose boundaries the tests above cover, and small alphabets make the match finder emit sequences.
  const content = fc
    .tuple(fc.integer({ min: 0, max: 1024 }), fc.integer(), fc.constantFrom(2, 4, 16, 256))
    .map(([size, seed, alphabet]) => seeded(size, seed, alphabet));

  it('decodes what both encoders write, deterministically', () => {
    fc.assert(
      fc.property(content, input => {
        const compressed = encodeZstandardFrame(input);
        expect(decompress(compressed)).toStrictEqual(input);
        expect(encodeZstandardFrame(input)).toStrictEqual(compressed);
        expect(decompress(encodeRawFrame(input))).toStrictEqual(input);
      }),
    );
  });

  // RFC 8878, 3.1.1.1.1: every combination of single-segment, content-size and checksum fields that can describe the content.
  const callerFrame = fc
    .record({
      input: fc.tuple(fc.integer({ min: 0, max: 1024 }), fc.integer(), fc.constantFrom(4, 256)).map(([size, seed, alphabet]) => seeded(size, seed, alphabet)),
      singleSegment: fc.boolean(),
      sizeFlag: fc.integer({ min: 0, max: 3 }),
      checksum: fc.boolean(),
      window: fc.integer({ min: 0, max: 0x70 }),
      compressed: fc.boolean(),
    })
    .filter(({ input, singleSegment, sizeFlag }) => {
      if (sizeFlag === 0) {
        return !singleSegment || input.length < 256;
      }
      if (sizeFlag === 1) {
        return input.length >= 256 && input.length < 65_792;
      }
      return true;
    });

  it('normalizes a caller frame to the fixed header without changing its content', () => {
    fc.assert(
      fc.property(callerFrame, ({ input, singleSegment, sizeFlag, checksum, window, compressed }) => {
        const blocks = (compressed ? encodeZstandardFrame(input) : encodeRawFrame(input)).slice(6);
        const fieldSize = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 ** sizeFlag;
        const storedSize = BigInt(input.length) - (fieldSize === 2 ? 256n : 0n);
        const descriptor = (sizeFlag << 6) | (singleSegment ? 0x20 : 0) | (checksum ? 4 : 0);
        const frame = new Uint8Array([
          ...MAGIC,
          descriptor,
          ...(singleSegment ? [] : [window]),
          ...littleEndian(storedSize, fieldSize),
          ...blocks,
          ...(checksum ? [5, 6, 7, 8] : []),
        ]);
        const normalized = normalizeZstandardFrame(frame);
        expect(normalized).toStrictEqual(new Uint8Array([...MAGIC, 0, singleSegment ? 0x58 : Math.max(0x58, window), ...blocks]));
        expect(decompress(normalized)).toStrictEqual(input);
        expect(normalizeZstandardFrame(normalized)).toStrictEqual(normalized);
      }),
    );
  });
});

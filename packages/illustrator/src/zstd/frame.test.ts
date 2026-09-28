import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeRawFrame, normalizeZstandardFrame } from './frame.ts';

const samples = (length: number): Uint8Array => {
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index++) output[index] = (index * 37 + Math.floor(index / 127)) % 256;
  return output;
};

describe('raw Zstandard frames', () => {
  it('writes the observed frame header and one empty final block', () => {
    expect(encodeRawFrame(new Uint8Array())).toStrictEqual(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58, 1, 0, 0]));
  });

  it('splits input at 128 KiB and marks only the final block', () => {
    const frame = encodeRawFrame(samples(131073));
    expect(frame.slice(6, 9)).toStrictEqual(new Uint8Array([0, 0, 16]));
    expect(frame.slice(131081, 131084)).toStrictEqual(new Uint8Array([9, 0, 0]));
  });

  it('round-trips boundary and large inputs through an independent decoder', () => {
    for (const length of [0, 1, 127, 131071, 131072, 131073, 270000]) {
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
    const input = samples(2097153);
    const blocks = encodeRawFrame(input).slice(6);
    const caller = new Uint8Array(9 + blocks.length);
    caller.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 1, 0, 32, 0]);
    caller.set(blocks, 9);
    const normalized = normalizeZstandardFrame(caller);
    expect(normalized[5]).toBe(0x59);
    const decoded = decompress(normalized);
    expect(decoded).toHaveLength(input.length);
    expect(decoded[0]).toBe(input[0]);
    expect(decoded[2097152]).toBe(input[2097152]);
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
});

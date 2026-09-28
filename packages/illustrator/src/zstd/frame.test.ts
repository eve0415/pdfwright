import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeRawFrame } from './frame.ts';

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
});

import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeRawFrame } from './frame.ts';

const decodeWithLibzstd = promisify(zstdDecompress);

describe('zstandard decoder agreement', () => {
  it.each([0, 1, 131071, 131072, 131073, 2097153])('matches libzstd and fzstd for %i input bytes', async length => {
    const input = new Uint8Array(length);
    for (let index = 0; index < length; index++) input[index] = (index * 43 + Math.floor(index / 163)) % 256;
    const frame = encodeRawFrame(input);
    const decoded = await decodeWithLibzstd(frame);
    expect(decoded.compare(input)).toBe(0);
    expect(Buffer.from(decompress(frame)).compare(input)).toBe(0);
  });
});

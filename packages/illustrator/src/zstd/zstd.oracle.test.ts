import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';

import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeRawFrame, normalizeZstandardFrame } from './frame.ts';

const decodeWithLibzstd = promisify(zstdDecompress);
const compressWithLibzstd = promisify(zstdCompress);

describe('zstandard decoder agreement', () => {
  it.each([0, 1, 131071, 131072, 131073, 2097153])('matches libzstd and fzstd for %i input bytes', async length => {
    const input = new Uint8Array(length);
    for (let index = 0; index < length; index++) input[index] = (index * 43 + Math.floor(index / 163)) % 256;
    const frame = encodeRawFrame(input);
    const decoded = await decodeWithLibzstd(frame);
    expect(decoded.compare(input)).toBe(0);
    expect(Buffer.from(decompress(frame)).compare(input)).toBe(0);
  });

  it('normalizes a libzstd compressed frame without altering its content', async () => {
    const input = new TextEncoder().encode('Illustrator native layer data. '.repeat(5000));
    const caller = await compressWithLibzstd(input);
    const normalized = normalizeZstandardFrame(caller);
    expect(normalized.slice(0, 6)).toStrictEqual(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]));
    const decoded = await decodeWithLibzstd(normalized);
    expect(decoded.compare(input)).toBe(0);
    expect(Buffer.from(decompress(normalized)).compare(input)).toBe(0);
  });
});

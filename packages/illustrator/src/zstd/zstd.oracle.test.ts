import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';

import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeCompressedBlock } from './compressBlock.ts';
import { encodeRawFrame, normalizeZstandardFrame } from './frame.ts';
import { createMatchFinder } from './matchFinder.ts';

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

  it('decodes our predefined-table compressed block with libzstd', async () => {
    const input = new TextEncoder().encode(`${'abcd'.repeat(5000)}${'variable text '.repeat(100)}`);
    const parse = createMatchFinder(input).parseBlock(0, input.length);
    const body = encodeCompressedBlock(parse);
    const frame = new Uint8Array(9 + body.length);
    frame.set([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]);
    const header = (body.length << 3) | 5;
    frame[6] = header & 255;
    frame[7] = (header >>> 8) & 255;
    frame[8] = (header >>> 16) & 255;
    frame.set(body, 9);
    const decoded = await decodeWithLibzstd(frame);
    expect(decoded.compare(input)).toBe(0);
    expect(Buffer.from(decompress(frame)).compare(input)).toBe(0);
  });
});

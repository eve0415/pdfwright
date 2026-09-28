import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { parseIccStructure } from './iccStructure.ts';

const ascii = (bytes: Uint8Array, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index++) bytes[offset + index] = value.codePointAt(index) ?? 0;
};

const profile = (): Uint8Array => {
  const bytes = new Uint8Array(172);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes[8] = 4;
  bytes[9] = 0x40;
  ascii(bytes, 12, 'prtr');
  ascii(bytes, 16, 'CMYK');
  ascii(bytes, 20, 'Lab ');
  ascii(bytes, 36, 'acsp');
  view.setInt32(68, 0x0000f6d6);
  view.setInt32(72, 0x00010000);
  view.setInt32(76, 0x0000d32d);
  view.setUint32(128, 2);
  ascii(bytes, 132, 'A2B0');
  view.setUint32(136, 156);
  view.setUint32(140, 16);
  ascii(bytes, 144, 'A2B1');
  view.setUint32(148, 156);
  view.setUint32(152, 16);
  ascii(bytes, 156, 'mft2');
  return bytes;
};

describe('icc structure', () => {
  it('reads a header and shared tag data through a sliced byte view', () => {
    const bytes = profile();
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 3);
    const parsed = parseIccStructure(padded.subarray(3, 3 + bytes.length));
    expect(parsed.header.version).toStrictEqual({ major: 4, minor: 4, bugfix: 0 });
    expect([parsed.header.profileClass, parsed.header.colorSpace, parsed.header.pcs]).toStrictEqual(['output', 'CMYK', 'Lab']);
    expect(parsed.tags.map(tag => [tag.signature, tag.offset, tag.size])).toStrictEqual([
      ['A2B0', 156, 16],
      ['A2B1', 156, 16],
    ]);
    bytes[156] = 0;
    expect(parsed.bytes[156]).toBe('m'.codePointAt(0));
  });

  it('rejects overlapping and out-of-bounds tags with typed reasons', () => {
    const overlapping = profile();
    new DataView(overlapping.buffer).setUint32(148, 160);
    new DataView(overlapping.buffer).setUint32(152, 12);
    expect(() => parseIccStructure(overlapping)).toThrow(InvalidProfileError);
    expect(() => parseIccStructure(overlapping)).toThrow('ICC tags overlap');
    const short = profile();
    new DataView(short.buffer).setUint32(152, 100);
    expect(() => parseIccStructure(short)).toThrow(InvalidProfileError);
  });
});

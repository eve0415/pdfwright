import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { parseIccStructure } from './iccStructure.ts';

const fixture = (): Uint8Array => {
  const bytes = new Uint8Array(132);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes[8] = 4;
  bytes.set(new TextEncoder().encode('mntrRGB XYZ acsp'), 12);
  bytes.set(new TextEncoder().encode('acsp'), 36);
  new DataView(bytes.buffer).setUint32(128, 0);
  return bytes;
};

describe('icc profile identity', () => {
  it('zeros only flags, intent and header ID before hashing the declared profile size', () => {
    const bytes = fixture();
    const expected = md5(bytes);
    bytes.set([1, 2, 3, 4], 44);
    bytes.set([0, 0, 0, 1], 64);
    bytes.fill(7, 84, 100);
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes);
    const parsed = parseIccStructure(padded);
    expect(parsed.identity).toStrictEqual(expected);
    expect(parsed.warnings.map(warning => warning.code)).toStrictEqual(['trailing-data', 'profile-id-mismatch']);
  });
});

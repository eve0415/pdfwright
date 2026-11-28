import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';
import { iccProfileBytes, xyzTag } from '../testing/iccProfileBytes.ts';

import { iccIdentity } from './iccIdentity.ts';
import { parseIccStructure } from './iccStructure.ts';

// ICC.1:2022, 7.2.18: the profile flags (44–47), rendering intent (64–67) and profile ID (84–99) are zero while the ID is computed.
const zeroed = [
  [44, 48],
  [64, 68],
  [84, 100],
] as const;

const fixture = (): Uint8Array => {
  const bytes = new Uint8Array(132);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes[8] = 4;
  bytes.set(new TextEncoder().encode('mntrRGB XYZ acsp'), 12);
  bytes.set(new TextEncoder().encode('acsp'), 36);
  // Every byte the ID covers outside the fixed fields is non-zero, so zeroing more than the three fields changes the digest.
  bytes.fill(0x11, 40, 44);
  bytes.fill(0x22, 48, 64);
  bytes.fill(0x33, 68, 84);
  bytes.fill(0x44, 100, 128);
  return bytes;
};

const withZeroedFields = (bytes: Uint8Array): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  for (const [start, end] of zeroed) {
    copy.fill(0, start, end);
  }
  return copy;
};

describe('icc profile identity', () => {
  it('zeros only flags, intent and header ID before hashing the declared profile size', () => {
    const bytes = fixture();
    const expected = md5(withZeroedFields(bytes));
    bytes.set([1, 2, 3, 4], 44);
    bytes.set([0, 0, 0, 1], 64);
    bytes.fill(7, 84, 100);
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes);
    padded.fill(0x55, bytes.length);
    const parsed = parseIccStructure(padded);
    expect(parsed.identity).toStrictEqual(expected);
    expect(parsed.warnings).toStrictEqual([
      { code: 'trailing-data', offset: 132 },
      { code: 'profile-id-mismatch', offset: 84 },
    ]);
  });

  describe('properties', () => {
    const profileBytes = fc.uint8Array({ minLength: 132, maxLength: 4096 });

    it('ignores the flags, intent and profile ID fields', () => {
      fc.assert(
        fc.property(profileBytes, fc.uint8Array({ minLength: 24, maxLength: 24 }), (bytes, replacement) => {
          const changed = Uint8Array.from(bytes);
          changed.set(replacement.subarray(0, 4), 44);
          changed.set(replacement.subarray(4, 8), 64);
          changed.set(replacement.subarray(8, 24), 84);
          expect(iccIdentity(changed)).toStrictEqual(iccIdentity(bytes));
        }),
      );
    });

    it('changes when any other byte changes', () => {
      fc.assert(
        fc.property(profileBytes, fc.nat(), fc.integer({ min: 1, max: 255 }), (bytes, position, mask) => {
          const index = position % bytes.length;
          fc.pre(zeroed.every(([start, end]) => index < start || index >= end));
          const changed = Uint8Array.from(bytes);
          changed[index] = (changed[index] ?? 0) ^ mask;
          expect(iccIdentity(changed)).not.toStrictEqual(iccIdentity(bytes));
        }),
      );
    });

    it('ignores bytes past the declared size and reports them as trailing data', () => {
      const bytes = iccProfileBytes({ profileClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', tags: [['bkpt', xyzTag([0.25, 0.5, 0.125])]] });
      const identity = parseIccStructure(bytes).identity;
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), trailing => {
          const padded = new Uint8Array(bytes.length + trailing.length);
          padded.set(bytes);
          padded.set(trailing, bytes.length);
          const parsed = parseIccStructure(padded);
          expect([parsed.identity, parsed.warnings]).toStrictEqual([identity, [{ code: 'trailing-data', offset: bytes.length }]]);
        }),
      );
    });
  });
});

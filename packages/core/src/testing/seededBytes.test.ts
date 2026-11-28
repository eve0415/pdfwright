import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { seededBytes } from './seededBytes.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

describe('seeded bytes', () => {
  // The expected values were computed outside the library with Python: s = (s * 1664525 + 1013904223) % 2**32, then s >> 24, per byte.
  it.each([
    [0x12_34_56_78, [117, 205, 37, 75, 132, 226, 234, 242]],
    [0, [60, 71, 209, 170, 98, 159, 87, 163]],
    [0xff_ff_ff_ff, [60, 48, 34, 161, 183, 223, 233, 185]],
  ])('starts the sequence for seed %i with the high byte of each state', (seed, expected) => {
    expect([...seededBytes(8, seed)]).toStrictEqual(expected);
  });

  it('matches the digest of one MiB computed outside the library, the input the flate tests build by hand', () => {
    const bytes = seededBytes(1024 * 1024, 0x12_34_56_78);
    expect([bytes.length, bytes.at(-1), hex(md5(bytes))]).toStrictEqual([1_048_576, 90, '2188cbcc097cf5a64d83409bda861f83']);
  });

  it('returns a prefix of the longer sequence for a shorter length, and nothing for length 0', () => {
    expect([...seededBytes(5, 7)]).toStrictEqual([...seededBytes(9, 7).subarray(0, 5)]);
    expect(seededBytes(0, 7)).toStrictEqual(new Uint8Array());
  });

  it.each([
    ['a negative length', -1, 0],
    ['a fractional length', 1.5, 0],
    ['a negative seed', 4, -1],
    ['a seed above 32 bits', 4, 2 ** 32],
    ['a fractional seed', 4, 0.5],
  ])('refuses %s', (_, length, seed) => {
    expect(() => seededBytes(length, seed)).toThrow(RangeError);
  });
});

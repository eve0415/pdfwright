import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { deterministicCbrt, deterministicPow } from './ieeeMath.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

// 2^exponent by exact doubling or halving, which stays exact down to the smallest subnormal, so it does not depend on an engine's own pow.
const powerOfTwo = (exponent: number): number => {
  let value = 1;
  for (let step = 0; step < Math.abs(exponent); step++) {
    value = exponent < 0 ? value / 2 : value * 2;
  }
  return value;
};

const bitView = new DataView(new ArrayBuffer(8));
const bitsOf = (value: number): bigint => {
  bitView.setFloat64(0, Math.abs(value));
  return bitView.getBigUint64(0);
};

// The number of doubles between two finite values of the same sign: 0 when they are equal, 1 when they are adjacent.
const ulpsBetween = (first: number, second: number): number => {
  if (Math.sign(first) !== Math.sign(second)) {
    return Infinity;
  }
  const difference = bitsOf(first) - bitsOf(second);
  return Number(difference < 0n ? -difference : difference);
};

describe('deterministic ICC math', () => {
  it('evaluates standard roots and powers', () => {
    expect(deterministicCbrt(8)).toBe(2);
    expect(deterministicCbrt(-27)).toBe(-3);
    expect(deterministicPow(0.5, 2)).toBe(0.25);
    expect(deterministicPow(0, 2.4)).toBe(0);
    for (let index = 1; index < 4096; index++) {
      const base = index / 4096;
      expect(Math.abs(deterministicPow(base, 1 / 2.4) - base ** (1 / 2.4))).toBeLessThan(1e-12);
    }
  });

  // IEEE 754-2019, 9.2.1: the special cases of pow, written as literals because an engine's own ** gives NaN for 1 ** NaN.
  it.each([
    { base: Number.NaN, exponent: 0, expected: 1 },
    { base: 1, exponent: Number.NaN, expected: 1 },
    { base: 0, exponent: -1.5, expected: Infinity },
    { base: 0, exponent: 1.5, expected: 0 },
    { base: -2, exponent: 0.5, expected: Number.NaN },
    { base: Number.NaN, exponent: 1.5, expected: Number.NaN },
    { base: 0.5, exponent: Number.NaN, expected: Number.NaN },
    { base: 0.5, exponent: Infinity, expected: 0 },
    { base: 2, exponent: Infinity, expected: Infinity },
    { base: 0.5, exponent: -Infinity, expected: Infinity },
    { base: 2, exponent: -Infinity, expected: 0 },
    { base: Infinity, exponent: 2.5, expected: Infinity },
    { base: Infinity, exponent: -1.5, expected: 0 },
  ])('gives pow($base, $exponent) = $expected', ({ base, exponent, expected }) => {
    expect(deterministicPow(base, exponent)).toBe(expected);
  });

  it.each([
    { label: '0', value: 0 },
    { label: '-0', value: -0 },
    { label: 'Infinity', value: Infinity },
    { label: '-Infinity', value: -Infinity },
    { label: 'NaN', value: Number.NaN },
  ])('passes $label through cbrt unchanged', ({ value }) => {
    expect(deterministicCbrt(value)).toBe(value);
  });

  it('takes exact cube roots of subnormal inputs', () => {
    expect(deterministicCbrt(powerOfTwo(-1071))).toBe(powerOfTwo(-357));
    expect(deterministicCbrt(-powerOfTwo(-1074))).toBe(-powerOfTwo(-358));
    expect(deterministicCbrt(27 * powerOfTwo(-1074))).toBe(3 * powerOfTwo(-358));
    expect(ulpsBetween(deterministicCbrt(1e-310), Math.cbrt(1e-310))).toBeLessThanOrEqual(1);
  });

  it.each([1.8, 2.2, 2.4, 1 / 2.2, 3, -0.7])('raises bases from 1e-6 to 1e6, across every mantissa interval, to %d within 2 ulp', exponent => {
    let worst = 0;
    for (let index = 0; index <= 600; index++) {
      const base = 10 ** (-6 + index / 50) * (1 + (index % 7) / 9);
      worst = Math.max(worst, ulpsBetween(deterministicPow(base, exponent), base ** exponent));
    }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('raises a subnormal base within 2 ulp', () => {
    expect(ulpsBetween(deterministicPow(1e-310, 0.3), 1e-310 ** 0.3)).toBeLessThanOrEqual(2);
    expect(ulpsBetween(deterministicPow(5e-324, 0.25), 5e-324 ** 0.25)).toBeLessThanOrEqual(2);
  });

  it('overflows at 2^1024 and not below it', () => {
    expect(ulpsBetween(deterministicPow(2, 1023.4), 2 ** 1023.4)).toBeLessThanOrEqual(2);
    expect(deterministicPow(2, 1023)).toBe(powerOfTwo(1023));
    expect(deterministicPow(2, 1024)).toBe(Infinity);
  });

  // 2^-1075 lies halfway between 0 and the smallest subnormal and rounds to the even neighbour, 0.
  it.each([-1022, -1030, -1042, -1043, -1050, -1074])('gives 2^%d exactly, across the subnormal ranges of the scale factor', exponent => {
    expect(deterministicPow(2, exponent)).toBe(powerOfTwo(exponent));
  });

  it('underflows to zero below the smallest subnormal', () => {
    expect(deterministicPow(2, -1075)).toBe(0);
  });

  it('keeps the same float64 digest in every runtime', () => {
    const bytes = new Uint8Array(8192 * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 4096; index++) {
      const value = (index + 0.5) / 4096;
      view.setFloat64(index * 16, deterministicCbrt(value), true);
      view.setFloat64(index * 16 + 8, deterministicPow(value, 1 / 2.4), true);
    }
    expect(hex(md5(bytes))).toBe('42fc2516cd3af7b55a1e3b0431d11c91');
  });
});

describe('properties', () => {
  // Bases from 1e-6 to 1e6 and exponents from -8 to 8 give results from 1e-48 to 1e48, all normal doubles.
  it('raises a positive base to a power within 2 ulp of the engine pow', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 1e6, noNaN: true }), fc.double({ min: -8, max: 8, noNaN: true }), (base, exponent) => {
        expect(ulpsBetween(deterministicPow(base, exponent), base ** exponent)).toBeLessThanOrEqual(2);
      }),
    );
  });

  it('takes a cube root within 1 ulp of the engine cbrt', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), value => {
        expect(ulpsBetween(deterministicCbrt(value), Math.cbrt(value))).toBeLessThanOrEqual(1);
      }),
    );
  });
});

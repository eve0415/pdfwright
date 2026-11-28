import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  deterministicAtanDegrees,
  deterministicCosDegrees,
  deterministicExp,
  deterministicLog,
  deterministicLog10,
  deterministicSinDegrees,
} from './deterministicMath.ts';

describe('deterministic calculator math', () => {
  it('approximates logarithms across the positive finite range', () => {
    for (const value of [Number.MIN_VALUE, 1e-100, 0.001, 0.5, 1, 2, 10, 1e100, Number.MAX_VALUE]) {
      expect(Math.abs(deterministicLog(value) - Math.log(value))).toBeLessThan(2e-12);
      expect(Math.abs(deterministicLog10(value) - Math.log10(value))).toBeLessThan(2e-12);
    }
  });

  it('evaluates degree trigonometry and all arctangent quadrants', () => {
    for (let degrees = -720; degrees <= 720; degrees += 7) {
      expect(Math.abs(deterministicSinDegrees(degrees) - Math.sin((degrees * Math.PI) / 180))).toBeLessThan(2e-14);
      expect(Math.abs(deterministicCosDegrees(degrees) - Math.cos((degrees * Math.PI) / 180))).toBeLessThan(2e-14);
    }
    for (const numerator of [-10, -1, 0, 1, 10]) {
      for (const denominator of [-10, -1, 0, 1, 10]) {
        const expected = ((Math.atan2(numerator, denominator) * 180) / Math.PI + 360) % 360;
        expect(Math.abs(deterministicAtanDegrees(numerator, denominator) - expected)).toBeLessThan(2e-12);
      }
    }
  });

  it('raises negative bases to integer powers', () => {
    expect(deterministicExp(-2, 3)).toBe(-8);
    expect(deterministicExp(-2, 4)).toBe(16);
    expect(deterministicExp(-2, 0.5)).toBeNaN();
    expect([deterministicExp(-1, 2 ** 53 - 1), deterministicExp(-1, 2 ** 53)]).toStrictEqual([-1, 1]);
  });

  it('returns the IEEE 754 logarithm of zero, negative values, NaN and infinity', () => {
    expect([0, -1, Number.NaN, Infinity].map(value => deterministicLog(value))).toStrictEqual([-Infinity, Number.NaN, Number.NaN, Infinity]);
  });

  // 1.4 times a power of two has a mantissa in the range fdlibm e_log.c treats with a separate polynomial, and 1 or 2 plus a small fraction has the top mantissa bits clear.
  it.each([1.4, 1.4 * 2 ** 30, 1.4 * 2 ** -30, 1 + 2 ** -40, 2 + 2 ** -39])('approximates the logarithm of %d within a few units in the last place', value => {
    const expected = Math.log(value);
    expect(Math.abs(deterministicLog(value) - expected)).toBeLessThanOrEqual(4 * Number.EPSILON * Math.abs(expected));
  });

  it('returns NaN for the sine and cosine of infinity and NaN', () => {
    expect([Infinity, -Infinity, Number.NaN].flatMap(value => [deterministicSinDegrees(value), deterministicCosDegrees(value)])).toStrictEqual(
      Array.from({ length: 6 }, () => Number.NaN),
    );
  });

  it('evaluates arctangents of ratios near one half, near two and beyond 2^66', () => {
    for (const [numerator, denominator] of [
      [1, 2],
      [2, 1],
      [-1, 2],
      [2, -1],
    ] as const) {
      const expected = ((Math.atan2(numerator, denominator) * 180) / Math.PI + 360) % 360;
      expect(Math.abs(deterministicAtanDegrees(numerator, denominator) - expected)).toBeLessThan(2e-12);
    }
    expect([deterministicAtanDegrees(1e30, 1), deterministicAtanDegrees(-1e30, 1)]).toStrictEqual([90, 270]);
  });
});

describe('properties', () => {
  // The remainder of an integer by 360 is exact, so whole turns added to an angle of the same sign leave its sine and cosine unchanged.
  it('repeats degree sine and cosine exactly every 360 degrees', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), fc.boolean(), (degrees, turns, negative) => {
        const angle = negative ? -degrees : degrees;
        const turned = angle + (negative ? -360 : 360) * turns;
        expect([deterministicSinDegrees(turned), deterministicCosDegrees(turned)]).toStrictEqual([
          deterministicSinDegrees(angle),
          deterministicCosDegrees(angle),
        ]);
      }),
    );
  });
});

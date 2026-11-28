import type { Length } from './length.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { add, compare, equals, formatLength, inch, mm, multiply, negate, pt, subtract } from './length.ts';

const expectEqual = (left: Length, right: Length): void => {
  expect([equals(left, right)]).toStrictEqual([true]);
};

describe('exact lengths', () => {
  // ISO 32000-1:2008, 8.3.2.3 sets 72 points to the inch, so a millimetre is 72 / 25.4 = 360 / 127 points.
  it('converts millimetres to points as exact rationals, without binary floating point error', () => {
    expect([mm(210), mm(297), mm(25.4)]).toStrictEqual([
      { numerator: 75_600n, denominator: 127n },
      { numerator: 106_920n, denominator: 127n },
      { numerator: 72n, denominator: 1n },
    ]);
    expect([formatLength(mm(210), 10), formatLength(mm(297), 10), formatLength(mm(25.4), 10)]).toStrictEqual(['595.2755905512', '841.8897637795', '72']);
    expectEqual(inch(1), pt(72));
  });

  it.each([
    ['pt(0.1)', pt(0.1), { numerator: 1n, denominator: 10n }],
    ['pt(-2.5)', pt(-2.5), { numerator: -5n, denominator: 2n }],
    ['inch(0.5)', inch(0.5), { numerator: 36n, denominator: 1n }],
    ['mm(1)', mm(1), { numerator: 360n, denominator: 127n }],
    ['negate(mm(3))', negate(mm(3)), { numerator: -1080n, denominator: 127n }],
    ['mm(-3)', mm(-3), { numerator: -1080n, denominator: 127n }],
    ['multiply(mm(3), 0)', multiply(mm(3), 0), { numerator: 0n, denominator: 1n }],
    ['multiply(mm(3), -2)', multiply(mm(3), -2), { numerator: -2160n, denominator: 127n }],
    ['subtract(mm(3), mm(3))', subtract(mm(3), mm(3)), { numerator: 0n, denominator: 1n }],
  ])('stores %s in lowest terms with a positive denominator', (_, length, expected) => {
    expect(length).toStrictEqual(expected);
  });

  it('retains exact arithmetic across repeated additions', () => {
    let sum = pt(0);
    for (let index = 0; index < 10_000; index++) {
      sum = add(sum, mm(0.1));
    }
    expect([equals(sum, mm(1000))]).toStrictEqual([true]);
    const three = mm(3);
    const negativeThree = mm(-3);
    const zero = pt(0);
    expectEqual(add(three, negativeThree), zero);
    expectEqual(subtract(three, three), zero);
    expectEqual(negate(three), negativeThree);
  });

  it('compares and multiplies exact lengths', () => {
    const three = mm(3);
    const half = mm(1.5);
    expectEqual(multiply(three, 0.5), half);
    expectEqual(multiply(three, -2), mm(-6));
    expect(compare(mm(2), mm(3))).toBe(-1);
    expect(compare(mm(3), mm(3))).toBe(0);
    expect(compare(mm(4), mm(3))).toBe(1);
  });

  it.each([
    [mm(-3), pt(0), -1],
    [pt(0), mm(-3), 1],
    [pt(-1), pt(-2), 1],
    [pt(-2), pt(-1), -1],
  ])('compares negative length %o with %o as %i', (left, right, expected) => {
    expect(compare(left, right)).toBe(expected);
  });

  it('normalizes rational storage and rejects invalid input', () => {
    expect(mm(25.4)).toStrictEqual({ numerator: 72n, denominator: 1n });
    expect([Object.isFrozen(mm(1))]).toStrictEqual([true]);
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(() => pt(value)).toThrow(InvalidArgumentError);
      expect(() => mm(value)).toThrow(InvalidArgumentError);
      expect(() => inch(value)).toThrow(InvalidArgumentError);
      expect(() => multiply(pt(1), value)).toThrow(InvalidArgumentError);
    }
  });

  // ISO 32000-1:2008, Annex C, Table C.1 recommends a real magnitude of at most 3.403 × 10^38.
  it('formats up to the largest real and ten fractional digits, and rejects one past either', () => {
    expect([formatLength(pt(3.403e38), 5), formatLength(pt(-3.403e38), 5), formatLength(pt(1.5), 10)]).toStrictEqual([
      '340300000000000000000000000000000000000',
      '-340300000000000000000000000000000000000',
      '1.5',
    ]);
    expect(() => formatLength(pt(3.404e38), 5)).toThrow(InvalidArgumentError);
    expect(() => formatLength(pt(-3.404e38), 5)).toThrow(InvalidArgumentError);
    expect(() => formatLength(pt(1), 11)).toThrow(InvalidArgumentError);
  });
});

const gcd = (left: bigint, right: bigint): bigint => (right === 0n ? left : gcd(right, left % right));

describe('properties', () => {
  const decimal = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
  const length = fc.oneof(
    decimal.map(value => pt(value)),
    decimal.map(value => mm(value)),
    decimal.map(value => inch(value)),
  );

  it('subtracts what it adds', () => {
    fc.assert(
      fc.property(length, length, (left, right) => {
        expect(subtract(add(left, right), right)).toStrictEqual(left);
      }),
    );
  });

  it('compares antisymmetrically, and equal exactly when the difference is zero', () => {
    fc.assert(
      fc.property(length, length, (left, right) => {
        const { numerator } = subtract(left, right);
        const sign = Number(numerator > 0n) - Number(numerator < 0n);
        expect([compare(left, right), compare(right, left), equals(left, right)]).toStrictEqual([sign, -sign || 0, sign === 0]);
      }),
    );
  });

  it('negates twice to the same length', () => {
    fc.assert(
      fc.property(length, value => {
        expect(negate(negate(value))).toStrictEqual(value);
      }),
    );
  });

  it('keeps every result in lowest terms with a positive denominator', () => {
    fc.assert(
      fc.property(length, length, fc.double({ min: -1000, max: 1000, noNaN: true }), (left, right, factor) => {
        const results = [add(left, right), subtract(left, right), multiply(left, factor), negate(left)];
        expect(
          results.map(result => [result.denominator > 0n, gcd(result.numerator < 0n ? -result.numerator : result.numerator, result.denominator)]),
        ).toStrictEqual(results.map(() => [true, 1n]));
      }),
    );
  });
});

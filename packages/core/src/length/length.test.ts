import type { Length } from './length.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { add, compare, equals, formatLength, inch, mm, multiply, negate, pt, subtract } from './length.ts';

const expectEqual = (left: Length, right: Length): void => {
  expect([equals(left, right)]).toStrictEqual([true]);
};

const expectedMillimetres = (value: bigint, fractionDigits: number): string => {
  const numerator = value * 360n * 10n ** BigInt(fractionDigits);
  const quotient = numerator / 127n;
  const remainder = numerator % 127n;
  const rounded = quotient + (remainder * 2n > 127n || (remainder * 2n === 127n && quotient % 2n === 1n) ? 1n : 0n);
  const digits = rounded.toString().padStart(fractionDigits + 1, '0');
  const fraction = digits.slice(-fractionDigits).replace(/0+$/u, '');
  return `${digits.slice(0, -fractionDigits)}${fraction.length > 0 ? `.${fraction}` : ''}`;
};

describe('exact lengths', () => {
  it('converts millimetres to points without binary floating point error', () => {
    expect(formatLength(mm(210), 5)).toBe(expectedMillimetres(210n, 5));
    expect(formatLength(mm(297), 5)).toBe(expectedMillimetres(297n, 5));
    expect(formatLength(mm(25.4), 5)).toBe('72');
    expectEqual(inch(1), pt(72));
  });

  it('retains exact arithmetic across repeated additions', () => {
    let sum = pt(0);
    for (let index = 0; index < 10_000; index++) sum = add(sum, mm(0.1));
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
    expect(compare(mm(2), mm(3))).toBe(-1);
    expect(compare(mm(3), mm(3))).toBe(0);
    expect(compare(mm(4), mm(3))).toBe(1);
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
});

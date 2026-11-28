import type { Length } from '@pdfwright/core';

import { InvalidArgumentError, mm, pt } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatNativeNumber } from './formatNativeNumber.ts';

const length = (numerator: bigint, denominator: bigint): Length => ({ numerator, denominator });

describe('native number formatting', () => {
  it('rounds numbers and exact lengths with core formatting', () => {
    expect(formatNativeNumber(-0)).toBe('0');
    expect(formatNativeNumber(99_999.99999999999)).toBe('100000');
    expect(formatNativeNumber(1e-12)).toBe('0');
    expect(formatNativeNumber(mm(100))).toBe('283.4645669291');
    expect(formatNativeNumber(pt(0.5))).toBe('0.5');
  });

  it.each([
    ['the largest accepted number', 999_999_999_999_999, '999999999999999'],
    ['the most negative accepted number', -999_999_999_999_999, '-999999999999999'],
    ['a number with a 12-digit integer part', 123_456_789_012.1234, '123456789012.123'],
    ['the largest accepted length', length(10n ** 15n - 1n, 1n), '999999999999999'],
    ['a length with a 12-digit integer part', length(123_456_789_012_123_456n, 1_000_000n), '123456789012.123'],
    ['a negative length', mm(-100), '-283.4645669291'],
  ] as const)('keeps 15 significant digits for %s', (_name, value, expected) => {
    expect(formatNativeNumber(value)).toBe(expected);
  });

  it('rejects non-finite and over-budget values', () => {
    for (const value of [Number.NaN, Infinity, -Infinity, 1e15, 999_999_999_999_999.9]) {
      expect(() => formatNativeNumber(value)).toThrow(InvalidArgumentError);
    }
  });

  it.each([
    ['a zero denominator', length(1n, 0n)],
    ['a negative denominator', length(1n, -1n)],
    ['a 16-digit integer part', length(10n ** 15n, 1n)],
    ['a value that rounds up to 16 digits', length(2n * 10n ** 15n - 1n, 2n)],
  ] as const)('rejects a length with %s', (_name, value) => {
    expect(() => formatNativeNumber(value)).toThrow(InvalidArgumentError);
  });
});

describe('properties', () => {
  // An integer part of 0 to 15 digits plus a fraction, so every digit count the budget allows is reached.
  // Half-even rounding of 999999999999999.5 carries to 16 digits, so it is the first rejected magnitude.
  const accepted = fc
    .tuple(
      fc
        .integer({ min: 0, max: 15 })
        .chain(digits => (digits === 0 ? fc.constant(0n) : fc.bigInt({ min: 10n ** BigInt(digits - 1), max: 10n ** BigInt(digits) - 1n }))),
      fc.integer({ min: 0, max: 2 ** 30 }),
      fc.boolean(),
    )
    .map(([whole, fraction, negative]) => (negative ? -1 : 1) * (Number(whole) + fraction / 2 ** 30))
    .filter(input => Math.abs(input) < 999_999_999_999_999.5);

  it('rounds to the fraction digits the 15-digit budget leaves', () => {
    fc.assert(
      fc.property(accepted, input => {
        const output = formatNativeNumber(input);
        const [integer = '', fraction = ''] = output.replace('-', '').split('.');
        const integerDigits = Math.trunc(Math.abs(input)) === 0 ? 0 : String(Math.trunc(Math.abs(input))).length;
        const fractionDigits = Math.min(10, 15 - integerDigits);
        expect(output).toMatch(/^-?\d+(?:\.\d+)?$/u);
        expect(integer.replace(/^0$/u, '').length + fraction.length).toBeLessThanOrEqual(15);
        expect(fraction.length).toBeLessThanOrEqual(fractionDigits);
        expect(Math.abs(Number(output) - input)).toBeLessThanOrEqual(0.5 * 10 ** -fractionDigits + Number.EPSILON * Math.abs(input));
        expect(formatNativeNumber(Number(output))).toBe(output);
      }),
    );
  });
});

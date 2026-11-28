import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { DEFAULT_FRACTION_DIGITS, formatInteger, formatNumber } from './formatNumber.ts';

describe('number formatting', () => {
  it.each([
    [1.2345678901, 0, '1'],
    [1.2345678901, 1, '1.2'],
    [1.2345678901, 2, '1.23'],
    [1.2345678901, 3, '1.235'],
    [1.2345678901, 4, '1.2346'],
    [1.2345678901, 5, '1.23457'],
    [1.2345678901, 6, '1.234568'],
    [1.2345678901, 7, '1.2345679'],
    [1.2345678901, 8, '1.23456789'],
    [1.2345678901, 9, '1.23456789'],
    [1.2345678901, 10, '1.2345678901'],
    [0, 5, '0'],
    [-0, 5, '0'],
    [0.5, 0, '0'],
    [-0.5, 0, '0'],
    [1.5, 0, '2'],
    [-1.5, 0, '-2'],
    [2.5, 0, '2'],
    [-2.5, 0, '-2'],
    [3.5, 0, '4'],
    [-3.5, 0, '-4'],
    [1.25, 1, '1.2'],
    [1.35, 1, '1.4'],
    [-1.25, 1, '-1.2'],
    [-1.35, 1, '-1.4'],
    [9.999995, 5, '10'],
    [-9.999995, 5, '-10'],
    [0.000005, 5, '0'],
    [0.000015, 5, '0.00002'],
    [-0.000015, 5, '-0.00002'],
    [2.5e-6, 6, '0.000002'],
    [1e-7, 5, '0'],
    [1e-7, 10, '0.0000001'],
    [1.23456789e-5, 10, '0.0000123457'],
    [0.1 + 0.2, 10, '0.3'],
    [Number('123456789.123456789'), 5, '123456789.12346'],
    [Number.MAX_SAFE_INTEGER, 5, '9007199254740991'],
    [Number('9007199254740993'), 5, '9007199254740992'],
    [1e21, 0, '1000000000000000000000'],
    [1e21, 10, '1000000000000000000000'],
    [1.5e21, 0, '1500000000000000000000'],
    [-1e21, 5, '-1000000000000000000000'],
    [3.403e38, 5, '340300000000000000000000000000000000000'],
    [-3.403e38, 5, '-340300000000000000000000000000000000000'],
  ])('formats %s at %i fractional digits as %s', (value, fractionDigits, expected) => {
    expect(formatNumber(value, fractionDigits)).toBe(expected);
  });

  it('rejects invalid values and integer tokens outside the PDF range', () => {
    expect(DEFAULT_FRACTION_DIGITS).toBe(5);
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(() => formatNumber(value, 5)).toThrow(InvalidArgumentError);
    }
    for (const digits of [-1, 11, 0.5, Number.NaN]) {
      expect(() => formatNumber(1, digits)).toThrow(InvalidArgumentError);
    }
    expect(() => formatNumber(3.404e38, 5)).toThrow(InvalidArgumentError);
    expect(() => formatNumber(-3.404e38, 5)).toThrow(InvalidArgumentError);
    expect([formatInteger(0), formatInteger(-0)]).toStrictEqual(['0', '0']);
    expect(formatInteger(2_147_483_647)).toBe('2147483647');
    expect(formatInteger(-2_147_483_647)).toBe('-2147483647');
    for (const value of [2_147_483_648, -2_147_483_648, 1.5, Number.MAX_SAFE_INTEGER, Infinity]) {
      expect(() => formatInteger(value)).toThrow(InvalidArgumentError);
    }
  });
});

describe('properties', () => {
  const value = fc.double({ min: -3.4e38, max: 3.4e38, noNaN: true });
  const fractionDigits = fc.integer({ min: 0, max: 10 });

  // ISO 32000-1:2008, 7.3.3 allows an optional sign, digits and one period, and no exponent.
  it('writes plain decimal syntax with at most the requested fraction digits, no trailing zeros and no negative zero', () => {
    fc.assert(
      fc.property(value, fractionDigits, (number, digits) => {
        const fraction = digits === 0 ? '' : String.raw`(?:\.\d{0,${String(digits - 1)}}[1-9])?`;
        expect(formatNumber(number, digits)).toMatch(new RegExp(String.raw`^(?!-0$)-?(?:0|[1-9]\d*)${fraction}$`, 'u'));
      }),
    );
  });

  // A number with at most the requested fraction digits needs no rounding, so JavaScript's own shortest decimal string is an independent expected value.
  it("agrees with JavaScript's decimal string wherever no rounding is needed", () => {
    const exact = fc
      .tuple(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), fractionDigits)
      .chain(([integer, digits]) => fc.tuple(fc.constant(integer), fc.integer({ min: 0, max: digits }), fc.constant(digits)))
      .map(([integer, scale, digits]) => [integer / 10 ** scale, digits] as const)
      .filter(([number]) => !String(number).includes('e'));
    fc.assert(
      fc.property(exact, ([number, digits]) => {
        expect(formatNumber(number, digits)).toBe(Object.is(number, -0) ? '0' : String(number));
      }),
    );
  });
});

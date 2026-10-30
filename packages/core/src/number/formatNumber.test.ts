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
    [-1e21, 5, '-1000000000000000000000'],
    [3.403e38, 5, '340300000000000000000000000000000000000'],
  ])('formats %s at %i fractional digits as %s', (value, fractionDigits, expected) => {
    expect(formatNumber(value, fractionDigits)).toBe(expected);
  });

  it('rejects invalid values and integer tokens outside the PDF range', () => {
    expect(DEFAULT_FRACTION_DIGITS).toBe(5);
    for (const value of [Number.NaN, Infinity, -Infinity]) expect(() => formatNumber(value, 5)).toThrow(InvalidArgumentError);
    for (const digits of [-1, 11, 0.5, Number.NaN]) expect(() => formatNumber(1, digits)).toThrow(InvalidArgumentError);
    expect(() => formatNumber(3.404e38, 5)).toThrow(InvalidArgumentError);
    expect(formatInteger(2147483647)).toBe('2147483647');
    expect(formatInteger(-2147483647)).toBe('-2147483647');
    for (const value of [2147483648, -2147483648, 1.5, Number.MAX_SAFE_INTEGER, Infinity]) {
      expect(() => formatInteger(value)).toThrow(InvalidArgumentError);
    }
  });
});

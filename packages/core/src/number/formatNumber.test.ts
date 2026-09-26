import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { DEFAULT_FRACTION_DIGITS, formatInteger, formatNumber } from './formatNumber.ts';

const oracle = (value: number, fractionDigits: number): string => {
  const decimal = String(Math.abs(value));
  const [mantissa = '', rawExponent = '0'] = decimal.toLowerCase().split('e');
  const [integer = '', fraction = ''] = mantissa.split('.');
  const exponent = Number(rawExponent) - fraction.length;
  const coefficient = BigInt(integer + fraction);
  const numerator = exponent >= 0 ? coefficient * 10n ** BigInt(exponent) : coefficient;
  const denominator = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
  const scaled = numerator * 10n ** BigInt(fractionDigits);
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const rounded = quotient + (2n * remainder > denominator || (2n * remainder === denominator && quotient % 2n === 1n) ? 1n : 0n);
  if (rounded > 3403n * 10n ** BigInt(35 + fractionDigits)) throw new InvalidArgumentError('real out of range');
  if (rounded === 0n) return '0';
  const digits = rounded.toString().padStart(fractionDigits + 1, '0');
  const whole = digits.slice(0, digits.length - fractionDigits);
  const rest = digits.slice(digits.length - fractionDigits).replace(/0+$/u, '');
  return `${value < 0 ? '-' : ''}${whole}${rest.length > 0 ? `.${rest}` : ''}`;
};

const xor = (left: number, right: number): number => {
  let result = 0;
  let place = 1;
  for (let index = 0; index < 32; index++) {
    if (Math.floor(left / place) % 2 !== Math.floor(right / place) % 2) result += place;
    place *= 2;
  }
  return result;
};

const randomValues = function* (): Generator<number> {
  let state = 0x12345678;
  for (let index = 0; index < 100_000; index++) {
    state = xor(state, (state * 8192) % 4294967296);
    state = xor(state, Math.floor(state / 131072));
    state = xor(state, (state * 32) % 4294967296);
    const exponent = -9 + (state % 22);
    yield (index % 2 === 0 ? 1 : -1) * (state / 4294967296) * 10 ** exponent;
  }
};

describe('number formatting', () => {
  it('rounds edge values like an exact rational oracle at every supported precision', () => {
    const values = [
      0,
      -0,
      1e-7,
      2.5e-6,
      0.000005,
      0.000015,
      0.1 + 0.2,
      1e21,
      Number('123456789.123456789'),
      Number.MAX_SAFE_INTEGER,
      Number('9007199254740993'),
      -1.5,
      2.5,
      0.5,
      1.23456789e-5,
      3.403e38,
    ];
    for (const value of values) {
      for (let digits = 0; digits <= 10; digits++) {
        const output = formatNumber(value, digits);
        expect(output).toBe(oracle(value, digits));
        expect(output).not.toMatch(/[eE]/u);
      }
    }
  });

  it('matches the rational oracle for 100,000 fixed-seed values', () => {
    let index = 0;
    for (const value of randomValues()) {
      const digits = index % 11;
      const output = formatNumber(value, digits);
      expect(output).toBe(oracle(value, digits));
      expect(output).not.toMatch(/[eE]/u);
      index++;
    }
    expect(index).toBe(100_000);
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

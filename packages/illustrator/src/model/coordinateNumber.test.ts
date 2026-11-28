import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { coordinateNumber } from './coordinateNumber.ts';

const digits = (value: bigint): number => String(value < 0n ? -value : value).length;

// An oracle that shares nothing with the implementation: 25 significant decimal digits of the quotient by bigint division, read back by the correctly rounding decimal parser.
const decimalQuotient = (numerator: bigint, denominator: bigint): number => {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const exponent = 25 - (digits(magnitude) - digits(denominator));
  const scaled = exponent >= 0 ? (magnitude * 10n ** BigInt(exponent)) / denominator : magnitude / (denominator * 10n ** BigInt(-exponent));
  return Number.parseFloat(`${numerator < 0n ? '-' : ''}${String(scaled)}e${String(-exponent)}`);
};

const term = (minDigits: number, maxDigits: number): fc.Arbitrary<bigint> =>
  fc.integer({ min: minDigits, max: maxDigits }).chain(count => fc.bigInt({ min: 10n ** BigInt(count - 1), max: 10n ** BigInt(count) - 1n }));
// Terms of 1 to 400 digits put either, both or neither beyond Number range, and their quotients run from 0 through subnormals to beyond the largest number.
const pair: fc.Arbitrary<readonly [bigint, bigint]> = fc
  .tuple(term(1, 400), term(1, 400), fc.boolean())
  .map(([numerator, denominator, negative]) => [negative ? -numerator : numerator, denominator] as const);

describe('coordinate numbers', () => {
  it('returns a number coordinate unchanged', () => {
    expect(coordinateNumber(-2.5)).toBe(-2.5);
  });

  it.each([
    { case: 'a third', numerator: 1n, denominator: 3n, expected: 1 / 3 },
    { case: 'ten, both terms beyond Number range', numerator: 10n ** 401n, denominator: 10n ** 400n, expected: 10 },
    { case: 'minus ten, both terms beyond Number range', numerator: -(10n ** 401n), denominator: 10n ** 400n, expected: -10 },
    { case: 'a third, both terms beyond Number range', numerator: 10n ** 400n, denominator: 3n * 10n ** 400n, expected: 1 / 3 },
    // 10^308 is within Number range and 10^309 is not, so each of these has exactly one term beyond it.
    { case: 'ten, only the numerator beyond Number range', numerator: 10n ** 309n, denominator: 10n ** 308n, expected: 10 },
    { case: 'a tenth, only the denominator beyond Number range', numerator: 10n ** 308n, denominator: 10n ** 309n, expected: 0.1 },
    { case: 'a hundred, only the numerator beyond Number range', numerator: 10n ** 310n, denominator: 10n ** 308n, expected: 100 },
    { case: 'a hundredth, only the denominator beyond Number range', numerator: 10n ** 308n, denominator: 10n ** 310n, expected: 0.01 },
    // Scaling both terms down by the same power of ten would leave nothing of a small other term.
    { case: 'a quotient near the largest number over a one-digit denominator', numerator: 10n ** 309n, denominator: 8n, expected: 1.25e308 },
    { case: 'a subnormal quotient of a one-digit numerator', numerator: 1n, denominator: 10n ** 309n, expected: 1e-309 },
  ])('converts $case', ({ numerator, denominator, expected }) => {
    expect(Math.abs(coordinateNumber({ numerator, denominator }) - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-15);
  });

  // Each quotient sits at or just past the midpoint between two neighbouring numbers, where truncating the quotient or rounding ties away from zero gives the other neighbour.
  const large = 10n ** 310n;
  it.each([
    { case: 'just above the midpoint after 1 up', numerator: (2n ** 53n + 1n) * large + 1n, denominator: 2n ** 53n * large, expected: 1 + 2 ** -52 },
    { case: 'exactly at the midpoint after 1 to the even 1', numerator: (2n ** 53n + 1n) * large, denominator: 2n ** 53n * large, expected: 1 },
    { case: 'just above the midpoint after 2^-1073 up', numerator: 5n * large + 1n, denominator: 2n ** 1075n * large, expected: 3 * 2 ** -1074 },
    { case: 'exactly at the midpoint after 2^-1073 to the even 2^-1073', numerator: 5n, denominator: 2n ** 1075n, expected: 2 ** -1073 },
  ])('rounds a quotient $case', ({ numerator, denominator, expected }) => {
    expect(coordinateNumber({ numerator, denominator })).toBe(expected);
  });

  describe('properties', () => {
    it('agrees with the decimal quotient to within 1e-15', () => {
      fc.assert(
        fc.property(pair, ([numerator, denominator]) => {
          const expected = decimalQuotient(numerator, denominator);
          const actual = coordinateNumber({ numerator, denominator });
          // An infinite quotient must be met exactly, since Infinity − Infinity is NaN and any finite error is within Infinity × 1e-15.
          const error = Object.is(actual, expected) ? 0 : Math.abs(actual - expected);
          expect(error).toBeLessThanOrEqual(Number.isFinite(expected) ? Math.abs(expected) * 1e-15 : 0);
        }),
      );
    });
  });
});

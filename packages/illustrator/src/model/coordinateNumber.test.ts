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
// Both terms within Number range, or both beyond it; a quotient with exactly one term beyond Number range is outside this property.
const pair = (minDigits: number, maxDigits: number): fc.Arbitrary<readonly [bigint, bigint]> =>
  fc
    .tuple(term(minDigits, maxDigits), term(minDigits, maxDigits), fc.boolean())
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
    { case: 'a quotient near the largest number over a one-digit denominator', numerator: 10n ** 309n, denominator: 7n, expected: 1.4285714285714286e308 },
    { case: 'a subnormal quotient of a one-digit numerator', numerator: 1n, denominator: 10n ** 309n, expected: 1e-309 },
  ])('converts $case', ({ numerator, denominator, expected }) => {
    expect(Math.abs(coordinateNumber({ numerator, denominator }) - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-15);
  });

  describe('properties', () => {
    it('agrees with the decimal quotient to within 1e-15', () => {
      fc.assert(
        fc.property(fc.oneof(pair(1, 300), pair(310, 400)), ([numerator, denominator]) => {
          const expected = decimalQuotient(numerator, denominator);
          expect(Math.abs(coordinateNumber({ numerator, denominator }) - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-15);
        }),
      );
    });
  });
});

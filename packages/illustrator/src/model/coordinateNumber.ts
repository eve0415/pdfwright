import type { Coordinate } from './illustratorDocument.ts';

const bitLength = (value: bigint): number => value.toString(2).length;

// The quotient floor(dividend / (divisor × 2^exponent)) and the remainder over the divisor it was taken against.
interface Division {
  readonly quotient: bigint;
  readonly remainder: bigint;
  readonly divisor: bigint;
}

const divide = (dividend: bigint, divisor: bigint, exponent: number): Division => {
  const scaledDividend = exponent < 0 ? dividend * 2n ** BigInt(-exponent) : dividend;
  const scaledDivisor = exponent > 0 ? divisor * 2n ** BigInt(exponent) : divisor;
  return { quotient: scaledDividend / scaledDivisor, remainder: scaledDividend % scaledDivisor, divisor: scaledDivisor };
};

// 2^-1074 is the smallest subnormal and the spacing of every double below 2^-1021.
const SUBNORMAL_EXPONENT = -1074;
const NORMAL_EXPONENT = -1022;

/** Converts an exact length to the nearest number, dividing the bigint terms themselves when either is beyond Number range. */
export const coordinateNumber = (value: Coordinate): number => {
  if (typeof value === 'number') {
    return value;
  }
  const numerator = Number(value.numerator);
  const denominator = Number(value.denominator);
  if ((Number.isFinite(numerator) && Number.isFinite(denominator)) || value.numerator === 0n || value.denominator === 0n) {
    return numerator / denominator;
  }
  const negative = value.numerator < 0n !== value.denominator < 0n;
  const dividend = value.numerator < 0n ? -value.numerator : value.numerator;
  const divisor = value.denominator < 0n ? -value.denominator : value.denominator;
  // The quotient lies in [2^(d − 1), 2^(d + 1)) for the bit-length difference d, so this scale leaves an integer quotient of at least 66 bits.
  const scale = bitLength(dividend) - bitLength(divisor) - 66;
  const wide = divide(dividend, divisor, scale);
  let magnitude: number;
  if (bitLength(wide.quotient) - 1 + scale >= NORMAL_EXPONENT) {
    // A sticky bit for a nonzero remainder lets Number() round the 67-bit integer to nearest as the exact quotient would, and scaling by a power of two in two halves is then exact.
    const sticky = wide.quotient * 2n + (wide.remainder === 0n ? 0n : 1n);
    const exponent = scale - 1;
    const half = Math.trunc(exponent / 2);
    magnitude = Number(sticky) * 2 ** half * 2 ** (exponent - half);
  } else {
    // Below 2^-1022 every double is a multiple of 2^-1074, so round the quotient in those units to nearest, ties to even.
    const units = divide(dividend, divisor, SUBNORMAL_EXPONENT);
    const twice = units.remainder * 2n;
    const roundUp = twice > units.divisor || (twice === units.divisor && units.quotient % 2n === 1n);
    magnitude = Number(units.quotient + (roundUp ? 1n : 0n)) * 2 ** SUBNORMAL_EXPONENT;
  }
  return negative ? -magnitude : magnitude;
};

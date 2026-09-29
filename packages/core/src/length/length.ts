import { decimalRational, formatRational } from '../number/decimal.ts';

/** An exact rational distance in PDF points, with numerator and positive denominator; `pt`, `inch`, and `mm` construct it without rounding, and ISO 32000-1:2008, 8.3.2.3 defines 72 points per inch. */
export interface Length {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

const makeLength = (numerator: bigint, denominator: bigint): Length => {
  if (numerator === 0n) return Object.freeze({ numerator: 0n, denominator: 1n });
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
};

/** Makes an exact rational length from a decimal point value. */
export const pt = (value: number): Length => {
  const rational = decimalRational(value);
  return makeLength(rational.numerator, rational.denominator);
};

// ISO 32000-1:2008, 8.3.2.3 specifies a default user-space unit of 1/72 inch.
/** Makes an exact rational length from a decimal inch value. */
export const inch = (value: number): Length => {
  const rational = decimalRational(value);
  return makeLength(rational.numerator * 72n, rational.denominator);
};

/** Makes an exact rational length from a decimal millimetre value. */
export const mm = (value: number): Length => {
  const rational = decimalRational(value);
  return makeLength(rational.numerator * 360n, rational.denominator * 127n);
};

/** Adds two exact rational lengths. */
export const add = (left: Length, right: Length): Length =>
  makeLength(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);

/** Subtracts the right length from the left. */
export const subtract = (left: Length, right: Length): Length =>
  makeLength(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator);

/** Scales an exact rational length by a decimal factor. */
export const multiply = (length: Length, factor: number): Length => {
  const rational = decimalRational(factor);
  return makeLength(length.numerator * rational.numerator, length.denominator * rational.denominator);
};

/** Changes the sign of an exact rational length. */
export const negate = (length: Length): Length => makeLength(-length.numerator, length.denominator);

/** Compares two exact rational lengths without rounding. */
export const compare = (left: Length, right: Length): -1 | 0 | 1 => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  if (difference < 0n) return -1;
  if (difference > 0n) return 1;
  return 0;
};

/** Tests whether two exact rational lengths are equal. */
export const equals = (left: Length, right: Length): boolean => compare(left, right) === 0;

/** Formats a length in PDF points with the given decimal precision. */
export const formatLength = (length: Length, fractionDigits: number): string => formatRational(length, fractionDigits);

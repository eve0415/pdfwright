import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export const decimalRational = (value: number): Rational => {
  if (!Number.isFinite(value)) throw new InvalidArgumentError('number must be finite');
  const decimal = String(value);
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [mantissa = '', rawExponent = '0'] = unsigned.toLowerCase().split('e');
  const [integer = '', fraction = ''] = mantissa.split('.');
  const exponent = Number(rawExponent) - fraction.length;
  const coefficient = BigInt(integer + fraction);
  const numerator = exponent >= 0 ? coefficient * 10n ** BigInt(exponent) : coefficient;
  const denominator = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
  return { numerator: negative ? -numerator : numerator, denominator };
};

export const formatRational = (value: Rational, fractionDigits: number): string => {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 10) {
    throw new InvalidArgumentError('fractionDigits must be an integer from 0 to 10');
  }
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const scaled = numerator * 10n ** BigInt(fractionDigits);
  const quotient = scaled / value.denominator;
  const remainder = scaled % value.denominator;
  const rounded = quotient + (2n * remainder > value.denominator || (2n * remainder === value.denominator && quotient % 2n === 1n) ? 1n : 0n);
  // ISO 32000-1:2008, Annex C, Table C.1 recommends a maximum real magnitude of 3.403 × 10^38.
  if (rounded > 3403n * 10n ** BigInt(35 + fractionDigits)) throw new InvalidArgumentError('real out of range');
  if (rounded === 0n) return '0';
  const digits = rounded.toString().padStart(fractionDigits + 1, '0');
  const whole = digits.slice(0, digits.length - fractionDigits);
  const rest = digits.slice(digits.length - fractionDigits).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${rest.length > 0 ? `.${rest}` : ''}`;
};

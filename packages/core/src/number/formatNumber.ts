import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { decimalRational, formatRational } from './decimal.ts';

// ISO 32000-1:2008, Annex C, Table C.1 gives about five fractional decimal digits of precision.
export const DEFAULT_FRACTION_DIGITS = 5;

// ISO 32000-1:2008, 7.3.3 prohibits exponential syntax in numeric objects.
export const formatNumber = (value: number, fractionDigits: number): string => formatRational(decimalRational(value), fractionDigits);

export const formatInteger = (value: number): string => {
  // ISO 32000-1:2008, Annex C, Table C.1 gives the integer range; this writer uses the symmetric bound.
  if (!Number.isSafeInteger(value) || Math.abs(value) > 2147483647) throw new InvalidArgumentError('integer out of range');
  return Object.is(value, -0) ? '0' : String(value);
};

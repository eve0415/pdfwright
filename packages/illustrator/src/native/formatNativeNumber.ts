import type { Length } from '@pdfwright/core';

import { InvalidArgumentError, formatLength, formatNumber } from '@pdfwright/core';

const integerDigits = (value: number | Length): number => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) >= 1e15) throw new InvalidArgumentError('native number exceeds the 15-digit budget');
    const whole = Math.floor(Math.abs(value));
    return whole === 0 ? 0 : String(whole).length;
  }
  if (value.denominator <= 0n) throw new InvalidArgumentError('length denominator must be positive');
  const absolute = value.numerator < 0n ? -value.numerator : value.numerator;
  const whole = absolute / value.denominator;
  if (whole >= 1_000_000_000_000_000n) throw new InvalidArgumentError('native number exceeds the 15-digit budget');
  return whole === 0n ? 0 : String(whole).length;
};

/** Formats a native number without exponent form, using at most 15 significant and 10 fractional digits. */
export const formatNativeNumber = (value: number | Length): string => {
  const digits = Math.min(10, 15 - integerDigits(value));
  const token = typeof value === 'number' ? formatNumber(value, digits) : formatLength(value, digits);
  const [whole = '', fraction = ''] = token.replace('-', '').split('.');
  if (whole.replace(/^0$/u, '').length + fraction.length > 15) throw new InvalidArgumentError('native number exceeds the 15-digit budget');
  return token;
};

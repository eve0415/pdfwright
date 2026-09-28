import type { Coordinate } from './illustratorDocument.ts';

/** Converts an exact length without overflowing either bigint term first. */
export const coordinateNumber = (value: Coordinate): number => {
  if (typeof value === 'number') return value;
  const numerator = Number(value.numerator);
  const denominator = Number(value.denominator);
  if (Number.isFinite(numerator) || Number.isFinite(denominator)) return numerator / denominator;
  const numeratorDigits = String(value.numerator < 0n ? -value.numerator : value.numerator).length;
  const denominatorDigits = String(value.denominator).length;
  const shift = BigInt(Math.max(numeratorDigits, denominatorDigits) - 300);
  const scale = 10n ** shift;
  return Number(value.numerator / scale) / Number(value.denominator / scale);
};

import type { IllustratorDocument } from '../model/illustratorDocument.ts';

const numbersOf = (value: unknown): number[] => {
  if (typeof value === 'number') return [value];
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return [];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => numbersOf(item));
  return Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([, entry]: [string, unknown]) => numbersOf(entry));
};

/** The largest difference between corresponding numbers of two models with the same shape, or infinity when their shapes hold different counts of numbers. */
export const numberDeviation = (actual: IllustratorDocument, expected: IllustratorDocument): number => {
  const left = numbersOf(actual);
  const right = numbersOf(expected);
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let largest = 0;
  for (const [index, value] of left.entries()) largest = Math.max(largest, Math.abs(value - (right[index] ?? Number.NaN)));
  return largest;
};

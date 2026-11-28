/** The largest componentwise difference between two vectors, or Infinity when their lengths differ or a component is NaN, so a truncated or NaN result cannot pass a tolerance. */
export const largestDifference = (actual: ArrayLike<number>, expected: ArrayLike<number>): number => {
  if (actual.length !== expected.length) {
    return Infinity;
  }
  let largest = 0;
  for (let index = 0; index < expected.length; index++) {
    const difference = Math.abs((actual[index] ?? Number.NaN) - (expected[index] ?? Number.NaN));
    if (Number.isNaN(difference)) {
      return Infinity;
    }
    largest = Math.max(largest, difference);
  }
  return largest;
};

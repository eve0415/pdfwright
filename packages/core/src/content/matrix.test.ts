import type { Matrix } from './matrix.ts';

import { describe, expect, it } from 'vitest';

import { IDENTITY, invert, multiply, transformPoint } from './matrix.ts';

// ISO 32000-1:2008, 8.3.3: translations are [1 0 0 1 tx ty] and scalings [sx 0 0 sy 0 0].
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];

// Rounds away the last bits of double arithmetic, and -0 to 0.
const rounded = (matrix: Matrix): readonly number[] => matrix.map(value => Math.round(value * 1e12) / 1e12 + 0);

// The products of a matrix and its inverse on both sides, or undefined when it has none.
const products = (matrix: Matrix): readonly (readonly number[])[] | undefined => {
  const inverse = invert(matrix);
  return inverse === undefined ? undefined : [rounded(multiply(matrix, inverse)), rounded(multiply(inverse, matrix))];
};

describe('affine matrices', () => {
  it('transforms a point as x′ = a·x + c·y + e and y′ = b·x + d·y + f', () => {
    expect(transformPoint([2, 3, 5, 7, 11, 13], 1, 10)).toStrictEqual([63, 86]);
  });

  it('applies the left matrix first', () => {
    const scaledThenMoved = multiply(scale(2, 3), translate(10, 20));
    const movedThenScaled = multiply(translate(10, 20), scale(2, 3));
    expect([transformPoint(scaledThenMoved, 1, 1), transformPoint(movedThenScaled, 1, 1)]).toStrictEqual([
      [12, 23],
      [22, 63],
    ]);
  });

  it('keeps a matrix unchanged when multiplied by the identity on either side', () => {
    const matrix: Matrix = [0, 3.125, -3.125, 0, 40, 16];
    expect([multiply(IDENTITY, matrix), multiply(matrix, IDENTITY)]).toStrictEqual([matrix, matrix]);
  });

  it('inverts a matrix so that the product is the identity', () => {
    const matrix: Matrix = [2, 1, -1, 3, 5, -7];
    expect(products(matrix)).toStrictEqual([[...IDENTITY], [...IDENTITY]]);
  });

  it('has no inverse for a singular matrix', () => {
    expect([invert([1, 2, 2, 4, 0, 0]), invert([0, 0, 0, 0, 1, 1]), invert([1e-320, 0, 0, 1e-320, 0, 0])]).toStrictEqual([undefined, undefined, undefined]);
  });
});

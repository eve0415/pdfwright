import type { Matrix } from './matrix.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { IDENTITY, multiply, transformPoint } from './matrix.ts';

// ISO 32000-1:2008, 8.3.3: translations are [1 0 0 1 tx ty] and scalings [sx 0 0 sy 0 0].
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];

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

  it('multiplies matrices with every entry set as the 3×3 product', () => {
    // ISO 32000-1:2008, 8.3.4: [a b 0; c d 0; e f 1] × [a′ b′ 0; c′ d′ 0; e′ f′ 1], whose cross terms b·c′ and c·b′ vanish for scalings and translations.
    expect(multiply([1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12])).toStrictEqual([25, 28, 57, 64, 100, 112]);
  });

  it('keeps a matrix unchanged when multiplied by the identity on either side', () => {
    const matrix: Matrix = [0, 3.125, -3.125, 0, 40, 16];
    expect([multiply(IDENTITY, matrix), multiply(matrix, IDENTITY)]).toStrictEqual([matrix, matrix]);
  });
});

// Integer entries small enough that every product and sum is exact in double arithmetic, so equality needs no tolerance.
const entry = fc.integer({ min: -1000, max: 1000 });
const matrices = fc.tuple(entry, entry, entry, entry, entry, entry);

describe('properties', () => {
  it('transforms a point by a product as by its left factor and then its right one', () => {
    fc.assert(
      fc.property(matrices, matrices, fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }), (left, right, x, y) => {
        const [x1, y1] = transformPoint(left, x, y);
        expect(transformPoint(multiply(left, right), x, y)).toStrictEqual(transformPoint(right, x1, y1));
      }),
    );
  });

  it('multiplies associatively', () => {
    fc.assert(
      fc.property(matrices, matrices, matrices, (a, b, c) => {
        expect(multiply(multiply(a, b), c)).toStrictEqual(multiply(a, multiply(b, c)));
      }),
    );
  });
});

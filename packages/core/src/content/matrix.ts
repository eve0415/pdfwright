/** A transformation matrix [a b c d e f], standing for the 3×3 matrix with rows (a b 0), (c d 0) and (e f 1) (ISO 32000-1:2008, 8.3.4). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY = [1, 0, 0, 1, 0, 0] as const satisfies Matrix;

/**
 * The product left × right: the transformation `left` followed by `right`.
 * ISO 32000-1:2008, 8.3.4: "when a new transformation is concatenated with an existing one, the matrix representing it shall be multiplied before (premultiplied with) the existing transformation matrix", so `cm` sets the CTM to multiply(operand, ctm).
 */
export const multiply = (left: Matrix, right: Matrix): Matrix => {
  const [a, b, c, d, e, f] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [a * a2 + b * c2, a * b2 + b * d2, c * a2 + d * c2, c * b2 + d * d2, e * a2 + f * c2 + e2, e * b2 + f * d2 + f2];
};

/** The inverse, or undefined when the matrix is singular or its inverse is not finite. */
export const invert = (matrix: Matrix): Matrix | undefined => {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  const inverse: Matrix = [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
  return determinant !== 0 && inverse.every(value => Number.isFinite(value)) ? inverse : undefined;
};

/** ISO 32000-1:2008, 8.3.4: "x′ = a × x + c × y + e" and "y′ = b × x + d × y + f". */
export const transformPoint = (matrix: Matrix, x: number, y: number): readonly [number, number] => {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
};

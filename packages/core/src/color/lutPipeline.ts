import type { LutTag } from '../icc/iccProfile.ts';
import type { Curve, Matrix3 } from '../icc/iccTags.ts';

import { evaluateClut } from './clut.ts';
import { evaluateCurve } from './curve.ts';

const clip = (value: number): number => Math.min(1, Math.max(0, value));

export const applyMatrix = (values: readonly number[] | Float64Array, matrix: Matrix3, offset: readonly number[] = [0, 0, 0]): number[] => [
  matrix[0] * (values[0] ?? 0) + matrix[1] * (values[1] ?? 0) + matrix[2] * (values[2] ?? 0) + (offset[0] ?? 0),
  matrix[3] * (values[0] ?? 0) + matrix[4] * (values[1] ?? 0) + matrix[5] * (values[2] ?? 0) + (offset[1] ?? 0),
  matrix[6] * (values[0] ?? 0) + matrix[7] * (values[1] ?? 0) + matrix[8] * (values[2] ?? 0) + (offset[2] ?? 0),
];

const curves = (values: readonly number[] | Float64Array, stages: readonly Curve[] | undefined): number[] =>
  stages === undefined ? [...values] : stages.map((curve, index) => evaluateCurve(curve, values[index] ?? 0));

export const evaluateLut = (tag: LutTag, input: readonly number[] | Float64Array, mode: 'trilinear' | 'tetrahedral'): number[] => {
  if ('input' in tag) {
    // ICC.1:2022, 10.10 and 10.11: matrix → input tables → CLUT → output tables.
    const matrixInput = input.length === 3 ? applyMatrix(input, tag.matrix) : [...input];
    return curves(evaluateClut(tag.clut, curves(matrixInput, tag.input), mode), tag.output);
  }
  if (tag.kind === 'lutAtoB') {
    // ICC.1:2022, 10.12.1: A → CLUT → M → matrix → B.
    let values = curves(input, tag.a);
    if (tag.clut !== undefined) values = evaluateClut(tag.clut, values, mode);
    values = curves(values, tag.m);
    if (tag.matrix !== undefined) values = applyMatrix(values, tag.matrix.m, tag.matrix.offset).map(value => clip(value));
    return curves(values, tag.b);
  }
  // ICC.1:2022, 10.13.1: B → matrix → M → CLUT → A.
  let values = curves(input, tag.b);
  if (tag.matrix !== undefined) values = applyMatrix(values, tag.matrix.m, tag.matrix.offset).map(value => clip(value));
  values = curves(values, tag.m);
  if (tag.clut !== undefined) values = evaluateClut(tag.clut, values, mode);
  return curves(values, tag.a);
};

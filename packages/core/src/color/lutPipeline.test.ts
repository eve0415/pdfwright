import type { MultiLut } from '../icc/iccMultiLut.ts';
import type { Curve, Matrix3 } from '../icc/iccTags.ts';

import { describe, expect, it } from 'vitest';

import { evaluateLut } from './lutPipeline.ts';
import { IDENTITY_CURVE, lut8 } from './testing/iccProfiles.ts';
import { largestDifference } from './testing/largestDifference.ts';

const three = (curve: Curve): Array<Curve> => [curve, curve, curve];
const square: Curve = { kind: 'gamma', gamma: 2 };
const root: Curve = { kind: 'gamma', gamma: 0.5 };

// An affine CLUT whose every output is (64 + 128 · input) / 255, so it commutes with no curve stage around it.
const affineClut = lut8(3, 3, bits => bits.map(bit => 64 + 128 * bit)).clut;
const clutValue = (value: number): number => (64 + 128 * value) / 255;

// ICC.1:2022, 10.12 and 10.13: the matrix holds e1–e9 by rows, then the offsets e10–e12.
const MATRIX = [0.5, 0.1, 0, 0, 0.5, 0.1, 0.1, 0, 0.5] as const;
const OFFSET = [0.05, 0, 0] as const;
const clip = (value: number): number => Math.min(1, Math.max(0, value));
const matrixStage = (values: ReadonlyArray<number>, matrix: Matrix3, offset: ReadonlyArray<number> = [0, 0, 0]): Array<number> =>
  [0, 1, 2].map(
    row =>
      (matrix[row * 3] ?? 0) * (values[0] ?? 0) +
      (matrix[row * 3 + 1] ?? 0) * (values[1] ?? 0) +
      (matrix[row * 3 + 2] ?? 0) * (values[2] ?? 0) +
      (offset[row] ?? 0),
  );

const input = [0.2, 0.6, 0.9] as const;

describe('multi-process LUT stages', () => {
  it('runs a lutAtoB as A curves, CLUT, M curves, clipped matrix and B curves', () => {
    // ICC.1:2022, 10.12.1.
    const tag: MultiLut = { kind: 'lutAtoB', a: three(square), clut: affineClut, m: three(root), matrix: { m: MATRIX, offset: OFFSET }, b: three(square) };
    const expected = matrixStage(
      input.map(value => Math.sqrt(clutValue(value * value))),
      MATRIX,
      OFFSET,
    ).map(value => clip(value) ** 2);
    expect(largestDifference(evaluateLut(tag, input, 'tetrahedral'), expected)).toBeLessThan(1e-12);
  });

  it('runs a lutBtoA as B curves, clipped matrix, M curves, CLUT and A curves', () => {
    // ICC.1:2022, 10.13.1.
    const tag: MultiLut = { kind: 'lutBtoA', b: three(square), matrix: { m: MATRIX, offset: OFFSET }, m: three(root), clut: affineClut, a: three(square) };
    const expected = matrixStage(
      input.map(value => value * value),
      MATRIX,
      OFFSET,
    ).map(value => clutValue(Math.sqrt(clip(value))) ** 2);
    expect(largestDifference(evaluateLut(tag, input, 'tetrahedral'), expected)).toBeLessThan(1e-12);
  });

  it.each(['lutAtoB', 'lutBtoA'] as const)('clips the %s matrix output to [0, 1] before identity M curves', kind => {
    const tag: MultiLut = { kind, matrix: { m: [1.2, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, -0.1, 0] }, m: three(IDENTITY_CURVE), b: three(IDENTITY_CURVE) };
    expect(evaluateLut(tag, [1, 0, 0.5], 'tetrahedral')).toStrictEqual([1, 0, 0.5]);
  });

  it('runs a lutAtoB without CLUT or matrix as A curves, M curves and B curves', () => {
    const ramp: Curve = { kind: 'table', values: Uint16Array.of(16_384, 65_535) };
    const tag: MultiLut = { kind: 'lutAtoB', a: three(square), m: three(ramp), b: three(square) };
    const low = 16_384 / 65_535;
    const expected = input.map(value => (low + (1 - low) * value * value) ** 2);
    expect(largestDifference(evaluateLut(tag, input, 'tetrahedral'), expected)).toBeLessThan(1e-12);
  });
});

// ICC.1:2022, 10.10 and 10.11: matrix, input tables, CLUT, output tables, where only a three-input table has a matrix.
describe('lut8 and lut16 stages', () => {
  const tableMatrix = [0.5, 0.2, 0.1, 0.1, 0.6, 0.2, 0, 0.3, 0.4] as const;

  it.each(['lut8', 'lut16'] as const)('applies a three-input %s matrix before squaring input tables', kind => {
    const tag = { ...lut8(3, 3, bits => bits.map(bit => 255 * bit)), kind, matrix: tableMatrix, input: three(square) };
    const expected = matrixStage(input, tableMatrix).map(value => value * value);
    expect(largestDifference(evaluateLut(tag, input, 'tetrahedral'), expected)).toBeLessThan(1e-12);
  });

  it('skips the matrix of a four-input table', () => {
    const tag = { ...lut8(4, 1, ([first = 0]) => [255 * first]), kind: 'lut16' as const, matrix: tableMatrix };
    expect(evaluateLut(tag, [0.3, 0.6, 0.9, 0.1], 'tetrahedral')).toStrictEqual([0.3]);
  });
});

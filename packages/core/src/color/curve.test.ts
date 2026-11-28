import type { Curve } from '../icc/iccTags.ts';

import { describe, expect, it } from 'vitest';

import { evaluateCurve, invertCurve } from './curve.ts';

const table = (samples: ReadonlyArray<number>): Curve => ({ kind: 'table', values: Uint16Array.from(samples) });

describe('icc curve domains', () => {
  it('clips gamma and parametric inputs before exponentiation', () => {
    expect(evaluateCurve({ kind: 'gamma', gamma: 1.8 }, -0.1)).toBe(0);
    expect(evaluateCurve({ kind: 'gamma', gamma: 1.8 }, 1.1)).toBe(1);
    expect(evaluateCurve({ kind: 'parametric', functionType: 0, params: [1.8] }, -0.1)).toBe(0);
    expect(invertCurve({ kind: 'gamma', gamma: 1.8 }, -0.1)).toBe(0);
  });
});

// Expected inverses follow ICC.1:2022, Annex F.1: a flat stretch inverts to its highest x unless it ends at the end of the domain, where it inverts to its lowest x, and a value outside the curve's range inverts as the nearest value in it.
describe('icc curve inversion', () => {
  it('inverts an interior flat stretch to its highest input', () => {
    expect(invertCurve(table([0, 32_768, 32_768, 65_535]), 32_768 / 65_535)).toBeCloseTo(2 / 3, 9);
    expect(invertCurve(table([0, 0, 65_535]), 0)).toBeCloseTo(0.5, 9);
  });

  it('inverts a flat stretch that ends the domain to its lowest input', () => {
    expect(invertCurve(table([0, 32_768, 65_535, 65_535]), 1)).toBeCloseTo(2 / 3, 9);
  });

  it('inverts a value outside the curve range as the nearest value in it', () => {
    expect(invertCurve(table([16_384, 65_535]), 0)).toBeCloseTo(0, 9);
    expect(invertCurve(table([0, 32_768]), 1)).toBeCloseTo(1, 9);
    expect(invertCurve(table([0, 0, 32_768]), -1)).toBeCloseTo(0.5, 9);
  });

  it('inverts decreasing table curves', () => {
    expect(invertCurve(table([65_535, 0]), 0.25)).toBeCloseTo(0.75, 9);
    expect(invertCurve(table([65_535, 40_000, 12_000, 0]), 20_000 / 65_535)).toBeCloseTo((1 + 20_000 / 28_000) / 3, 9);
  });

  it('applies the flat stretch and range rules to decreasing table curves', () => {
    expect(invertCurve(table([65_535, 30_000, 30_000, 0]), 30_000 / 65_535)).toBeCloseTo(2 / 3, 9);
    expect(invertCurve(table([65_535, 0, 0]), 0)).toBeCloseTo(0.5, 9);
    expect(invertCurve(table([65_535, 0]), 2)).toBeCloseTo(0, 9);
    expect(invertCurve(table([65_535, 2000]), 0)).toBeCloseTo(1, 9);
  });

  it('applies the same rules to parametric curves', () => {
    // Function type 1 with g = 1, a = 2 and b = -0.5 is 0 up to x = 0.25 and reaches 1 at x = 0.75, where clipping holds it.
    const curve: Curve = { kind: 'parametric', functionType: 1, params: [1, 2, -0.5] };
    expect(invertCurve(curve, 0)).toBeCloseTo(0.25, 9);
    expect(invertCurve(curve, 0.5)).toBeCloseTo(0.5, 9);
    expect(invertCurve(curve, 1)).toBeCloseTo(0.75, 9);
  });
});

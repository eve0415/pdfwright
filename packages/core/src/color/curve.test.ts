import type { Curve } from '../icc/iccTags.ts';

import fc from 'fast-check';
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

// ICC.1:2022, 10.18, Table 68: the five parametric function types, each with its own threshold, and every output clipped to [0, 1].
describe('icc parametric curves', () => {
  it.each([
    // Type 2 is (a·x + b)^g + c from x = -b/a, and c below it.
    { type: 2 as const, params: [2, 1, -0.5, 0.1], input: 0.25, expected: 0.1 },
    { type: 2 as const, params: [2, 1, -0.5, 0.1], input: 0.5, expected: 0.1 },
    { type: 2 as const, params: [2, 1, -0.5, 0.1], input: 0.75, expected: 0.0625 + 0.1 },
    // Type 3 is (a·x + b)^g from x = d, and c·x below it; these parameters jump at d, so the comparison at d is observable.
    { type: 3 as const, params: [2, 0.5, 0.3, 0.4, 0.5], input: 0.25, expected: 0.1 },
    { type: 3 as const, params: [2, 0.5, 0.3, 0.4, 0.5], input: 0.5, expected: 0.3025 },
    { type: 3 as const, params: [2, 0.5, 0.3, 0.4, 0.5], input: 0.8, expected: 0.49 },
    // Type 4 is (a·x + b)^g + e from x = d, and c·x + f below it.
    { type: 4 as const, params: [2, 0.5, 0.3, 0.4, 0.5, 0.05, 0.02], input: 0.25, expected: 0.12 },
    { type: 4 as const, params: [2, 0.5, 0.3, 0.4, 0.5, 0.05, 0.02], input: 0.5, expected: 0.3525 },
    { type: 4 as const, params: [2, 0.5, 0.3, 0.4, 0.5, 0.05, 0.02], input: 0.8, expected: 0.54 },
    // The outer clip holds type 1 with g = 1, a = 2 and b = -0.5 at 1 where it would reach 1.5.
    { type: 1 as const, params: [1, 2, -0.5], input: 1, expected: 1 },
    { type: 4 as const, params: [2, 0.5, 0.3, 0.4, 0.5, 0.05, -0.3], input: 0.25, expected: 0 },
  ])('evaluates function type $type with $params at $input as $expected', ({ type, params, input, expected }) => {
    expect(evaluateCurve({ kind: 'parametric', functionType: type, params }, input)).toBeCloseTo(expected, 12);
  });

  it('raises a type 0 curve to a non-integer power', () => {
    expect(evaluateCurve({ kind: 'parametric', functionType: 0, params: [2.4] }, 0.5)).toBeCloseTo(0.5 ** 2.4, 12);
  });
});

describe('icc sampled curves', () => {
  it('clips inputs outside [0, 1] to the end samples', () => {
    expect(evaluateCurve(table([16_384, 65_535]), -0.2)).toBeCloseTo(16_384 / 65_535, 12);
    expect(evaluateCurve(table([16_384, 65_535]), 1.2)).toBe(1);
  });

  it.each([
    { label: '8-bit (0, 255)', values: Uint8Array.of(0, 255), expected: 0.5 },
    { label: '8-bit (0, 51)', values: Uint8Array.of(0, 51), expected: 0.1 },
    { label: '16-bit (0, 51)', values: Uint16Array.of(0, 51), expected: 25.5 / 65_535 },
  ])('scales $label samples to the unit range at 0.5', ({ values, expected }) => {
    expect(evaluateCurve({ kind: 'table', values }, 0.5)).toBeCloseTo(expected, 12);
  });

  it('passes identity curves through in both directions without clipping', () => {
    expect(evaluateCurve({ kind: 'identity' }, 2)).toBe(2);
    expect(invertCurve({ kind: 'identity' }, 2)).toBe(2);
    expect(invertCurve({ kind: 'identity' }, -0.5)).toBe(-0.5);
  });

  it.each([
    { output: -1, expected: 0 },
    { output: 0.3, expected: 0.3 },
    { output: 2, expected: 1 },
  ])('inverts a one-sample table as the clipped identity: $output gives $expected', ({ output, expected }) => {
    expect(invertCurve(table([40_000]), output)).toBe(expected);
  });

  it.each([0, 0.2, 30_000 / 65_535, 1])('inverts a flat table to its lowest input, since the flat stretch ends the domain: %d', output => {
    expect(invertCurve(table([30_000, 30_000, 30_000]), output)).toBe(0);
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

describe('properties', () => {
  // Strictly monotonic tables: distinct 16-bit samples, sorted up or down.
  const strictTable = fc
    .tuple(fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 2, maxLength: 24 }), fc.boolean())
    .map(([samples, increasing]) => samples.toSorted((left, right) => (increasing ? left - right : right - left)));
  const unit = fc.double({ min: 0, max: 1, noNaN: true });

  it('inverts a strictly monotonic table to an input it maps back to the target', () => {
    fc.assert(
      fc.property(strictTable, unit, (samples, position) => {
        const curve = table(samples);
        const low = Math.min(evaluateCurve(curve, 0), evaluateCurve(curve, 1));
        const high = Math.max(evaluateCurve(curve, 0), evaluateCurve(curve, 1));
        const target = low + position * (high - low);
        expect(evaluateCurve(curve, invertCurve(curve, target))).toBeCloseTo(target, 9);
      }),
    );
  });

  // Types 0–2 with g ≥ 1, a > 0 and b ≥ 0 increase on [0, 1] and never fall below their value at 0; g ≥ 1 bounds the slope, so a 1e-12 search error stays below 1e-9 in the output.
  const parametric = fc.oneof(
    fc.tuple(fc.double({ min: 1, max: 3, noNaN: true })).map(([g]): Curve => ({ kind: 'parametric', functionType: 0, params: [g] })),
    fc
      .tuple(fc.double({ min: 1, max: 3, noNaN: true }), fc.double({ min: 0.5, max: 2, noNaN: true }), fc.double({ min: 0, max: 0.5, noNaN: true }))
      .map(([g, a, b]): Curve => ({ kind: 'parametric', functionType: 1, params: [g, a, b] })),
    fc
      .tuple(
        fc.double({ min: 1, max: 3, noNaN: true }),
        fc.double({ min: 0.5, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
      )
      .map(([g, a, b, c]): Curve => ({ kind: 'parametric', functionType: 2, params: [g, a, b, c] })),
  );

  it('inverts an increasing parametric curve to an input it maps back to the target', () => {
    fc.assert(
      fc.property(parametric, unit, (curve, position) => {
        const low = evaluateCurve(curve, 0);
        const target = low + position * (evaluateCurve(curve, 1) - low);
        expect(evaluateCurve(curve, invertCurve(curve, target))).toBeCloseTo(target, 9);
      }),
    );
  });

  // ICC.1:2022, Annex F.1: a flat stretch inverts to its highest x unless it ends at the end of the domain, where it inverts to its lowest x.
  it('inverts a flat stretch to its highest input, or to its lowest when it ends the domain', () => {
    fc.assert(
      fc.property(
        strictTable.filter(samples => samples.length >= 3),
        fc.nat(),
        fc.nat(),
        (samples, first, second) => {
          const last = samples.length - 1;
          const start = first % samples.length;
          const end = start + (second % (samples.length - start));
          const level = samples[start] ?? 0;
          const flat = samples.map((value, index) => (index >= start && index <= end ? level : value));
          const expected = end === last ? start / last : end / last;
          expect(invertCurve(table(flat), level / 65_535)).toBeCloseTo(expected, 12);
        },
      ),
    );
  });
});

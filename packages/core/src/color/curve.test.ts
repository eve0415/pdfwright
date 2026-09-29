import { describe, expect, it } from 'vitest';

import { evaluateCurve, invertCurve } from './curve.ts';

describe('icc curve domains', () => {
  it('clips gamma and parametric inputs before exponentiation', () => {
    expect(evaluateCurve({ kind: 'gamma', gamma: 1.8 }, -0.1)).toBe(0);
    expect(evaluateCurve({ kind: 'gamma', gamma: 1.8 }, 1.1)).toBe(1);
    expect(evaluateCurve({ kind: 'parametric', functionType: 0, params: [1.8] }, -0.1)).toBe(0);
    expect(invertCurve({ kind: 'gamma', gamma: 1.8 }, -0.1)).toBe(0);
  });
});

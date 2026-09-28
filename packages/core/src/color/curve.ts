import type { Curve } from '../icc/iccTags.ts';

import { deterministicPow } from './ieeeMath.ts';

const clip = (value: number): number => Math.min(1, Math.max(0, value));

const table = (values: Float64Array, input: number): number => {
  const position = clip(input) * (values.length - 1);
  const low = Math.min(Math.floor(position), values.length - 2);
  const fraction = position - low;
  return (values[low] ?? 0) + fraction * ((values[low + 1] ?? 0) - (values[low] ?? 0));
};

const parametric = (curve: Extract<Curve, { kind: 'parametric' }>, input: number): number => {
  // ICC.1:2022, 10.18 Table 68 defines five piecewise power functions and clips outputs to [0,1].
  const [g = 1, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = curve.params;
  if (curve.functionType === 0) return deterministicPow(input, g);
  if (curve.functionType === 1) return input >= -b / a ? deterministicPow(a * input + b, g) : 0;
  if (curve.functionType === 2) return input >= -b / a ? deterministicPow(a * input + b, g) + c : c;
  if (curve.functionType === 3) return input >= d ? deterministicPow(a * input + b, g) : c * input;
  return input >= d ? deterministicPow(a * input + b, g) + e : c * input + f;
};

export const evaluateCurve = (curve: Curve, input: number): number => {
  if (curve.kind === 'identity') return input;
  if (curve.kind === 'gamma') return deterministicPow(input, curve.gamma);
  if (curve.kind === 'table') return table(curve.values, input);
  return clip(parametric(curve, input));
};

export const invertCurve = (curve: Curve, output: number): number => {
  if (curve.kind === 'identity') return output;
  if (curve.kind === 'gamma') return deterministicPow(output, 1 / curve.gamma);
  let low = 0;
  let high = 1;
  for (let index = 0; index < 40; index++) {
    const middle = (low + high) / 2;
    if (evaluateCurve(curve, middle) < output) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
};

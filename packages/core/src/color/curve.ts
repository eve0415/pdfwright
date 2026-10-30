import type { Curve } from '../icc/iccTags.ts';

import { deterministicPow } from './ieeeMath.ts';

const clip = (value: number): number => Math.min(1, Math.max(0, value));

const table = (values: Uint8Array | Uint16Array, input: number): number => {
  const position = clip(input) * (values.length - 1);
  const low = Math.min(Math.floor(position), values.length - 2);
  const fraction = position - low;
  const scale = values instanceof Uint8Array ? 255 : 65535;
  return (values[low] ?? 0) / scale + fraction * ((values[low + 1] ?? 0) / scale - (values[low] ?? 0) / scale);
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
  if (curve.kind === 'gamma') return deterministicPow(clip(input), curve.gamma);
  if (curve.kind === 'table') return table(curve.values, input);
  return clip(parametric(curve, clip(input)));
};

// The curve is read as increasing after its values are multiplied by `direction`, so one search serves increasing and decreasing curves.
interface Inversion {
  readonly direction: 1 | -1;
  readonly target: number;
  readonly top: number;
}

const invertTable = (values: Uint8Array | Uint16Array, inversion: Inversion): number => {
  const scale = values instanceof Uint8Array ? 255 : 65535;
  const at = (index: number): number => (inversion.direction * (values[index] ?? 0)) / scale;
  const last = values.length - 1;
  if (inversion.target >= inversion.top) {
    // The lowest sample that reaches the top value; the segment before it rises to the top inside its span.
    let low = 0;
    let high = last;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (at(middle) >= inversion.top) high = middle;
      else low = middle + 1;
    }
    if (high === 0) return 0;
    return (high - 1 + (inversion.top - at(high - 1)) / (at(high) - at(high - 1))) / last;
  }
  // The highest sample at or below the target; the segment after it rises past the target.
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (at(middle) <= inversion.target) low = middle;
    else high = middle;
  }
  return (low + (inversion.target - at(low)) / (at(high) - at(low))) / last;
};

const invertBySearch = (curve: Curve, inversion: Inversion): number => {
  const value = (input: number): number => inversion.direction * evaluateCurve(curve, input);
  const reachesTop = inversion.target >= inversion.top;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 40; index++) {
    const middle = (low + high) / 2;
    // Below the top value the search converges on the highest input at or below the target, and at the top on the lowest input that reaches it.
    const below = reachesTop ? value(middle) < inversion.top : value(middle) <= inversion.target;
    if (below) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
};

export const invertCurve = (curve: Curve, output: number): number => {
  if (curve.kind === 'identity') return output;
  if (curve.kind === 'gamma') return deterministicPow(clip(output), 1 / curve.gamma);
  if (curve.kind === 'table' && curve.values.length < 2) return clip(output);
  // ICC.1:2022, Annex F.1: a monotonically increasing or decreasing curve inverts by exchanging x and y. A flat stretch inverts to its highest x unless it ends at the end of the domain, where it inverts to its lowest x, and a value outside the curve's range inverts as the nearest value in it.
  const direction = evaluateCurve(curve, 1) < evaluateCurve(curve, 0) ? -1 : 1;
  const bottom = direction * evaluateCurve(curve, 0);
  const top = direction * evaluateCurve(curve, 1);
  const inversion: Inversion = { direction, target: Math.min(top, Math.max(bottom, direction * output)), top };
  return curve.kind === 'table' ? invertTable(curve.values, inversion) : invertBySearch(curve, inversion);
};

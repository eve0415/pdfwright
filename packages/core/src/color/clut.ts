import type { Clut } from '../icc/iccLut.ts';

const clip = (value: number): number => Math.min(1, Math.max(0, value));

// ECMA-262, Number::exponentiate: the exponentiation operator is implementation-approximated, so corner counts and corner bits come from exact integer doubling and halving, computed once for the at most three axes an interpolation step spans.
const cornerCount = (dimensions: number): number => {
  let count = 1;
  for (let axis = 0; axis < dimensions; axis++) count *= 2;
  return count;
};

const cornerBits = (corner: number): readonly number[] => {
  const bits: number[] = [];
  let rest = corner;
  for (let axis = 0; axis < 3; axis++) {
    const bit = rest % 2;
    bits.push(bit);
    rest = (rest - bit) / 2;
  }
  return bits;
};

const CORNER_BITS: readonly (readonly number[])[] = Array.from({ length: 8 }, (_, corner) => cornerBits(corner));

const node = (clut: Clut, coordinates: readonly number[], channel: number): number => {
  let index = 0;
  for (let axis = 0; axis < clut.inputChannels; axis++) index = index * (clut.gridPoints[axis] ?? 1) + (coordinates[axis] ?? 0);
  return (clut.values[index * clut.outputChannels + channel] ?? 0) / (clut.values instanceof Uint8Array ? 255 : 65535);
};

const interpolateThree = (clut: Clut, state: { lower: number[]; fractions: number[]; first: number; mode: 'trilinear' | 'tetrahedral' }): number[] => {
  // ICC.1:2022, 10.10 and 10.12 place the last input fastest in CLUT storage; the CMM interpolation split follows LittleCMS cmsintrp.c.
  const { lower, fractions, first, mode } = state;
  const output = Array.from({ length: clut.outputChannels }, () => 0);
  if (mode === 'trilinear') {
    for (let corner = 0; corner < 8; corner++) {
      const coordinate = [...lower];
      const bits = CORNER_BITS[corner];
      let weight = 1;
      for (let axis = 0; axis < 3; axis++) {
        const bit = bits?.[axis] ?? 0;
        coordinate[first + axis] = (lower[first + axis] ?? 0) + bit;
        weight *= bit === 1 ? (fractions[first + axis] ?? 0) : 1 - (fractions[first + axis] ?? 0);
      }
      for (let channel = 0; channel < output.length; channel++) output[channel] = (output[channel] ?? 0) + weight * node(clut, coordinate, channel);
    }
    return output;
  }
  const coordinate = [...lower];
  const order = [first, first + 1, first + 2].toSorted((left, right) => (fractions[right] ?? 0) - (fractions[left] ?? 0));
  for (let channel = 0; channel < output.length; channel++) output[channel] = node(clut, coordinate, channel);
  for (const axis of order) {
    const previous = output.map((_, channel) => node(clut, coordinate, channel));
    coordinate[axis] = (coordinate[axis] ?? 0) + 1;
    for (let channel = 0; channel < output.length; channel++) {
      output[channel] = (output[channel] ?? 0) + (fractions[axis] ?? 0) * (node(clut, coordinate, channel) - (previous[channel] ?? 0));
    }
  }
  return output;
};

const interpolateSmall = (clut: Clut, state: { lower: number[]; fractions: number[]; first: number }): number[] => {
  const { lower, fractions, first } = state;
  const dimensions = clut.inputChannels - first;
  const result = Array.from({ length: clut.outputChannels }, () => 0);
  const corners = cornerCount(dimensions);
  for (let corner = 0; corner < corners; corner++) {
    const coordinate = [...lower];
    const bits = CORNER_BITS[corner];
    let weight = 1;
    for (let axis = 0; axis < dimensions; axis++) {
      const bit = bits?.[axis] ?? 0;
      coordinate[first + axis] = (lower[first + axis] ?? 0) + bit;
      weight *= bit === 1 ? (fractions[first + axis] ?? 0) : 1 - (fractions[first + axis] ?? 0);
    }
    for (let channel = 0; channel < result.length; channel++) result[channel] = (result[channel] ?? 0) + weight * node(clut, coordinate, channel);
  }
  return result;
};

export const evaluateClut = (clut: Clut, input: readonly number[], mode: 'trilinear' | 'tetrahedral'): number[] => {
  const lower: number[] = [];
  const fractions: number[] = [];
  for (let axis = 0; axis < clut.inputChannels; axis++) {
    const max = (clut.gridPoints[axis] ?? 2) - 1;
    const position = clip(input[axis] ?? 0) * max;
    const base = Math.min(Math.floor(position), max - 1);
    lower.push(base);
    fractions.push(position - base);
  }
  const recurse = (first: number): number[] => {
    const remaining = clut.inputChannels - first;
    if (remaining === 3) return interpolateThree(clut, { lower, fractions, first, mode });
    if (remaining < 3) return interpolateSmall(clut, { lower, fractions, first });
    const base = lower[first] ?? 0;
    lower[first] = base;
    const low = recurse(first + 1);
    lower[first] = base + 1;
    const high = recurse(first + 1);
    lower[first] = base;
    return low.map((value, channel) => value + (fractions[first] ?? 0) * ((high[channel] ?? 0) - value));
  };
  return recurse(0);
};

import type { Xyz } from '../icc/iccStructure.ts';
import type { CalGraySource, CalRgbSource } from './calibratedSource.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { calibratedProfile } from './calibratedSource.ts';
import { createColorTransform } from './createColorTransform.ts';
import { iccProfile, PCS_D50 } from './testing/iccProfiles.ts';

const D50 = PCS_D50;
const D65 = { x: 0.9505, y: 1, z: 1.089 };

// The destination's unit colorants and identity TRCs make its device values the PCS XYZ values.
const destination = iccProfile;

const relative = { intent: 'relativeColorimetric', blackPointCompensation: false } as const;

const convert = (source: CalRgbSource | CalGraySource, input: ReadonlyArray<number>): Array<number> => {
  const transform = createColorTransform(source, destination(), relative);
  const output = new Float64Array(transform.outputChannels);
  transform.convert(Float64Array.from(input), output);
  return [...output];
};

// ICC.1:2022, Annex E.3, Equation E.4 gives the Bradford cone-response matrix, read by rows.
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296] as const;

const cone = (xyz: ReadonlyArray<number>): Array<number> =>
  [0, 1, 2].map(row => (BRADFORD[row * 3] ?? 0) * (xyz[0] ?? 0) + (BRADFORD[row * 3 + 1] ?? 0) * (xyz[1] ?? 0) + (BRADFORD[row * 3 + 2] ?? 0) * (xyz[2] ?? 0));

// ICC.1:2022, Annex E.3, Equations E.1–E.3: an XYZ value adapted from one white to another keeps its cone responses in the ratio of the two whites' cone responses.
const bradfordCones = (unadapted: ReadonlyArray<number>, from: Xyz): Array<number> => {
  const fromCone = cone([from.x, from.y, from.z]);
  const toCone = cone([D50.x, D50.y, D50.z]);
  return cone(unadapted).map((value, index) => (value * (toCone[index] ?? 0)) / (fromCone[index] ?? 1));
};

describe('calibrated PDF colour sources', () => {
  it('adapts CalGray D65 to D50 after applying gamma', () => {
    const output = convert({ kind: 'calGray', whitePoint: D65, gamma: 2 }, [0.5]);
    expect(output[0]).toBeCloseTo(D50.x * 0.25, 10);
    expect(output[1]).toBeCloseTo(0.25, 10);
    expect(output[2]).toBeCloseTo(D50.z * 0.25, 10);
  });

  // ISO 32000-1:2008, 8.6.5.3: each component is raised to its own gamma and the results weight the three Matrix columns, an XYZ value relative to the declared white.
  const iecColumns = [0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505] as const;
  const gamma = [1.8, 2.2, 2.6] as const;
  const unadapted = (input: readonly [number, number, number]): Array<number> => {
    const linear = input.map((value, index) => value ** (gamma[index] ?? 1));
    return [0, 1, 2].map(
      row => (linear[0] ?? 0) * (iecColumns[row] ?? 0) + (linear[1] ?? 0) * (iecColumns[3 + row] ?? 0) + (linear[2] ?? 0) * (iecColumns[6 + row] ?? 0),
    );
  };

  it.each([{ input: [1, 0, 0] as const }, { input: [0, 0, 1] as const }, { input: [0.5, 0.5, 0.5] as const }, { input: [0.2, 0.7, 0.4] as const }])(
    'adapts CalRGB D65 $input to D50 through Bradford cone responses with a gamma per component',
    ({ input }) => {
      const output = convert({ kind: 'calRGB', whitePoint: D65, gamma, matrix: iecColumns }, input);
      const actual = cone(output);
      for (const [index, value] of bradfordCones(unadapted(input), D65).entries()) {
        expect(actual[index]).toBeCloseTo(value, 9);
      }
    },
  );

  it('maps CalRGB white to the D50 PCS white', () => {
    const output = convert({ kind: 'calRGB', whitePoint: D65, gamma, matrix: [D65.x, 0, 0, 0, 1, 0, 0, 0, D65.z] }, [1, 1, 1]);
    expect(output[0]).toBeCloseTo(D50.x, 10);
    expect(output[1]).toBeCloseTo(1, 10);
    expect(output[2]).toBeCloseTo(D50.z, 10);
  });

  it.each([
    { input: [1, 0, 0], expected: [0.4, 0.1, 0.2] },
    { input: [0, 1, 0], expected: [0.3, 0.5, 0.3] },
    { input: [0, 0, 1], expected: [0.2642, 0.4, 0.3249] },
  ])('reads CalRGB Matrix entries as three XYZ columns: $input gives $expected', ({ input, expected }) => {
    const output = convert({ kind: 'calRGB', whitePoint: D50, gamma: [1, 1, 1], matrix: [0.4, 0.1, 0.2, 0.3, 0.5, 0.3, 0.2642, 0.4, 0.3249] }, input);
    for (const [index, value] of expected.entries()) {
      expect(output[index]).toBeCloseTo(value, 12);
    }
  });
});

describe('calibrated source validation', () => {
  // ISO 32000-1:2008, 8.6.5.2, Table 63: WhitePoint has positive X and Z and a Y of exactly 1.
  const oneUlpAbove = 1 + Number.EPSILON;
  const oneUlpBelow = 1 - Number.EPSILON / 2;

  it.each([{ whitePoint: { x: 0.95, y: 1, z: 1.09 } }, { whitePoint: { x: Number.MIN_VALUE, y: 1, z: Number.MIN_VALUE } }])(
    'accepts the white point $whitePoint',
    ({ whitePoint }) => {
      expect(calibratedProfile({ kind: 'calGray', whitePoint, gamma: 1 }).header.colorSpace).toBe('Gray');
    },
  );

  it.each([
    { whitePoint: { x: 0.95, y: oneUlpAbove, z: 1.09 } },
    { whitePoint: { x: 0.95, y: oneUlpBelow, z: 1.09 } },
    { whitePoint: { x: 0.95, y: 1 + 1e-7, z: 1.09 } },
    { whitePoint: { x: 0.95, y: 1 - 1e-7, z: 1.09 } },
    { whitePoint: { x: 0, y: 1, z: 1.09 } },
    { whitePoint: { x: -1, y: 1, z: 1.09 } },
    { whitePoint: { x: 0.95, y: 1, z: 0 } },
    { whitePoint: { x: 0.95, y: 1, z: -1 } },
    { whitePoint: { x: Number.NaN, y: 1, z: 1.09 } },
    { whitePoint: { x: 0.95, y: 1, z: Infinity } },
  ])('rejects the white point $whitePoint for CalGray and CalRGB', ({ whitePoint }) => {
    expect(() => calibratedProfile({ kind: 'calGray', whitePoint, gamma: 1 })).toThrow(InvalidArgumentError);
    expect(() => calibratedProfile({ kind: 'calRGB', whitePoint, gamma: [1, 1, 1], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] })).toThrow(InvalidArgumentError);
  });

  // ISO 32000-1:2008, 8.6.5.2, Table 63 and 8.6.5.3, Table 64: every Gamma entry is positive.
  it('accepts the smallest positive gamma', () => {
    expect(calibratedProfile({ kind: 'calGray', whitePoint: D50, gamma: Number.MIN_VALUE }).trc).toStrictEqual({
      gray: { kind: 'gamma', gamma: Number.MIN_VALUE },
    });
    expect(calibratedProfile({ kind: 'calRGB', whitePoint: D50, gamma: [Number.MIN_VALUE, 1, 2], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).trc).toStrictEqual({
      red: { kind: 'gamma', gamma: Number.MIN_VALUE },
      green: { kind: 'gamma', gamma: 1 },
      blue: { kind: 'gamma', gamma: 2 },
    });
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects the gamma %d for CalGray and at each CalRGB position', bad => {
    expect(() => calibratedProfile({ kind: 'calGray', whitePoint: D50, gamma: bad })).toThrow(InvalidArgumentError);
    const gammas: ReadonlyArray<readonly [number, number, number]> = [
      [bad, 1, 1],
      [1, bad, 1],
      [1, 1, bad],
    ];
    for (const value of gammas) {
      expect(() => calibratedProfile({ kind: 'calRGB', whitePoint: D50, gamma: value, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] })).toThrow(InvalidArgumentError);
    }
  });

  it.each([
    { index: 0, value: Number.NaN },
    { index: 4, value: Infinity },
    { index: 8, value: -Infinity },
    { index: 8, value: Number.NaN },
  ])('rejects a CalRGB Matrix entry $value at index $index', ({ index, value }) => {
    const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1].map((entry, position) => (position === index ? value : entry));
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = matrix;
    expect(() => calibratedProfile({ kind: 'calRGB', whitePoint: D50, gamma: [1, 1, 1], matrix: [a, b, c, d, e, f, g, h, i] })).toThrow(InvalidArgumentError);
  });
});

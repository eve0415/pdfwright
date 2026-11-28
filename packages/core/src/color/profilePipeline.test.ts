import type { IccProfile } from '../icc/iccProfile.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { Matrix3 } from '../icc/iccTags.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { applyMatrix } from './lutPipeline.ts';
import { destinationEvaluator, invertMatrix3, sourceEvaluator } from './profilePipeline.ts';
import { IDENTITY_CURVE, iccProfile, lut8 } from './testing/iccProfiles.ts';
import { largestDifference } from './testing/largestDifference.ts';

const constantTag = (sample: number): ReturnType<typeof lut8> => lut8(3, 1, () => [sample]);

const grayOutput = (pcsToDevice: IccProfile['pcsToDevice']): IccProfile =>
  iccProfile({ header: { profileClass: 'output', colorSpace: 'Gray', pcs: 'Lab' }, colorants: undefined, trc: undefined, pcsToDevice });

describe('rendering intent tag selection', () => {
  // LittleCMS 2.16 cmsio1.c, PCS2Device16: BToA0, BToA1 and BToA2 hold the perceptual, media-relative colorimetric and saturation transforms, and ICC-absolute colorimetry reads BToA1 too.
  it.each([
    { intent: 'perceptual' as const, expected: 0.2 },
    { intent: 'relativeColorimetric' as const, expected: 0.4 },
    { intent: 'saturation' as const, expected: 0.6 },
    { intent: 'absoluteColorimetric' as const, expected: 0.4 },
  ])('reads the $intent tag', ({ intent, expected }) => {
    const profile = grayOutput({ 0: constantTag(51), 1: constantTag(102), 2: constantTag(153) });
    expect(destinationEvaluator(profile, intent, 'icc')({ space: 'Lab', values: [50, 0, 0] })[0]).toBeCloseTo(expected, 12);
  });

  // LittleCMS 2.16 cmsio1.c, _cmsReadOutputLUT and _cmsReadInputLUT: an intent without its own tag reverts to the perceptual tag.
  it.each(['perceptual', 'relativeColorimetric', 'saturation', 'absoluteColorimetric'] as const)('falls back to the only tag, tag 0, for %s', intent => {
    const profile = grayOutput({ 0: constantTag(51) });
    expect(destinationEvaluator(profile, intent, 'icc')({ space: 'Lab', values: [50, 0, 0] })[0]).toBeCloseTo(0.2, 12);
  });
});

describe('missing profile data', () => {
  const lab = { space: 'Lab' as const, values: [50, 0, 0] };
  const bothDirections = (profile: IccProfile, intent: RenderingIntent = 'relativeColorimetric'): Array<() => void> => [
    () => {
      sourceEvaluator(profile, intent, 'icc');
    },
    () => {
      destinationEvaluator(profile, intent, 'icc')(lab);
    },
  ];

  it.each([
    { label: 'an RGB profile without TRCs', profile: iccProfile({ trc: undefined }) },
    { label: 'an RGB profile with only a gray TRC', profile: iccProfile({ trc: { gray: IDENTITY_CURVE } }) },
    { label: 'an RGB profile without colorants', profile: iccProfile({ colorants: undefined }) },
    { label: 'a gray profile without a TRC', profile: iccProfile({ header: { colorSpace: 'Gray' }, colorants: undefined, trc: undefined }) },
    { label: 'a gray profile with RGB TRCs only', profile: iccProfile({ header: { colorSpace: 'Gray' }, colorants: undefined }) },
    { label: 'a CMYK profile without LUT tags', profile: iccProfile({ header: { colorSpace: 'CMYK' }, colorants: undefined, trc: undefined }) },
    {
      label: 'a LUT profile whose PCS is neither XYZ nor Lab',
      profile: iccProfile({ header: { colorSpace: 'Gray', pcs: 'RGB' }, deviceToPcs: { 1: lut8(1, 3, () => [0, 0, 0]) }, pcsToDevice: { 1: constantTag(0) } }),
    },
  ])('reports $label as a missing required tag in both directions', ({ profile }) => {
    for (const evaluate of bothDirections(profile)) {
      expect(evaluate).toThrow(InvalidProfileError);
      expect(evaluate).toThrow(expect.objectContaining({ reason: 'missing-required-tag' }));
    }
  });
});

describe('matrix inversion', () => {
  it('inverts a matrix with determinant 1e-4 and rejects one just below it', () => {
    expect(invertMatrix3([1, 0, 0, 0, 1, 0, 0, 0, 1e-4])).toStrictEqual([1, 0, 0, 0, 1, 0, 0, 0, 10_000]);
    expect(() => invertMatrix3([1, 0, 0, 0, 1, 0, 0, 0, 9.9e-5])).toThrow(InvalidProfileError);
    expect(() => invertMatrix3([1, 0, 0, 0, 1, 0, 0, 0, 9.9e-5])).toThrow(expect.objectContaining({ reason: 'singular-matrix' }));
  });

  it('inverts a non-diagonal matrix', () => {
    // An asymmetric matrix with determinant 1, so its inverse is its integer adjugate, exactly, and differs from its transpose.
    expect(invertMatrix3([1, 2, 0, 0, 1, 3, 0, 0, 1])).toStrictEqual([1, -2, 6, 0, 1, -3, 0, 0, 1]);
  });
});

describe('destination interpolation', () => {
  // A single full-scale corner: trilinear interpolation gives the product of the three fractions, tetrahedral the smallest of them.
  const corner = { ...lut8(3, 1, bits => [bits.every(bit => bit === 1) ? 255 : 0]), kind: 'lut16' as const };

  it('interpolates a Lab destination trilinearly', () => {
    const profile = grayOutput({ 1: corner });
    // ICC.1:2022, 10.10: lut16 keeps the legacy 16-bit PCSLAB encoding.
    const encoded = [(70 * 652.8) / 65_535, (128 * 256) / 65_535, (78 * 256) / 65_535];
    const expected = (encoded[0] ?? 0) * (encoded[1] ?? 0) * (encoded[2] ?? 0);
    expect(destinationEvaluator(profile, 'relativeColorimetric', 'icc')({ space: 'Lab', values: [70, 0, -50] })[0]).toBeCloseTo(expected, 12);
  });

  it('interpolates an XYZ destination tetrahedrally', () => {
    const profile = iccProfile({
      header: { profileClass: 'output', colorSpace: 'Gray', pcs: 'XYZ' },
      colorants: undefined,
      trc: undefined,
      pcsToDevice: { 1: corner },
    });
    // ICC.1:2022, 6.3.4.2, Table 11: PCSXYZ 1.0 is encoded as 32768 / 65535.
    expect(destinationEvaluator(profile, 'relativeColorimetric', 'icc')({ space: 'XYZ', values: [0.7, 0.5, 0.3] })[0]).toBeCloseTo((0.3 * 32_768) / 65_535, 12);
  });
});

describe('matrix/TRC destinations', () => {
  it('clips out-of-gamut channels through the inverse TRCs', () => {
    const square = { kind: 'gamma' as const, gamma: 2 };
    const profile = iccProfile({ trc: { red: square, green: square, blue: square } });
    const output = destinationEvaluator(profile, 'relativeColorimetric', 'icc')({ space: 'XYZ', values: [1.2, -0.1, 0.5] });
    expect(largestDifference(output, [1, 0, Math.SQRT1_2])).toBeLessThan(1e-12);
  });
});

describe('properties', () => {
  const entry = fc.double({ min: -1, max: 1, noNaN: true });
  const matrix = fc
    .tuple(entry, entry, entry, entry, entry, entry, entry, entry, entry)
    .filter(([a, b, c, d, e, f, g, h, i]) => Math.abs(a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)) > 0.01);

  it('undoes a well-conditioned matrix with its inverse', () => {
    fc.assert(
      fc.property(matrix, fc.tuple(entry, entry, entry), (values: Matrix3, vector) => {
        expect(largestDifference(applyMatrix(applyMatrix(vector, values), invertMatrix3(values)), vector)).toBeLessThan(1e-9);
      }),
    );
  });
});

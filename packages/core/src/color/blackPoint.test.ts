import type { IccProfile } from '../icc/iccProfile.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { Curve } from '../icc/iccTags.ts';
import type { ColorTransformOptions } from './createColorTransform.ts';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from './createColorTransform.ts';
import { IDENTITY_CURVE, IDENTITY_MATRIX, iccProfile, lut8, PCS_D50 } from './testing/iccProfiles.ts';
import { largestDifference } from './testing/largestDifference.ts';

const D50 = [PCS_D50.x, PCS_D50.y, PCS_D50.z] as const;

const converted = (source: IccProfile, destination: IccProfile, options: ColorTransformOptions, input: ReadonlyArray<number>): Array<number> => {
  const transform = createColorTransform({ kind: 'icc', profile: source }, destination, options);
  const output = new Float64Array(transform.outputChannels);
  transform.convert(Float64Array.from(input), output);
  return [...output];
};

const options = (intent: RenderingIntent, blackPointCompensation: boolean): ColorTransformOptions => ({ intent, blackPointCompensation });

// CIE 15:2004, 8.2.1: f(t) is the cube root above (6/29)^3 and linear below it, and L* = 116 f(Y) - 16.
const cieF = (ratio: number): number => (ratio > 216 / 24_389 ? Math.cbrt(ratio) : ((24_389 / 27) * ratio + 16) / 116);
const lightness = (luminance: number): number => 116 * cieF(luminance) - 16;

// ICC.1:2022, 10.18, Table 68, function type 2 with g = 1, a = 0.95, b = 0 and c = 0.05: 0.05 + 0.95 x, so device black is 5 % of each colorant.
const lifted: Curve = { kind: 'parametric', functionType: 2, params: [1, 0.95, 0, 0.05] };

// A matrix/TRC RGB source whose colorants are the D50 axes, so its black is 0.05 · D50 (L* about 26.7) and its white D50.
const liftedSource = (version = 4): IccProfile =>
  iccProfile({
    header: { version: { major: version, minor: 0, bugfix: 0 } },
    colorants: { red: { x: PCS_D50.x, y: 0, z: 0 }, green: { x: 0, y: 1, z: 0 }, blue: { x: 0, y: 0, z: PCS_D50.z } },
    trc: { red: lifted, green: lifted, blue: lifted },
  });

// The destination's unit colorants and identity TRCs make its device values the PCS XYZ values, and its black zero.
const xyzDestination = iccProfile;

// The source value with the lift removed: what black-point compensation from 0.05 · D50 to zero black gives.
const unlifted = (input: ReadonlyArray<number>): Array<number> => input.map((value, index) => value * (D50[index] ?? 1));
const lifted05 = (input: ReadonlyArray<number>): Array<number> => input.map((value, index) => (0.05 + 0.95 * value) * (D50[index] ?? 1));

describe('black-point compensation', () => {
  // LittleCMS 2.16 cmscnvrt.c:169–199: each XYZ axis is scaled so the source black maps to the destination black and D50 stays fixed.
  it.each([{ input: [0, 0, 0] }, { input: [1, 1, 1] }, { input: [0.5, 0.2, 0.8] }])(
    'maps the source black to the destination black and keeps white for $input',
    ({ input }) => {
      const output = converted(liftedSource(), xyzDestination(), options('relativeColorimetric', true), input);
      expect(largestDifference(output, unlifted(input))).toBeLessThan(1e-9);
    },
  );

  it('keeps the source black when compensation is off', () => {
    const output = converted(liftedSource(), xyzDestination(), options('relativeColorimetric', false), [0, 0, 0]);
    expect(largestDifference(output, lifted05([0, 0, 0]))).toBeLessThan(1e-12);
  });

  it('ignores a compensation request under the absolute intent', () => {
    const input = [0.3, 0, 0.6];
    const requested = converted(liftedSource(), xyzDestination(), options('absoluteColorimetric', true), input);
    const unrequested = converted(liftedSource(), xyzDestination(), options('absoluteColorimetric', false), input);
    expect(requested).toStrictEqual(unrequested);
    expect(largestDifference(requested, lifted05(input))).toBeLessThan(1e-12);
  });

  // LittleCMS 2.16 cmssamp.c:191–274: a version 4 matrix/TRC profile keeps its own black under the perceptual intent rather than the reference black.
  it.each([{ input: [0, 0, 0] }, { input: [0.5, 0.2, 0.8] }])(
    'compensates a version 4 matrix/TRC source with its own black under the perceptual intent for $input',
    ({ input }) => {
      const output = converted(liftedSource(), xyzDestination(), options('perceptual', true), input);
      expect(largestDifference(output, unlifted(input))).toBeLessThan(1e-9);
    },
  );
});

// A LUT-based Lab CMYK destination whose CLUT writes a, b and L* to channels 0, 1 and 2 under tag 0, which every intent reads.
const lutDestination = (version: number): IccProfile =>
  iccProfile({
    header: { version: { major: version, minor: 0, bugfix: 0 }, profileClass: 'output', colorSpace: 'CMYK', pcs: 'Lab' },
    colorants: undefined,
    trc: undefined,
    pcsToDevice: { 0: lut8(3, 4, ([l = 0, a = 0, b = 0]) => [a * 255, b * 255, l * 255, 0]) },
  });

// ICC.1:2022, 6.3.4.2, Table 13 and CIE 15:2004, 8.2.1: the lut8 encoding of the L*a*b* of an XYZ value.
const encoded = (xyz: ReadonlyArray<number>): Array<number> => {
  const [fx = 0, fy = 0, fz = 0] = xyz.map((value, index) => cieF(value / (D50[index] ?? 1)));
  return [(500 * (fx - fy) + 128) / 255, (200 * (fy - fz) + 128) / 255, (116 * fy - 16) / 100, 0];
};

describe('the version 4 perceptual reference black', () => {
  // ICC.1:2022, 6.3.3.2, Table 16 gives the perceptual reference black; these are the XYZ values LittleCMS 2.16 rounds it to.
  const referenceBlack = [0.00336, 0.0034731, 0.00287] as const;

  it('forces compensation to the reference black for a version 4 LUT destination under the perceptual intent', () => {
    const output = converted(liftedSource(), lutDestination(4), options('perceptual', false), [0, 0, 0]);
    expect(largestDifference(output, encoded(referenceBlack))).toBeLessThan(1e-9);
  });

  it.each([
    { label: 'a version 2 destination under the perceptual intent', version: 2, intent: 'perceptual' as const },
    { label: 'a version 4 destination under the relative intent', version: 4, intent: 'relativeColorimetric' as const },
  ])('leaves black uncompensated for $label without a request', ({ version, intent }) => {
    const output = converted(liftedSource(), lutDestination(version), options(intent, false), [0, 0, 0]);
    expect(largestDifference(output, encoded(lifted05([0, 0, 0])))).toBeLessThan(1e-9);
  });
});

describe('the destination black of a LUT profile', () => {
  // A gray output profile whose round trip through its tags is L* → max(L*, 25): the BToA1 table maps L* to clip((L* - 25) / 75), and the AToB1 table maps gray g back to 25 + 75 g.
  const shadowClip: Curve = { kind: 'table', values: Uint16Array.of(0, 0, 21_845, 43_690, 65_535) };
  const toGray = { ...lut8(3, 1, ([l = 0]) => [l * 255]), output: [shadowClip] };
  // ICC.1:2022, 10.10: lut16 uses the legacy PCSLAB encoding, where L* 25 and 100 are 16320 and 65280 and neutral a and b are 32768.
  const fromGray = {
    kind: 'lut16' as const,
    matrix: IDENTITY_MATRIX,
    input: [IDENTITY_CURVE],
    clut: { gridPoints: [2], inputChannels: 1, outputChannels: 3, values: Uint16Array.of(16_320, 32_768, 32_768, 65_280, 32_768, 32_768) },
    output: [IDENTITY_CURVE, IDENTITY_CURVE, IDENTITY_CURVE],
  };
  const grayOutput = iccProfile({
    header: { profileClass: 'output', colorSpace: 'Gray', pcs: 'Lab' },
    colorants: undefined,
    trc: undefined,
    deviceToPcs: { 1: fromGray },
    pcsToDevice: { 1: toGray },
  });

  // LittleCMS 2.16 cmssamp.c, cmsDetectDestinationBlackPoint: under the relative intent a round trip that is straight above its shadow keeps the initial black, here the L* 25 of device black.
  it('keeps the initial black when the relative round trip is straight above its shadow', () => {
    const blackLuminance = ((25 + 16) / 116) ** 3;
    // LittleCMS 2.16 cmscnvrt.c:169–199 on the Y axis, from the source black 0.05 to the destination black, with white fixed at 1.
    const compensated = (luminance: number): number => ((blackLuminance - 1) / (0.05 - 1)) * luminance - (blackLuminance - 0.05) / (0.05 - 1);
    const input = 0.5;
    const luminance = 0.05 + 0.95 * input;
    const expected = (lightness(compensated(luminance)) - 25) / 75;
    const output = converted(liftedSource(), grayOutput, options('relativeColorimetric', true), [input, input, input]);
    expect(output[0]).toBeCloseTo(expected, 9);
  });
});

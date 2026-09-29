import type { IccProfile } from '../icc/iccProfile.ts';
import type { Curve } from '../icc/iccTags.ts';
import type { PcsValue } from './profilePipeline.ts';

import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import { samples } from '../../../../tests/fixtures/icc/samples.ts';
import srgbV4Bytes from '../../../../tests/fixtures/icc/sRGB-v4.icc?icc-bytes';
import srgbArgyllBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import srgb2014Bytes from '../../../../tests/fixtures/icc/sRGB2014.icc?icc-bytes';
import { md5 } from '../hash/md5.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';

import { calibratedProfile } from './calibratedSource.ts';
import { createColorTransform } from './createColorTransform.ts';
import { evaluateCurve } from './curve.ts';
import { deltaE2000 } from './deltaE2000.ts';
import { xyzToLab } from './pcs.ts';
import { sourceEvaluator } from './profilePipeline.ts';
import { srgbColorSource, srgbProfileBytes } from './srgbSource.ts';

// IEC 61966-2-1:1999, transformation from sRGB values to CIE 1931 XYZ values: the piecewise decoding and the linear RGB to XYZ matrix under D65.
const decode = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const IEC_MATRIX = [0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505] as const;
const IEC_WHITE = { x: 0.9505, y: 1, z: 1.089 };

// The Bradford adaptation to the D50 PCS white that calibrated sources use, applied to the IEC matrix, with the standard's decoding function as the tone curve.
const analytic = calibratedProfile({ kind: 'calRGB', whitePoint: IEC_WHITE, gamma: [1, 1, 1], matrix: IEC_MATRIX });
const analyticXyz = sourceEvaluator(analytic, 'relativeColorimetric', 'icc');
const iec = (input: readonly number[]): PcsValue => analyticXyz(input.map(value => decode(value)));

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const rgbCurves = (profile: IccProfile): readonly Curve[] => {
  const { trc } = profile;
  if (trc === undefined || !('red' in trc)) throw new Error('the profile has no RGB TRCs');
  return [trc.red, trc.green, trc.blue];
};

const worstDifference = (reference: (input: readonly number[]) => PcsValue): number => {
  const builtIn = sourceEvaluator(srgbColorSource().profile, 'relativeColorimetric', 'icc');
  return Math.max(
    ...samples().map(([red, green, blue]) => {
      const input = [red / 255, green / 255, blue / 255];
      return deltaE2000(xyzToLab(builtIn(input).values), xyzToLab(reference(input).values));
    }),
  );
};

describe('built-in sRGB source', () => {
  it('embeds the registry sRGB2014.icc unchanged and returns an independent copy each time', () => {
    const bytes = srgbProfileBytes();
    expect(bytes).toStrictEqual(srgb2014Bytes);
    bytes[0] = 0xff;
    expect(srgbProfileBytes()).toStrictEqual(srgb2014Bytes);
    expect(srgbColorSource().profile.bytes).toStrictEqual(srgb2014Bytes);
  });

  it('parses as a version 2 RGB matrix/TRC display profile without warnings', () => {
    const { profile } = srgbColorSource();
    expect(profile.header).toMatchObject({ version: { major: 2 }, profileClass: 'display', colorSpace: 'RGB', pcs: 'XYZ' });
    expect(profile.warnings).toStrictEqual([]);
    expect(profile.deviceToPcs).toStrictEqual({});
    expect(profile.trc).toMatchObject({ red: { kind: 'table' }, green: { kind: 'table' }, blue: { kind: 'table' } });
  });

  it('carries the profile ID of its own bytes', () => {
    const { profile } = srgbColorSource();
    // ICC.1:2022, 7.2.18: the header's profile ID is the MD5 of the profile with flags, intent and ID zeroed.
    expect(hex(profile.header.profileId)).toBe(hex(profile.identity));
    expect(profile.description).toBe('sRGB2014');
  });

  it('follows the IEC 61966-2-1 decoding function within the 16-bit precision of its curv table', () => {
    const curves = rgbCurves(srgbColorSource().profile);
    let maximum = 0;
    for (let index = 0; index <= 65535; index++) {
      const value = index / 65535;
      for (const curve of curves) maximum = Math.max(maximum, Math.abs(evaluateCurve(curve, value) - decode(value)));
    }
    expect(maximum).toBeLessThan(1 / 65535);
  });

  it('agrees with the IEC 61966-2-1 definition and with other sRGB profiles within 0.035 ΔE2000', () => {
    // Measured maxima over the 6,189 samples: 0.0330 against the IEC definition and 0.0321 against each of the other two profiles.
    const argyll = sourceEvaluator(parseIccProfile(srgbArgyllBytes), 'relativeColorimetric', 'icc');
    const compact = sourceEvaluator(parseIccProfile(srgbV4Bytes), 'relativeColorimetric', 'icc');
    expect(worstDifference(iec)).toBeLessThan(0.035);
    expect(worstDifference(argyll)).toBeLessThan(0.035);
    expect(worstDifference(compact)).toBeLessThan(0.035);
  });

  it('keeps every intent of the sRGB to CMYK transform identical across runtimes', () => {
    const fogra = parseIccProfile(fograBytes);
    const points = samples();
    const intents = ['perceptual', 'relativeColorimetric', 'saturation', 'absoluteColorimetric'] as const;
    const transforms = intents.flatMap(intent =>
      [false, true].map(blackPointCompensation => createColorTransform(srgbColorSource(), fogra, { intent, blackPointCompensation })),
    );
    const bytes = new Uint8Array(points.length * transforms.length * 4 * 8);
    const view = new DataView(bytes.buffer);
    const output = new Float64Array(4);
    for (const [index, [red, green, blue]] of points.entries()) {
      const input = Float64Array.of(red / 255, green / 255, blue / 255);
      for (const [transformIndex, transform] of transforms.entries()) {
        transform.convert(input, output);
        for (let channel = 0; channel < 4; channel++) {
          view.setFloat64(((index * transforms.length + transformIndex) * 4 + channel) * 8, Number(output[channel]), true);
        }
      }
    }
    expect(hex(md5(bytes))).toBe('2a6506f28eda50e2222932700ea6fb44');
  });
});

import type { IccProfile, LutTag } from '../icc/iccProfile.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { Matrix3 } from '../icc/iccTags.ts';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { colorSpaceChannels } from '../icc/iccStructure.ts';

import { evaluateCurve, invertCurve } from './curve.ts';
import { evaluateLut } from './lutPipeline.ts';
import { D50, decodePcs, encodePcs, labToXyz, xyzToLab } from './pcs.ts';

export interface PcsValue {
  readonly space: 'XYZ' | 'Lab';
  readonly values: readonly number[];
}

const missing = (message: string): never => {
  throw new InvalidProfileError(message, 'missing-required-tag', { offset: 0 });
};

const pcs = (profile: IccProfile): 'XYZ' | 'Lab' => {
  if (profile.header.pcs === 'XYZ' || profile.header.pcs === 'Lab') return profile.header.pcs;
  return missing('ICC profile PCS must be XYZ or Lab for this transform');
};

const intentIndex = (intent: RenderingIntent): 0 | 1 | 2 => {
  if (intent === 'perceptual') return 0;
  if (intent === 'saturation') return 2;
  return 1;
};

const selected = (profile: IccProfile, direction: 'deviceToPcs' | 'pcsToDevice', intent: RenderingIntent): LutTag | undefined => {
  const tags = profile[direction];
  return tags[intentIndex(intent)] ?? tags[0];
};

const colorantsMatrix = (profile: IccProfile): Matrix3 => {
  const colors = profile.colorants;
  if (colors === undefined) return missing('ICC RGB colorants are missing');
  return [colors.red.x, colors.green.x, colors.blue.x, colors.red.y, colors.green.y, colors.blue.y, colors.red.z, colors.green.z, colors.blue.z];
};

const multiply = (matrix: Matrix3, values: readonly number[]): number[] => [
  matrix[0] * (values[0] ?? 0) + matrix[1] * (values[1] ?? 0) + matrix[2] * (values[2] ?? 0),
  matrix[3] * (values[0] ?? 0) + matrix[4] * (values[1] ?? 0) + matrix[5] * (values[2] ?? 0),
  matrix[6] * (values[0] ?? 0) + matrix[7] * (values[1] ?? 0) + matrix[8] * (values[2] ?? 0),
];

export const invertMatrix3 = (matrix: Matrix3): Matrix3 => {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (Math.abs(determinant) < 1e-4) throw new InvalidProfileError('ICC RGB colorant matrix is singular', 'singular-matrix', { offset: 0 });
  return [
    A / determinant,
    B / determinant,
    C / determinant,
    D / determinant,
    E / determinant,
    F / determinant,
    G / determinant,
    H / determinant,
    I / determinant,
  ];
};

export const sourceEvaluator = (
  profile: IccProfile,
  intent: RenderingIntent,
  option: 'icc' | 'adobe',
): ((input: readonly number[] | Float64Array) => PcsValue) => {
  const tag = selected(profile, 'deviceToPcs', intent);
  if (tag !== undefined) {
    const space = pcs(profile);
    return input => ({ space, values: decodePcs(evaluateLut(tag, input, 'tetrahedral'), space, { tag, option }) });
  }
  if (profile.header.colorSpace === 'RGB') {
    const { trc } = profile;
    if (trc === undefined || !('red' in trc)) return missing('ICC RGB TRCs are missing');
    const matrix = colorantsMatrix(profile);
    return input => ({
      space: 'XYZ',
      values: multiply(matrix, [evaluateCurve(trc.red, input[0] ?? 0), evaluateCurve(trc.green, input[1] ?? 0), evaluateCurve(trc.blue, input[2] ?? 0)]),
    });
  }
  if (profile.header.colorSpace === 'Gray') {
    const { trc } = profile;
    if (trc === undefined || !('gray' in trc)) return missing('ICC gray TRC is missing');
    if (pcs(profile) === 'Lab') return input => ({ space: 'Lab', values: [evaluateCurve(trc.gray, input[0] ?? 0) * 100, 0, 0] });
    const white = profile.mediaWhitePoint ?? D50;
    return input => ({ space: 'XYZ', values: [white.x, white.y, white.z].map(value => value * evaluateCurve(trc.gray, input[0] ?? 0)) });
  }
  return missing('ICC device-to-PCS direction is missing');
};

export const destinationEvaluator = (profile: IccProfile, intent: RenderingIntent, option: 'icc' | 'adobe'): ((pcsValue: PcsValue) => number[]) => {
  const tag = selected(profile, 'pcsToDevice', intent);
  if (tag !== undefined) {
    const space = pcs(profile);
    return input => {
      let { values } = input;
      if (input.space !== space) values = space === 'Lab' ? xyzToLab(input.values) : labToXyz(input.values);
      return evaluateLut(tag, encodePcs(values, space, { tag, option }), space === 'Lab' ? 'trilinear' : 'tetrahedral');
    };
  }
  if (profile.header.colorSpace === 'RGB') {
    const { trc } = profile;
    if (trc === undefined || !('red' in trc)) return missing('ICC RGB TRCs are missing');
    const matrix = invertMatrix3(colorantsMatrix(profile));
    return input => {
      const xyz = input.space === 'XYZ' ? input.values : labToXyz(input.values);
      const channels = multiply(matrix, xyz);
      return [invertCurve(trc.red, channels[0] ?? 0), invertCurve(trc.green, channels[1] ?? 0), invertCurve(trc.blue, channels[2] ?? 0)];
    };
  }
  if (profile.header.colorSpace === 'Gray') {
    const { trc } = profile;
    if (trc === undefined || !('gray' in trc)) return missing('ICC gray TRC is missing');
    return input => {
      const xyz = input.space === 'XYZ' ? input.values : labToXyz(input.values);
      return [invertCurve(trc.gray, (xyz[1] ?? 0) / D50.y)];
    };
  }
  return missing(`ICC ${String(colorSpaceChannels(profile.header.colorSpace))}-channel PCS-to-device direction is missing`);
};

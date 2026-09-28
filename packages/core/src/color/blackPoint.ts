import type { IccProfile } from '../icc/iccProfile.ts';
import type { RenderingIntent, Xyz } from '../icc/iccStructure.ts';
import type { PcsValue } from './profilePipeline.ts';

import { D50, labToXyz, xyzToLab } from './pcs.ts';
import { destinationEvaluator, sourceEvaluator } from './profilePipeline.ts';

// ICC.1:2022, 6.3.3.2 Table 16 gives the perceptual reference black. LittleCMS 2.16 uses these rounded XYZ constants.
const PERCEPTUAL_BLACK: Xyz = { x: 0.00336, y: 0.0034731, z: 0.00287 };
const ZERO: Xyz = { x: 0, y: 0, z: 0 };
const XYZ_SCALE = 1 + 32767 / 32768;

interface BlackPointAdjustment {
  readonly values: number[];
  readonly magnitude: number;
}

const xyzArray = (point: Xyz): number[] => [point.x, point.y, point.z];
const xyzPoint = (values: readonly number[]): Xyz => ({ x: values[0] ?? 0, y: values[1] ?? 0, z: values[2] ?? 0 });
const toXyz = (value: PcsValue): number[] => (value.space === 'XYZ' ? [...value.values] : labToXyz(value.values));
const toLab = (value: PcsValue): number[] => (value.space === 'Lab' ? [...value.values] : xyzToLab(value.values));
const neutral = (lightness: number): Xyz => xyzPoint(labToXyz([lightness, 0, 0]));

const scale = (input: readonly number[], blackIn: Xyz, blackOut: Xyz): BlackPointAdjustment => {
  // LittleCMS 2.16 cmscnvrt.c:169–199: scale each XYZ axis so the source black maps to destination black while D50 stays fixed.
  const source = xyzArray(blackIn);
  const destination = xyzArray(blackOut);
  const white = xyzArray(D50);
  let magnitude = 0;
  const values = input.map((value, index) => {
    const sourceBlack = source[index] ?? 0;
    const destinationBlack = destination[index] ?? 0;
    const referenceWhite = white[index] ?? 1;
    const ratio = (destinationBlack - referenceWhite) / (sourceBlack - referenceWhite);
    const offset = (-referenceWhite * (destinationBlack - sourceBlack)) / (sourceBlack - referenceWhite);
    magnitude += Math.abs(ratio - 1) + Math.abs(offset / XYZ_SCALE);
    return ratio * value + offset;
  });
  return { values, magnitude };
};

const usesMatrixTrc = (profile: IccProfile): boolean => {
  if (profile.header.colorSpace === 'RGB') return profile.colorants !== undefined && profile.trc !== undefined && 'red' in profile.trc;
  if (profile.header.colorSpace === 'Gray') return profile.trc !== undefined && 'gray' in profile.trc;
  return false;
};

const forcedV4 = (profile: IccProfile, intent: RenderingIntent): boolean =>
  profile.header.version.major >= 4 && (intent === 'perceptual' || intent === 'saturation');

const roundtrip = (profile: IccProfile, inputLab: readonly number[], config: { intent: RenderingIntent; option: 'icc' | 'adobe' }): number[] => {
  const { intent, option } = config;
  const toDevice = destinationEvaluator(profile, intent, option);
  const fromDevice = sourceEvaluator(profile, 'relativeColorimetric', option);
  let input: PcsValue = { space: 'Lab', values: inputLab };
  if (forcedV4(profile, intent)) input = { space: 'XYZ', values: scale(labToXyz(inputLab), ZERO, PERCEPTUAL_BLACK).values };
  return toLab(fromDevice(toDevice(input)));
};

const darkerColorant = (profile: IccProfile, intent: RenderingIntent, option: 'icc' | 'adobe'): Xyz => {
  let channels = [0, 0, 0];
  if (profile.header.colorSpace === 'CMYK') channels = [1, 1, 1, 1];
  else if (profile.header.colorSpace === 'Gray') channels = [0];
  const result = toLab(sourceEvaluator(profile, intent, option)(channels));
  const lightness = result[0] ?? 0;
  return neutral(lightness > 50 || lightness < 0 ? 0 : lightness);
};

const sourceBlack = (profile: IccProfile, intent: RenderingIntent, option: 'icc' | 'adobe'): Xyz => {
  // LittleCMS 2.16 cmssamp.c:191–274: v4 perceptual/saturation has a reference black except for matrix-shaper profiles.
  if (forcedV4(profile, intent) && !usesMatrixTrc(profile)) return PERCEPTUAL_BLACK;
  if (intent === 'relativeColorimetric' && profile.header.profileClass === 'output' && profile.header.colorSpace === 'CMYK') {
    const lightness = roundtrip(profile, [0, 0, 0], { intent: 'perceptual', option })[0] ?? 0;
    return neutral(Math.min(50, lightness));
  }
  return darkerColorant(profile, forcedV4(profile, intent) ? 'relativeColorimetric' : intent, option);
};

const quadraticMoments = (points: readonly (readonly [number, number])[]): number[][] => {
  let x1 = 0,
    x2 = 0,
    x3 = 0,
    x4 = 0,
    y0 = 0,
    y1 = 0,
    y2 = 0;
  for (const [x, y] of points) {
    const square = x * x;
    x1 += x;
    x2 += square;
    x3 += square * x;
    x4 += square * square;
    y0 += y;
    y1 += y * x;
    y2 += y * square;
  }
  return [
    [points.length, x1, x2, y0],
    [x1, x2, x3, y1],
    [x2, x3, x4, y2],
  ];
};

const pivotRow = (rows: number[][], column: number): number[] | undefined => {
  let pivot = column;
  for (let row = column + 1; row < 3; row++) if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) pivot = row;
  const current = rows[column];
  const selected = rows[pivot];
  if (current === undefined || selected === undefined) return undefined;
  rows[pivot] = current;
  rows[column] = selected;
  const divisor = selected[column] ?? 0;
  if (Math.abs(divisor) < 1e-12) return undefined;
  for (let index = column; index < 4; index++) selected[index] = (selected[index] ?? 0) / divisor;
  return selected;
};

const eliminateColumn = (rows: number[][], column: number, selected: number[]): boolean => {
  for (let row = 0; row < 3; row++) {
    if (row === column) continue;
    const target = rows[row];
    if (target === undefined) return false;
    const factor = target[column] ?? 0;
    for (let index = column; index < 4; index++) target[index] = (target[index] ?? 0) - factor * (selected[index] ?? 0);
  }
  return true;
};

const quadraticCoefficients = (rows: number[][]): readonly [number, number, number] | undefined => {
  for (let column = 0; column < 3; column++) {
    const selected = pivotRow(rows, column);
    if (selected === undefined || !eliminateColumn(rows, column, selected)) return undefined;
  }
  return [rows[0]?.[3] ?? 0, rows[1]?.[3] ?? 0, rows[2]?.[3] ?? 0];
};

const solveQuadratic = (points: readonly (readonly [number, number])[]): number => {
  if (points.length < 4) return 0;
  const coefficients = quadraticCoefficients(quadraticMoments(points));
  if (coefficients === undefined) return 0;
  const [constant, linear, quadratic] = coefficients;
  if (Math.abs(quadratic) < 1e-10) return 0;
  const discriminant = linear * linear - 4 * quadratic * constant;
  if (discriminant <= 0) return 0;
  return Math.max(0, Math.min(50, (-linear + Math.sqrt(discriminant)) / (2 * quadratic)));
};

interface LightnessRamp {
  readonly input: number[];
  readonly output: number[];
  readonly minimum: number;
  readonly maximum: number;
}

const sampleRamp = (profile: IccProfile, config: { intent: RenderingIntent; option: 'icc' | 'adobe'; initialLab: readonly number[] }): LightnessRamp => {
  const { intent, option, initialLab } = config;
  const inputRamp: number[] = [];
  const outputRamp: number[] = [];
  const chromaA = Math.max(-50, Math.min(50, initialLab[1] ?? 0));
  const chromaB = Math.max(-50, Math.min(50, initialLab[2] ?? 0));
  for (let index = 0; index < 256; index++) {
    const lightness = (index * 100) / 255;
    inputRamp.push(lightness);
    const returned = roundtrip(profile, [lightness, chromaA, chromaB], { intent, option });
    outputRamp.push(returned[0] ?? 0);
  }
  for (let index = 254; index > 0; index--) outputRamp[index] = Math.min(outputRamp[index] ?? 0, outputRamp[index + 1] ?? 0);
  return { input: inputRamp, output: outputRamp, minimum: outputRamp[0] ?? 0, maximum: outputRamp[255] ?? 0 };
};

const shadowPoints = (ramp: LightnessRamp, intent: RenderingIntent): [number, number][] => {
  const lower = intent === 'relativeColorimetric' ? 0.1 : 0.03;
  const upper = intent === 'relativeColorimetric' ? 0.5 : 0.25;
  const points: [number, number][] = [];
  for (let index = 0; index < 256; index++) {
    const normalized = ((ramp.output[index] ?? 0) - ramp.minimum) / (ramp.maximum - ramp.minimum);
    if (normalized >= lower && normalized < upper) points.push([ramp.input[index] ?? 0, normalized]);
  }
  return points;
};

const fittedBlack = (profile: IccProfile, intent: RenderingIntent, option: 'icc' | 'adobe'): Xyz => {
  const initialLab = intent === 'relativeColorimetric' ? xyzToLab(xyzArray(sourceBlack(profile, intent, option))) : [0, 0, 0];
  const ramp = sampleRamp(profile, { intent, option, initialLab });
  const { minimum, maximum } = ramp;
  if (minimum >= maximum) return ZERO;
  if (intent === 'relativeColorimetric') {
    const straight = ramp.input.every((value, index) => value <= minimum + 0.2 * (maximum - minimum) || Math.abs(value - (ramp.output[index] ?? 0)) < 4);
    if (straight) return xyzPoint(labToXyz(initialLab));
  }
  const points = shadowPoints(ramp, intent);
  if (points.length < 3) return ZERO;
  return xyzPoint(labToXyz([solveQuadratic(points), initialLab[1] ?? 0, initialLab[2] ?? 0]));
};

const destinationBlack = (profile: IccProfile, intent: RenderingIntent, option: 'icc' | 'adobe'): Xyz => {
  // LittleCMS 2.16 cmssamp.c:352–552: v4 perceptual is fixed; LUT destinations use a 256-step roundtrip and a shadow fit.
  if (forcedV4(profile, intent) && !usesMatrixTrc(profile)) return PERCEPTUAL_BLACK;
  let index: 0 | 1 | 2 = 1;
  if (intent === 'perceptual') index = 0;
  else if (intent === 'saturation') index = 2;
  const tag = profile.pcsToDevice[index] ?? profile.pcsToDevice[0];
  if (tag === undefined || ('clut' in tag && tag.clut === undefined)) return sourceBlack(profile, intent, option);
  return fittedBlack(profile, intent, option);
};

export const blackPointCompensation = (
  source: IccProfile,
  destination: IccProfile,
  config: { intent: RenderingIntent; requested: boolean; option: 'icc' | 'adobe' },
): ((input: PcsValue) => PcsValue) | undefined => {
  const { intent, requested, option } = config;
  if (intent === 'absoluteColorimetric' || (!requested && !forcedV4(destination, intent))) return undefined;
  const blackIn = sourceBlack(source, intent, option);
  const blackOut = destinationBlack(destination, intent, option);
  const { magnitude } = scale([0, 0, 0], blackIn, blackOut);
  if (magnitude < 0.002) return undefined;
  return input => ({ space: 'XYZ', values: scale(toXyz(input), blackIn, blackOut).values });
};

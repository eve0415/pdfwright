import type { IccProfile } from '../icc/iccProfile.ts';
import type { Xyz } from '../icc/iccStructure.ts';
import type { Matrix3 } from '../icc/iccTags.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { applyMatrix } from './lutPipeline.ts';
import { D50 } from './pcs.ts';
import { invertMatrix3 } from './profilePipeline.ts';

export interface CalRgbSource {
  readonly kind: 'calRGB';
  readonly whitePoint: Xyz;
  readonly gamma: readonly [number, number, number];
  /** The CalRGB Matrix in the order of ISO 32000-1:2008, 8.6.5.3, Table 64: XA YA ZA XB YB ZB XC YC ZC; a non-finite entry throws InvalidArgumentError. */
  readonly matrix: Matrix3;
}

export interface CalGraySource {
  readonly kind: 'calGray';
  readonly whitePoint: Xyz;
  readonly gamma: number;
}

interface Calibration {
  readonly colorants: IccProfile['colorants'];
  readonly trc: NonNullable<IccProfile['trc']>;
}

const BRADFORD: Matrix3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const INVERSE_BRADFORD = invertMatrix3(BRADFORD);

const validWhite = (white: Xyz): void => {
  if (!Number.isFinite(white.x) || !Number.isFinite(white.y) || !Number.isFinite(white.z) || white.x <= 0 || white.y !== 1 || white.z <= 0) {
    throw new InvalidArgumentError('calibrated white point must have positive X and Z and Y equal to one');
  }
};

const validGamma = (value: number): void => {
  if (!Number.isFinite(value) || value <= 0) throw new InvalidArgumentError('calibrated gamma must be positive');
};

const adapt = (value: readonly number[], from: Xyz): number[] => {
  // ICC.1:2022, Annex E.3 Equations E.1–E.4: linear Bradford adaptation scales cone responses from the declared white to PCS D50.
  const fromCone = applyMatrix([from.x, from.y, from.z], BRADFORD);
  const toCone = applyMatrix([D50.x, D50.y, D50.z], BRADFORD);
  const cone = applyMatrix(value, BRADFORD);
  return applyMatrix(
    cone.map((component, index) => (component * (toCone[index] ?? 0)) / (fromCone[index] ?? 1)),
    INVERSE_BRADFORD,
  );
};

const xyz = (values: readonly number[]): Xyz => ({ x: values[0] ?? 0, y: values[1] ?? 0, z: values[2] ?? 0 });

const calibration = (source: CalRgbSource | CalGraySource): Calibration => {
  // ISO 32000-1:2008, 8.6.5.2–8.6.5.3: gamma precedes the CalGray white-point scale or the CalRGB column-major matrix.
  if (source.kind === 'calGray') {
    validGamma(source.gamma);
    return { colorants: undefined, trc: { gray: { kind: 'gamma', gamma: source.gamma } } };
  }
  for (const gamma of source.gamma) validGamma(gamma);
  for (const value of source.matrix) if (!Number.isFinite(value)) throw new InvalidArgumentError('calibrated matrix entries must be finite');
  const { matrix } = source;
  return {
    colorants: {
      red: xyz(adapt([matrix[0], matrix[1], matrix[2]], source.whitePoint)),
      green: xyz(adapt([matrix[3], matrix[4], matrix[5]], source.whitePoint)),
      blue: xyz(adapt([matrix[6], matrix[7], matrix[8]], source.whitePoint)),
    },
    trc: { red: { kind: 'gamma', gamma: source.gamma[0] }, green: { kind: 'gamma', gamma: source.gamma[1] }, blue: { kind: 'gamma', gamma: source.gamma[2] } },
  };
};

export const calibratedProfile = (source: CalRgbSource | CalGraySource): IccProfile => {
  validWhite(source.whitePoint);
  const white = xyz(adapt([source.whitePoint.x, source.whitePoint.y, source.whitePoint.z], source.whitePoint));
  const { colorants, trc } = calibration(source);
  return {
    header: {
      size: 132,
      version: { major: 4, minor: 0, bugfix: 0 },
      profileClass: 'input',
      colorSpace: source.kind === 'calRGB' ? 'RGB' : 'Gray',
      pcs: 'XYZ',
      renderingIntent: 'relativeColorimetric',
      illuminant: D50,
      profileId: new Uint8Array(16),
    },
    description: undefined,
    copyright: undefined,
    mediaWhitePoint: white,
    mediaBlackPoint: undefined,
    chromaticAdaptation: undefined,
    colorants,
    trc,
    deviceToPcs: {},
    pcsToDevice: {},
    identity: new Uint8Array(16),
    bytes: new Uint8Array(132),
    warnings: [],
  };
};

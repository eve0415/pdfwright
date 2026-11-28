// Builds parsed ICC profile values directly, without bytes, for colour pipeline tests that start after parsing.
import type { TableLut } from '../../icc/iccLut.ts';
import type { IccProfile } from '../../icc/iccProfile.ts';
import type { IccHeader, Xyz } from '../../icc/iccStructure.ts';
import type { Curve } from '../../icc/iccTags.ts';

/** The PCS illuminant of ICC.1:2022, 7.2.16, written out so a test does not read the library's own constant. */
export const PCS_D50: Xyz = { x: 0.9642, y: 1, z: 0.8249 };

export const IDENTITY_CURVE: Curve = { kind: 'identity' };

export const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

/** Header and tag fields that replace the defaults of `iccProfile`; header fields merge one by one. */
export interface IccProfileFields extends Partial<Omit<IccProfile, 'header'>> {
  readonly header?: Partial<IccHeader>;
}

/**
 * A version 4 RGB display profile with an XYZ PCS, a D50 media white, unit colorants and identity TRCs, so the device values are the PCS XYZ values.
 * `bytes` and `identity` are zero, as no test of the pipeline reads them.
 */
export const iccProfile = (fields: IccProfileFields = {}): IccProfile => {
  const { header, ...rest } = fields;
  return {
    description: undefined,
    copyright: undefined,
    mediaWhitePoint: PCS_D50,
    mediaBlackPoint: undefined,
    chromaticAdaptation: undefined,
    colorants: { red: { x: 1, y: 0, z: 0 }, green: { x: 0, y: 1, z: 0 }, blue: { x: 0, y: 0, z: 1 } },
    trc: { red: IDENTITY_CURVE, green: IDENTITY_CURVE, blue: IDENTITY_CURVE },
    deviceToPcs: {},
    pcsToDevice: {},
    identity: new Uint8Array(16),
    bytes: new Uint8Array(132),
    warnings: [],
    ...rest,
    header: {
      size: 132,
      version: { major: 4, minor: 0, bugfix: 0 },
      profileClass: 'display',
      colorSpace: 'RGB',
      pcs: 'XYZ',
      renderingIntent: 'relativeColorimetric',
      illuminant: PCS_D50,
      profileId: new Uint8Array(16),
      ...header,
    },
  };
};

/** A 256-entry lut8 table curve that maps every 8-bit sample to itself. */
export const byteRamp = (): Curve => ({ kind: 'table', values: Uint8Array.from({ length: 256 }, (_, sample) => sample) });

/**
 * A lut8 tag with identity matrix, identity input and output tables and a 2-point grid on every input, whose CLUT corner values `corner` returns.
 * ICC.1:2022, 10.11: the last input varies fastest in the CLUT, so `corner` receives the corner bits in input order.
 */
export const lut8 = (inputs: number, outputs: number, corner: (bits: ReadonlyArray<0 | 1>) => ReadonlyArray<number>): TableLut => {
  const values: Array<number> = [];
  for (let index = 0; index < 2 ** inputs; index++) {
    const bits = Array.from({ length: inputs }, (_, axis): 0 | 1 => (Math.floor(index / 2 ** (inputs - 1 - axis)) % 2 === 1 ? 1 : 0));
    const entry = corner(bits);
    if (entry.length !== outputs || entry.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new RangeError(`corner ${bits.join('')} must give ${String(outputs)} integers from 0 to 255`);
    }
    values.push(...entry);
  }
  return {
    kind: 'lut8',
    matrix: IDENTITY_MATRIX,
    input: Array.from({ length: inputs }, byteRamp),
    clut: { gridPoints: Array.from({ length: inputs }, () => 2), inputChannels: inputs, outputChannels: outputs, values: Uint8Array.from(values) },
    output: Array.from({ length: outputs }, byteRamp),
  };
};

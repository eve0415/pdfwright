import type { IccProfile } from '../icc/iccProfile.ts';
import type { RenderingIntent, Xyz } from '../icc/iccStructure.ts';
import type { CalGraySource, CalRgbSource } from './calibratedSource.ts';
import type { PcsValue } from './profilePipeline.ts';
import type { RowConverters } from './rowConversion.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { colorSpaceChannels } from '../icc/iccStructure.ts';

import { blackPointCompensation } from './blackPoint.ts';
import { calibratedProfile } from './calibratedSource.ts';
import { D50, labToXyz } from './pcs.ts';
import { destinationEvaluator, sourceEvaluator } from './profilePipeline.ts';
import { createRowConverters } from './rowConversion.ts';

export interface IccColorSource {
  readonly kind: 'icc';
  readonly profile: IccProfile;
}

/** A parsed ICC profile or calibrated RGB or gray source for a colour transform; ICC.1:2022, 6.2 connects its PCS values to the destination profile. */
export type ColorSource = IccColorSource | CalRgbSource | CalGraySource;

/** Requires a rendering intent and black-point-compensation choice; lut8 Lab scaling defaults to `icc` and can use `adobe`, while ICC.1:2022, 6.3.4.2, Table 13 defines the standard scaling. */
export interface ColorTransformOptions {
  /** Rendering intent used by the transform. */
  readonly intent: RenderingIntent;
  /** Whether to compensate for source and destination black points. */
  readonly blackPointCompensation: boolean;
  /** How a lut8 tag's Lab a and b components are scaled: `icc` (the default) by 255, as ICC.1:2022, 6.3.4.2, Table 13 gives, so neutral is 128/255; `adobe` by 256, so neutral is 128/256. */
  readonly lut8LabEncoding?: 'icc' | 'adobe';
}

/** Converts normalized source components into destination components or 8-bit and 16-bit rows; wrong channel counts or nonfinite values raise InvalidArgumentError without a reason under ICC.1:2022, 6.2. */
export interface ColorTransform extends RowConverters {
  readonly inputChannels: number;
  readonly outputChannels: number;
  convert: (input: Float64Array, output: Float64Array) => void;
}

const mediaWhite = (profile: IccProfile): Xyz =>
  profile.header.profileClass === 'display' && profile.header.version.major === 2 ? D50 : (profile.mediaWhitePoint ?? D50);

const absolute = (input: PcsValue, sourceWhite: Xyz, destinationWhite: Xyz): PcsValue => {
  // ICC.1:2022, 6.3.2.2 applies diagonal media-white scaling for ICC-absolute colorimetry.
  const xyz = input.space === 'XYZ' ? input.values : labToXyz(input.values);
  return {
    space: 'XYZ',
    values: [
      ((xyz[0] ?? 0) * sourceWhite.x) / destinationWhite.x,
      ((xyz[1] ?? 0) * sourceWhite.y) / destinationWhite.y,
      ((xyz[2] ?? 0) * sourceWhite.z) / destinationWhite.z,
    ],
  };
};

/** Creates a colour transform from a supported source space to an ICC destination profile. */
export const createColorTransform = (source: ColorSource, destination: IccProfile, options: ColorTransformOptions): ColorTransform => {
  const encoding = options.lut8LabEncoding ?? 'icc';
  const sourceProfile = source.kind === 'icc' ? source.profile : calibratedProfile(source);
  const inputChannels = colorSpaceChannels(sourceProfile.header.colorSpace);
  const outputChannels = colorSpaceChannels(destination.header.colorSpace);
  const fromDevice = sourceEvaluator(sourceProfile, options.intent, encoding);
  const toDevice = destinationEvaluator(destination, options.intent, encoding);
  const sourceWhite = mediaWhite(sourceProfile);
  const destinationWhite = mediaWhite(destination);
  const compensate = blackPointCompensation(sourceProfile, destination, {
    intent: options.intent,
    requested: options.blackPointCompensation,
    option: encoding,
  });
  const convert = (input: Float64Array, output: Float64Array): void => {
    if (input.length !== inputChannels || output.length < outputChannels) {
      throw new InvalidArgumentError('colour transform buffer dimensions differ from profile channels');
    }
    for (const value of input) if (!Number.isFinite(value)) throw new InvalidArgumentError('colour components must be finite');
    if (
      sourceProfile.header.colorSpace === 'RGB' &&
      destination.header.colorSpace === 'CMYK' &&
      options.intent !== 'absoluteColorimetric' &&
      input.every(value => value === 1)
    ) {
      // ICC.1:2022, 6.2.2 maps media white to PCS white; keep the no-ink endpoint exact across non-absolute intents.
      output.fill(0, 0, outputChannels);
      return;
    }
    const pcsValue = fromDevice(input);
    const corrected = compensate === undefined ? pcsValue : compensate(pcsValue);
    const connected = options.intent === 'absoluteColorimetric' ? absolute(corrected, sourceWhite, destinationWhite) : corrected;
    const values = toDevice(connected);
    for (let index = 0; index < outputChannels; index++) output[index] = Math.min(1, Math.max(0, values[index] ?? 0));
  };
  return { inputChannels, outputChannels, convert, ...createRowConverters(convert, inputChannels, outputChannels) };
};

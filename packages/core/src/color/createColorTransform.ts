import type { IccProfile } from '../icc/iccProfile.ts';
import type { RenderingIntent, Xyz } from '../icc/iccStructure.ts';
import type { PcsValue } from './profilePipeline.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { colorSpaceChannels } from '../icc/iccStructure.ts';

import { D50, labToXyz } from './pcs.ts';
import { destinationEvaluator, sourceEvaluator } from './profilePipeline.ts';

export interface ColorSource {
  readonly kind: 'icc';
  readonly profile: IccProfile;
}

export interface ColorTransformOptions {
  readonly intent: RenderingIntent;
  readonly blackPointCompensation: boolean;
  /** ICC.1:2022, 6.3.4.2 Table 13 uses 128/255 for neutral a and b components. */
  readonly lut8LabEncoding?: 'icc' | 'adobe';
}

export interface ColorTransform {
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

export const createColorTransform = (source: ColorSource, destination: IccProfile, options: ColorTransformOptions): ColorTransform => {
  if (options.blackPointCompensation) throw new UnsupportedFeatureError('black-point compensation is not available for this transform');
  const encoding = options.lut8LabEncoding ?? 'icc';
  const inputChannels = colorSpaceChannels(source.profile.header.colorSpace);
  const outputChannels = colorSpaceChannels(destination.header.colorSpace);
  const fromDevice = sourceEvaluator(source.profile, options.intent, encoding);
  const toDevice = destinationEvaluator(destination, options.intent, encoding);
  const sourceWhite = mediaWhite(source.profile);
  const destinationWhite = mediaWhite(destination);
  return {
    inputChannels,
    outputChannels,
    convert(input, output) {
      if (input.length !== inputChannels || output.length < outputChannels) {
        throw new InvalidArgumentError('colour transform buffer dimensions differ from profile channels');
      }
      for (const value of input) if (!Number.isFinite(value)) throw new InvalidArgumentError('colour components must be finite');
      const pcsValue = fromDevice(input);
      const connected = options.intent === 'absoluteColorimetric' ? absolute(pcsValue, sourceWhite, destinationWhite) : pcsValue;
      const values = toDevice(connected);
      for (let index = 0; index < outputChannels; index++) output[index] = Math.min(1, Math.max(0, values[index] ?? 0));
    },
  };
};

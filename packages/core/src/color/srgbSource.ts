import type { IccColorSource } from './createColorTransform.ts';

import { parseIccProfile } from '../icc/iccProfile.ts';

import { SRGB2014_HEX } from './srgbProfileData.ts';

/** Returns a new copy of the International Color Consortium's sRGB2014.icc, a 3,024-byte ICC version 2 display profile for IEC 61966-2-1 sRGB, for use wherever an sRGB profile's bytes are required, such as `convertToCmyk`'s `sourceRgbProfile`. */
export const srgbProfileBytes = (): Uint8Array => {
  const bytes = new Uint8Array(SRGB2014_HEX.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(SRGB2014_HEX.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

/** Returns a colour-transform source for sRGB, parsed from a new copy of `srgbProfileBytes()`, so that `createColorTransform` converts sRGB without a caller-supplied profile. */
export const srgbColorSource = (): IccColorSource => ({ kind: 'icc', profile: parseIccProfile(srgbProfileBytes()) });

import type { ColorTransform } from '../color/createColorTransform.ts';

/** The matte a row was preblended with and the decoded soft-mask alpha of each of its pixels. */
export interface RowMatte {
  readonly values: readonly number[];
  readonly alpha: Float64Array;
}

export interface RowParameters {
  readonly width: number;
  readonly channels: number;
  readonly bits: number;
  readonly transform: ColorTransform;
  readonly decode: readonly number[] | undefined;
  readonly matte?: RowMatte | undefined;
}

export const readImageSample = (row: Uint8Array, index: number, bits: number): number => {
  if (bits === 8) return row[index] ?? 0;
  if (bits === 16) return (row[index * 2] ?? 0) * 256 + (row[index * 2 + 1] ?? 0);
  const bit = index * bits;
  const shift = 8 - bits - (bit % 8);
  return Math.floor((row[Math.floor(bit / 8)] ?? 0) / 2 ** shift) % 2 ** bits;
};

// ISO 32000-1:2008, 11.6.5.3: a preblended component is c' = m + alpha * (c - m), so c = m + (c' - m) / alpha. A pixel with alpha 0 is fully transparent and keeps its stored components.
const unblendPixel = (components: Float64Array, matte: readonly number[], alpha: number): void => {
  if (alpha <= 0) return;
  for (let channel = 0; channel < components.length; channel++) {
    const background = matte[channel] ?? 0;
    components[channel] = Math.min(1, Math.max(0, background + ((components[channel] ?? 0) - background) / alpha));
  }
};

const convertRow16 = (input: Uint8Array, parameters: RowParameters, result: Uint8Array): void => {
  const { width, channels, transform } = parameters;
  const source = new Uint16Array(width * channels);
  const converted = new Uint16Array(width * 4);
  for (let index = 0; index < source.length; index++) source[index] = readImageSample(input, index, 16);
  transform.convertRow16(source, converted, width);
  for (let index = 0; index < converted.length; index++) {
    result[index * 2] = Math.floor((converted[index] ?? 0) / 256);
    result[index * 2 + 1] = (converted[index] ?? 0) % 256;
  }
};

/** Returns a reader that decodes one pixel's components into a reused buffer. */
const pixelDecoder = (parameters: RowParameters): ((input: Uint8Array, pixel: number) => Float64Array) => {
  const { channels, bits, decode, matte } = parameters;
  const maximum = 2 ** bits - 1;
  const source = new Float64Array(channels);
  return (input, pixel) => {
    for (let channel = 0; channel < channels; channel++) {
      const value = readImageSample(input, pixel * channels + channel, bits) / maximum;
      const start = decode?.[channel * 2] ?? 0;
      const end = decode?.[channel * 2 + 1] ?? 1;
      source[channel] = start + value * (end - start);
    }
    if (matte !== undefined) unblendPixel(source, matte.values, matte.alpha[pixel] ?? 0);
    return source;
  };
};

export const convertImageRow = (input: Uint8Array, parameters: RowParameters): Uint8Array => {
  const { width, bits, transform, decode, matte } = parameters;
  const outputBits = bits === 16 ? 16 : 8;
  const result = new Uint8Array(width * 4 * (outputBits / 8));
  if (decode === undefined && matte === undefined && bits === 8) {
    transform.convertRow8(input, result, width);
    return result;
  }
  if (decode === undefined && matte === undefined && bits === 16) {
    convertRow16(input, parameters, result);
    return result;
  }
  const decodePixel = pixelDecoder(parameters);
  const converted = new Float64Array(4);
  for (let pixel = 0; pixel < width; pixel++) {
    transform.convert(decodePixel(input, pixel), converted);
    for (let channel = 0; channel < 4; channel++) {
      const value = Math.round((converted[channel] ?? 0) * (2 ** outputBits - 1));
      const index = pixel * 4 + channel;
      if (outputBits === 8) result[index] = value;
      else {
        result[index * 2] = Math.floor(value / 256);
        result[index * 2 + 1] = value % 256;
      }
    }
  }
  return result;
};

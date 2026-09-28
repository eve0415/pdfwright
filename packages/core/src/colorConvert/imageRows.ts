import type { ColorTransform } from '../color/createColorTransform.ts';

export interface RowParameters {
  readonly width: number;
  readonly channels: number;
  readonly bits: number;
  readonly transform: ColorTransform;
  readonly decode: readonly number[] | undefined;
}

export const readImageSample = (row: Uint8Array, index: number, bits: number): number => {
  if (bits === 8) return row[index] ?? 0;
  if (bits === 16) return (row[index * 2] ?? 0) * 256 + (row[index * 2 + 1] ?? 0);
  const bit = index * bits;
  const shift = 8 - bits - (bit % 8);
  return Math.floor((row[Math.floor(bit / 8)] ?? 0) / 2 ** shift) % 2 ** bits;
};

export const convertImageRow = (input: Uint8Array, parameters: RowParameters): Uint8Array => {
  const { width, channels, bits, transform, decode } = parameters;
  const outputBits = bits === 16 ? 16 : 8;
  const result = new Uint8Array(width * 4 * (outputBits / 8));
  if (decode === undefined && bits === 8) {
    transform.convertRow8(input, result, width);
    return result;
  }
  if (decode === undefined && bits === 16) {
    const source = new Uint16Array(width * channels);
    const converted = new Uint16Array(width * 4);
    for (let index = 0; index < source.length; index++) source[index] = readImageSample(input, index, 16);
    transform.convertRow16(source, converted, width);
    for (let index = 0; index < converted.length; index++) {
      result[index * 2] = Math.floor((converted[index] ?? 0) / 256);
      result[index * 2 + 1] = (converted[index] ?? 0) % 256;
    }
    return result;
  }
  const source = new Float64Array(channels);
  const converted = new Float64Array(4);
  const maximum = 2 ** bits - 1;
  for (let pixel = 0; pixel < width; pixel++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = readImageSample(input, pixel * channels + channel, bits) / maximum;
      const start = decode?.[channel * 2] ?? 0;
      const end = decode?.[channel * 2 + 1] ?? 1;
      source[channel] = start + value * (end - start);
    }
    transform.convert(source, converted);
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

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

export interface RowConverters {
  readonly convertRow8: (input: Uint8Array, output: Uint8Array, pixels: number) => void;
  readonly convertRow16: (input: Uint16Array, output: Uint16Array, pixels: number) => void;
}

const cacheSlot = (red: number, green: number, blue: number): number => (red * 251 + green * 17 + blue) % 65536;
const cacheKey = (red: number, green: number, blue: number): number => red * 65536 + green * 256 + blue;

export const createRowConverters = (
  convert: (input: Float64Array, output: Float64Array) => void,
  inputChannels: number,
  outputChannels: number,
): RowConverters => {
  const inputPixel = new Float64Array(inputChannels);
  const outputPixel = new Float64Array(outputChannels);
  // A direct-mapped RGB8→CMYK8 cache uses 65,536 keys and 65,536 packed outputs, 512 KiB total.
  const keys = inputChannels === 3 && outputChannels === 4 ? new Uint32Array(65536) : undefined;
  const packed = keys === undefined ? undefined : new Uint32Array(65536);
  keys?.fill(0xffffffff);

  const validate = (inputLength: number, outputLength: number, pixels: number): void => {
    if (!Number.isSafeInteger(pixels) || pixels < 0 || pixels * inputChannels > inputLength || pixels * outputChannels > outputLength) {
      throw new InvalidArgumentError('colour row buffers do not hold the requested pixels');
    }
  };

  const lookup = (red: number, green: number, blue: number): number | undefined => {
    if (keys === undefined || packed === undefined) return undefined;
    const slot = cacheSlot(red, green, blue);
    return keys[slot] === cacheKey(red, green, blue) ? packed[slot] : undefined;
  };
  const remember = (key: number, slot: number, value: number): void => {
    if (keys === undefined || packed === undefined) return;
    keys[slot] = key;
    packed[slot] = value;
  };

  return {
    convertRow8(input, output, pixels) {
      validate(input.length, output.length, pixels);
      for (let pixel = 0; pixel < pixels; pixel++) {
        const source = pixel * inputChannels;
        const destination = pixel * outputChannels;
        const red = input[source] ?? 0;
        const green = input[source + 1] ?? 0;
        const blue = input[source + 2] ?? 0;
        const cached = lookup(red, green, blue);
        if (cached !== undefined) {
          output[destination] = Math.floor(cached / 16777216) % 256;
          output[destination + 1] = Math.floor(cached / 65536) % 256;
          output[destination + 2] = Math.floor(cached / 256) % 256;
          output[destination + 3] = cached % 256;
          continue;
        }
        for (let channel = 0; channel < inputChannels; channel++) inputPixel[channel] = (input[source + channel] ?? 0) / 255;
        convert(inputPixel, outputPixel);
        for (let channel = 0; channel < outputChannels; channel++) output[destination + channel] = Math.round((outputPixel[channel] ?? 0) * 255);
        const value =
          (output[destination] ?? 0) * 16777216 +
          (output[destination + 1] ?? 0) * 65536 +
          (output[destination + 2] ?? 0) * 256 +
          (output[destination + 3] ?? 0);
        remember(cacheKey(red, green, blue), cacheSlot(red, green, blue), value);
      }
    },
    convertRow16(input, output, pixels) {
      validate(input.length, output.length, pixels);
      for (let pixel = 0; pixel < pixels; pixel++) {
        const source = pixel * inputChannels;
        const destination = pixel * outputChannels;
        for (let channel = 0; channel < inputChannels; channel++) inputPixel[channel] = (input[source + channel] ?? 0) / 65535;
        convert(inputPixel, outputPixel);
        for (let channel = 0; channel < outputChannels; channel++) output[destination + channel] = Math.round((outputPixel[channel] ?? 0) * 65535);
      }
    },
  };
};

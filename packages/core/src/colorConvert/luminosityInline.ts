import type { InlineImage } from '../content/contentOperations.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName } from '../object/pdfObject.ts';

import { readImageSample } from './imageRows.ts';

const parameters = (image: InlineImage): Map<string, PdfDirectObject> => {
  const values = new Map<string, PdfDirectObject>();
  if (image.parameters.length % 2 !== 0) throw new ValidationError('luminosity inline image parameters are unpaired', 'color-space');
  for (let index = 0; index < image.parameters.length; index += 2) {
    const key = image.parameters[index];
    const value = image.parameters[index + 1];
    if (key?.kind !== 'name' || value === undefined || value.kind === 'stray-delimiter') {
      throw new ValidationError('luminosity inline image parameter is malformed', 'color-space');
    }
    values.set(new TextDecoder('latin1').decode(key.bytes), value);
  }
  return values;
};

const integer = (value: PdfDirectObject | undefined, name: string): number => {
  if (value?.kind !== 'integer' || !Number.isSafeInteger(value.value) || value.value < 1) {
    throw new ValidationError(`luminosity inline image ${name} is invalid`, 'color-space');
  }
  return value.value;
};

const isRgb = (entries: ReadonlyMap<string, PdfDirectObject>): boolean => {
  const color = entries.get('CS') ?? entries.get('ColorSpace');
  if (color?.kind !== 'name') throw new ValidationError('luminosity inline image ColorSpace is missing', 'color-space');
  const name = new TextDecoder('latin1').decode(color.bytes);
  if (name === 'G' || name === 'DeviceGray') return false;
  if (name === 'RGB' || name === 'DeviceRGB') return true;
  throw new UnsupportedFeatureError('luminosity inline image colour space is unsupported');
};

const decodeValues = (value: PdfDirectObject | undefined): readonly number[] => {
  if (value === undefined) return [0, 1, 0, 1, 0, 1];
  if (value.kind !== 'array' || value.items.length !== 6) throw new ValidationError('luminosity inline image Decode is invalid', 'color-space');
  return value.items.map(item => {
    if ((item.kind !== 'integer' && item.kind !== 'real') || typeof item.value !== 'number') {
      throw new ValidationError('luminosity inline image Decode is invalid', 'color-space');
    }
    return item.value;
  });
};

const graySamples = (config: {
  data: Uint8Array;
  width: number;
  height: number;
  bits: number;
  outputBits: number;
  decode: readonly number[];
  gray: (values: readonly number[]) => number;
}): Uint8Array => {
  const { data, width, height, bits, outputBits, decode, gray } = config;
  const inputRowBytes = Math.ceil((width * 3 * bits) / 8);
  const outputRowBytes = width * (outputBits / 8);
  const output = new Uint8Array(outputRowBytes * height);
  const inputMaximum = 2 ** bits - 1;
  const outputMaximum = 2 ** outputBits - 1;
  for (let row = 0; row < height; row++) {
    const input = data.subarray(row * inputRowBytes, (row + 1) * inputRowBytes);
    for (let pixel = 0; pixel < width; pixel++) {
      const rgb = Array.from({ length: 3 }, (_, channel) => {
        const raw = readImageSample(input, pixel * 3 + channel, bits) / inputMaximum;
        const low = decode[channel * 2] ?? 0;
        const high = decode[channel * 2 + 1] ?? 1;
        return low + raw * (high - low);
      });
      const luminance = Math.min(1, Math.max(0, gray(rgb)));
      const sample = Math.round(luminance * outputMaximum);
      const offset = row * outputRowBytes + pixel * (outputBits / 8);
      if (outputBits === 8) output[offset] = sample;
      else {
        output[offset] = Math.floor(sample / 256);
        output[offset + 1] = sample % 256;
      }
    }
  }
  return output;
};

/** ISO 32000-1:2008, 8.9.7 Table 93 gives inline image entries the same meanings as image dictionary entries. */
export const grayInlineImage = (image: InlineImage, gray: (values: readonly number[]) => number, maxDecodedBytes: number): Uint8Array | null => {
  const entries = parameters(image);
  if (!isRgb(entries)) return null;
  const width = integer(entries.get('W') ?? entries.get('Width'), 'Width');
  const height = integer(entries.get('H') ?? entries.get('Height'), 'Height');
  const bits = integer(entries.get('BPC') ?? entries.get('BitsPerComponent'), 'BitsPerComponent');
  if (![1, 2, 4, 8, 16].includes(bits)) throw new UnsupportedFeatureError('luminosity inline image bit depth is unsupported');
  const outputBits = bits === 16 ? 16 : 8;
  const inputRowBytes = Math.ceil((width * 3 * bits) / 8);
  const outputRowBytes = width * (outputBits / 8);
  if (!Number.isSafeInteger((inputRowBytes + outputRowBytes) * height) || (inputRowBytes + outputRowBytes) * height > maxDecodedBytes) {
    throw new ResourceLimitError('luminosity inline image exceeds maxDecodedBytes');
  }
  const filter = entries.get('F') ?? entries.get('Filter');
  const parms = entries.get('DP') ?? entries.get('DecodeParms');
  const dictionary = new PdfDictionaryEntries();
  if (filter !== undefined) dictionary.set(pdfName('Filter').bytes, filter);
  if (parms !== undefined) dictionary.set(pdfName('DecodeParms').bytes, parms);
  const data = decodeStream(
    { kind: 'stream', dictionary, data: image.data },
    {
      maxDecodedBytes,
      warn: () => {
        throw new ValidationError('luminosity inline image has a decoder warning', 'color-space');
      },
    },
  );
  if (data.length !== inputRowBytes * height) throw new ValidationError('luminosity inline image sample count is invalid', 'color-space');
  const decode = decodeValues(entries.get('D') ?? entries.get('Decode'));
  const output = graySamples({ data, width, height, bits, outputBits, decode, gray });
  const writer = new ByteWriter();
  writer.writeAscii(`BI /W ${String(width)} /H ${String(height)} /BPC ${String(outputBits)} /CS /G /F /Fl ID\n`);
  writer.writeBytes(deflateZlib(output));
  writer.writeAscii('\nEI');
  return writer.toUint8Array();
};

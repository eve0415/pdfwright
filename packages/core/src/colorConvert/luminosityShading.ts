import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName, pdfReal } from '../object/pdfObject.ts';

const FUNCTION = pdfName('Function').bytes;
const DOMAIN = pdfName('Domain').bytes;
const SHADING_TYPE = pdfName('ShadingType').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const BACKGROUND = pdfName('Background').bytes;

export interface GrayFunctionShading {
  readonly dictionary: PdfDictionaryEntries;
  readonly functionStream: PdfStream;
}

const numeric = (value: PdfDirectObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real' && typeof value.value === 'number') return value.value;
  throw new ValidationError('luminosity shading number is invalid', 'color-space');
};

const domain = (dictionary: PdfDictionaryEntries, dimensions: number): number[] => {
  const value = dictionary.get(DOMAIN);
  if (value === undefined) return Array.from({ length: dimensions }, () => [0, 1]).flat();
  if (value.kind !== 'array' || value.items.length !== dimensions * 2) throw new ValidationError('luminosity shading Domain is invalid', 'color-space');
  return value.items.map(item => numeric(item));
};

const resolvedFunction = (internals: DocumentInternals, value: PdfDirectObject): PdfObject => {
  const object = internals.objects.deref(value);
  if (object === undefined) throw new ValidationError('luminosity shading function is missing', 'color-space');
  if (object.kind !== 'stream') return object;
  const data = decodedData(internals, object);
  if (typeof data === 'string') throw new ValidationError(`luminosity shading function cannot be decoded: ${data}`, 'color-space');
  return { kind: 'stream', dictionary: object.dictionary, data };
};

const evaluator = (internals: DocumentInternals, value: PdfDirectObject): PdfFunction => {
  if (value.kind !== 'array') return createPdfFunction(resolvedFunction(internals, value), child => resolvedFunction(internals, child));
  if (value.items.length !== 3) throw new ValidationError('luminosity shading Function array must have three entries', 'color-space');
  const children = value.items.map(item => createPdfFunction(resolvedFunction(internals, item), child => resolvedFunction(internals, child)));
  return input => children.map(child => child(input)[0] ?? 0);
};

const sampleGray = (config: {
  internals: DocumentInternals;
  functionValue: PdfDirectObject;
  domain: readonly number[];
  dimensions: number;
  gray: (values: readonly number[]) => number;
}): PdfStream => {
  const { internals, functionValue, dimensions, gray } = config;
  const grid = dimensions === 1 ? 256 : 65;
  const count = grid ** dimensions;
  if (count > 100_000) throw new ResourceLimitError('luminosity shading sampling exceeds the function limit');
  const evaluate = evaluator(internals, functionValue);
  const writer = new ByteWriter();
  for (let index = 0; index < count; index++) {
    const input = Array.from({ length: dimensions }, (_, axis) => {
      const low = config.domain[axis * 2] ?? 0;
      const high = config.domain[axis * 2 + 1] ?? 1;
      return low + ((Math.floor(index / grid ** axis) % grid) / (grid - 1)) * (high - low);
    });
    const rgb = evaluate(input);
    const luminance = Math.min(1, Math.max(0, gray(rgb)));
    const sample = Math.round(luminance * 65535);
    writer.writeByte(Math.floor(sample / 256));
    writer.writeByte(sample % 256);
  }
  const dictionary = new PdfDictionaryEntries([
    // ISO 32000-1:2008, 7.10.2 Table 39: Size and BitsPerSample describe the sampled function grid.
    [pdfName('FunctionType').bytes, pdfInteger(0)],
    [DOMAIN, pdfArray(config.domain.map(value => pdfReal(value)))],
    [pdfName('Range').bytes, pdfArray([pdfInteger(0), pdfInteger(1)])],
    [pdfName('Size').bytes, pdfArray(Array.from({ length: dimensions }, () => pdfInteger(grid)))],
    [pdfName('BitsPerSample').bytes, pdfInteger(16)],
    [pdfName('Order').bytes, pdfInteger(1)],
    [pdfName('Filter').bytes, pdfName('FlateDecode')],
  ]);
  return { kind: 'stream', dictionary, data: deflateZlib(writer.toUint8Array()) };
};

export const grayFunctionShading = (internals: DocumentInternals, shading: PdfObject, gray: (values: readonly number[]) => number): GrayFunctionShading => {
  if (shading.kind !== 'dictionary') throw new UnsupportedFeatureError('luminosity mesh shading is unsupported');
  const type = shading.entries.get(SHADING_TYPE);
  if (type?.kind !== 'integer' || type.value < 1 || type.value > 3) throw new UnsupportedFeatureError('luminosity shading type is unsupported');
  const functionValue = shading.entries.get(FUNCTION);
  if (functionValue === undefined) throw new ValidationError('luminosity shading Function is missing', 'color-space');
  const dimensions = type.value === 1 ? 2 : 1;
  const sampled = sampleGray({ internals, functionValue, dimensions, domain: domain(shading.entries, dimensions), gray });
  const dictionary = new PdfDictionaryEntries(shading.entries.entries());
  dictionary.set(COLOR_SPACE, pdfName('DeviceGray'));
  const background = dictionary.get(BACKGROUND);
  if (background !== undefined) {
    if (background.kind !== 'array' || background.items.length !== 3) throw new ValidationError('luminosity shading Background is invalid', 'color-space');
    const components = background.items.map(item => numeric(item));
    const luminance = gray(components);
    dictionary.set(BACKGROUND, pdfArray([pdfReal(luminance)]));
  }
  return { dictionary, functionStream: sampled };
};

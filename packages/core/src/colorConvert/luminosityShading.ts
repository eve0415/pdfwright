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

import { convertMeshSamples } from './meshSamples.ts';

const FUNCTION = pdfName('Function').bytes;
const DOMAIN = pdfName('Domain').bytes;
const SHADING_TYPE = pdfName('ShadingType').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const BACKGROUND = pdfName('Background').bytes;
const BITS_PER_COORDINATE = pdfName('BitsPerCoordinate').bytes;
const BITS_PER_COMPONENT = pdfName('BitsPerComponent').bytes;
const BITS_PER_FLAG = pdfName('BitsPerFlag').bytes;
const DECODE = pdfName('Decode').bytes;
const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;

export interface GrayFunctionShading {
  readonly dictionary: PdfDictionaryEntries;
  readonly functionPlan: GrayFunctionPlan | undefined;
  readonly data: Uint8Array | undefined;
}

export type GrayFunctionPlan =
  | { readonly kind: 'sampled'; readonly stream: PdfStream }
  | { readonly kind: 'stitched'; readonly dictionary: PdfDictionaryEntries; readonly children: readonly GrayFunctionPlan[] };

const numeric = (value: PdfDirectObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real' && typeof value.value === 'number') return value.value;
  throw new ValidationError('luminosity shading number is invalid', 'color-space');
};

const integer = (dictionary: PdfDictionaryEntries, key: Uint8Array): number => {
  const value = dictionary.get(key);
  if (value?.kind !== 'integer' || !Number.isSafeInteger(value.value)) throw new ValidationError('luminosity mesh bit width is invalid', 'color-space');
  return value.value;
};

const decodeArray = (dictionary: PdfDictionaryEntries, count: number): number[] => {
  const value = dictionary.get(DECODE);
  if (value?.kind !== 'array' || value.items.length !== count) throw new ValidationError('luminosity mesh Decode is invalid', 'color-space');
  return value.items.map(item => numeric(item));
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

const entriesOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  if (value?.kind === 'stream') return value.dictionary;
  return undefined;
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

const grayFunction = (
  internals: DocumentInternals,
  config: { value: PdfDirectObject; domain: readonly number[]; dimensions: number; gray: (values: readonly number[]) => number; depth: number },
): GrayFunctionPlan => {
  if (config.depth > internals.maxNesting) throw new ResourceLimitError('luminosity function nesting exceeds maxNesting');
  const source = config.value.kind === 'array' ? undefined : resolvedFunction(internals, config.value);
  const dictionary = entriesOf(source);
  const type = dictionary?.get(pdfName('FunctionType').bytes);
  if (type?.kind === 'integer' && type.value === 3 && config.dimensions === 1 && dictionary !== undefined) {
    const functions = dictionary.get(pdfName('Functions').bytes);
    if (functions?.kind !== 'array' || functions.items.length === 0) throw new ValidationError('luminosity stitching function has no children', 'color-space');
    const children = functions.items.map(value => {
      const child = resolvedFunction(internals, value);
      const entries = entriesOf(child);
      if (entries === undefined) throw new ValidationError('luminosity stitching child is invalid', 'color-space');
      return grayFunction(internals, { value, domain: domain(entries, 1), dimensions: 1, gray: config.gray, depth: config.depth + 1 });
    });
    const mapped = new PdfDictionaryEntries(dictionary.entries());
    // ISO 32000-1:2008, 7.10.4 Table 41: Bounds and Encode continue to select the stitched subfunctions.
    mapped.set(pdfName('Range').bytes, pdfArray([pdfInteger(0), pdfInteger(1)]));
    return { kind: 'stitched', dictionary: mapped, children };
  }
  return {
    kind: 'sampled',
    stream: sampleGray({ internals, functionValue: config.value, dimensions: config.dimensions, domain: config.domain, gray: config.gray }),
  };
};

const grayMesh = (
  internals: DocumentInternals,
  config: { shading: PdfStream; dictionary: PdfDictionaryEntries; gray: (values: readonly number[]) => number; type: 4 | 5 | 6 | 7 },
): GrayFunctionShading => {
  const { shading, dictionary, gray, type } = config;
  const functionValue = dictionary.get(FUNCTION);
  dictionary.set(COLOR_SPACE, pdfName('DeviceGray'));
  if (functionValue !== undefined) {
    const decode = decodeArray(dictionary, 6);
    const functionPlan = grayFunction(internals, { value: functionValue, dimensions: 1, domain: decode.slice(4, 6), gray, depth: 0 });
    return { dictionary, functionPlan, data: shading.data };
  }
  // ISO 32000-1:2008, 8.7.4.5.5 Table 82: mesh Decode starts with two coordinate pairs, followed by one pair per colour component.
  const coordinateBits = integer(dictionary, BITS_PER_COORDINATE);
  const componentBits = integer(dictionary, BITS_PER_COMPONENT);
  const flagBits = type === 5 ? 0 : integer(dictionary, BITS_PER_FLAG);
  if (
    ![1, 2, 4, 8, 12, 16, 24, 32].includes(coordinateBits) ||
    ![1, 2, 4, 8, 12, 16].includes(componentBits) ||
    (type !== 5 && ![2, 4, 8].includes(flagBits))
  ) {
    throw new ValidationError('luminosity mesh bit widths are invalid', 'color-space');
  }
  const decode = decodeArray(dictionary, 10);
  const data = decodedData(internals, shading);
  if (typeof data === 'string') throw new ValidationError(`luminosity mesh cannot be decoded: ${data}`, 'color-space');
  const outputBits = Math.max(8, componentBits);
  const converted = convertMeshSamples(data, {
    type,
    coordinateBits,
    componentBits,
    outputComponentBits: outputBits,
    flagBits,
    channels: 3,
    outputChannels: 1,
    decode,
    transform: {
      convert: (input, output) => {
        output[0] = gray([...input]);
      },
    },
    maxBytes: internals.maxDecodedBytes,
  });
  dictionary.set(DECODE, pdfArray([...decode.slice(0, 4), 0, 1].map(value => pdfReal(value))));
  dictionary.set(BITS_PER_COMPONENT, pdfInteger(outputBits));
  dictionary.set(FILTER, pdfName('FlateDecode'));
  dictionary.delete(DECODE_PARMS);
  return { dictionary, functionPlan: undefined, data: deflateZlib(converted.data) };
};

const meshKind = (value: number): 4 | 5 | 6 | 7 => {
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  return 7;
};

export const grayFunctionShading = (internals: DocumentInternals, shading: PdfObject, gray: (values: readonly number[]) => number): GrayFunctionShading => {
  const entries = entriesOf(shading);
  if (entries === undefined) throw new ValidationError('luminosity shading is invalid', 'color-space');
  const type = entries.get(SHADING_TYPE);
  if (type?.kind !== 'integer' || type.value < 1 || type.value > 7) throw new UnsupportedFeatureError('luminosity shading type is unsupported');
  const dictionary = new PdfDictionaryEntries(entries.entries());
  dictionary.set(COLOR_SPACE, pdfName('DeviceGray'));
  const background = dictionary.get(BACKGROUND);
  if (background !== undefined) {
    if (background.kind !== 'array' || background.items.length !== 3) throw new ValidationError('luminosity shading Background is invalid', 'color-space');
    const components = background.items.map(item => numeric(item));
    const luminance = gray(components);
    dictionary.set(BACKGROUND, pdfArray([pdfReal(luminance)]));
  }
  if (type.value >= 4) {
    if (shading.kind !== 'stream') throw new ValidationError('luminosity mesh shading is not a stream', 'color-space');
    return grayMesh(internals, { shading, dictionary, gray, type: meshKind(type.value) });
  }
  if (shading.kind !== 'dictionary') throw new ValidationError('luminosity function shading is not a dictionary', 'color-space');
  const functionValue = dictionary.get(FUNCTION);
  if (functionValue === undefined) throw new ValidationError('luminosity shading Function is missing', 'color-space');
  const dimensions = type.value === 1 ? 2 : 1;
  const functionPlan = grayFunction(internals, { value: functionValue, dimensions, domain: domain(dictionary, dimensions), gray, depth: 0 });
  return { dictionary, functionPlan, data: undefined };
};

import type { InlineImage } from '../content/contentOperations.ts';
import type { StreamProducer } from '../document/editedObjects.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { createDeflateStream, deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { decodeJpeg } from '../jpeg/decodeJpeg.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { convertIndexedColorSpace } from './convertIndexed.ts';
import { convertImageRow } from './imageRows.ts';
import { resolveSourceSpace } from './sourceSpace.ts';

export interface ConvertedInlineImage {
  readonly replacement: string;
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly data: Uint8Array;
  readonly asXObject: boolean;
  readonly keptProfile?: Uint8Array;
  readonly keptFilter?: PdfDirectObject | undefined;
  readonly keptDecodeParms?: PdfDirectObject | undefined;
  readonly produce?: StreamProducer;
}

interface InlineConfig {
  readonly document: LoadedDocument;
  readonly image: InlineImage;
  readonly resources: PdfDictionaryEntries;
  readonly options: RewriteColorOptions;
  readonly intent: RenderingIntent;
  readonly xObjectName: string;
}

interface InlineGeometry {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly inputRow: number;
  readonly outputBits: number;
}

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const parameters = (image: InlineImage): Map<string, PdfDirectObject> => {
  // ISO 32000-1:2008, 8.9.7, Table 93: inline image keys have the meanings of image dictionary keys and may use the listed abbreviations.
  const values = new Map<string, PdfDirectObject>();
  if (image.parameters.length % 2 !== 0) return invalid('inline image parameters are unpaired');
  for (let index = 0; index < image.parameters.length; index += 2) {
    const key = image.parameters[index];
    const value = image.parameters[index + 1];
    if (key?.kind !== 'name' || value === undefined || value.kind === 'stray-delimiter') return invalid('inline image parameter is malformed');
    values.set(new TextDecoder('latin1').decode(key.bytes), value);
  }
  return values;
};

const number = (value: PdfDirectObject | undefined, name: string): number => {
  if (value?.kind !== 'integer' || !Number.isSafeInteger(value.value) || value.value < 1) return invalid(`inline image ${name} is invalid`);
  return value.value;
};

const decodeValues = (value: PdfDirectObject | undefined): number[] | undefined => {
  if (value === undefined) return undefined;
  if (value.kind !== 'array' || value.items.length !== 6) return invalid('inline RGB image Decode array is invalid');
  const values: number[] = [];
  for (const item of value.items) {
    if ((item.kind !== 'integer' && item.kind !== 'real') || typeof item.value !== 'number') return invalid('inline RGB image Decode entry is invalid');
    values.push(item.value);
  }
  return values;
};

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const filterDictionary = (values: ReadonlyMap<string, PdfDirectObject>): PdfDictionaryEntries => {
  const dictionary = new PdfDictionaryEntries();
  const filter = values.get('F') ?? values.get('Filter');
  const decodeParameters = values.get('DP') ?? values.get('DecodeParms');
  if (filter !== undefined) dictionary.set(pdfName('Filter').bytes, filter);
  if (decodeParameters !== undefined) dictionary.set(pdfName('DecodeParms').bytes, decodeParameters);
  return dictionary;
};

const geometry = (values: ReadonlyMap<string, PdfDirectObject>, ceiling: number): InlineGeometry => {
  const width = number(values.get('W') ?? values.get('Width'), 'Width');
  const height = number(values.get('H') ?? values.get('Height'), 'Height');
  const bits = number(values.get('BPC') ?? values.get('BitsPerComponent'), 'BitsPerComponent');
  if (![1, 2, 4, 8, 16].includes(bits)) return invalid('inline RGB image bit depth is unsupported');
  const inputRow = Math.ceil((width * 3 * bits) / 8);
  const outputBits = bits === 16 ? 16 : 8;
  const outputRow = width * 4 * (outputBits / 8);
  if (!Number.isSafeInteger((inputRow + outputRow) * height) || (inputRow + outputRow) * height > ceiling) {
    throw new ResourceLimitError(`inline RGB image conversion exceeds the in-memory ceiling (${String(ceiling)} decoded bytes)`);
  }
  return { width, height, bits, inputRow, outputBits };
};

const indexedImage = (config: InlineConfig, values: ReadonlyMap<string, PdfDirectObject>, color: PdfDirectObject): ConvertedInlineImage | undefined => {
  const converted = convertIndexedColorSpace({ document: config.document, resources: config.resources, options: config.options }, color);
  if (converted === undefined) return undefined;
  const width = number(values.get('W') ?? values.get('Width'), 'Width');
  const height = number(values.get('H') ?? values.get('Height'), 'Height');
  const bits = number(values.get('BPC') ?? values.get('BitsPerComponent'), 'BitsPerComponent');
  const tokens: string[] = [];
  for (let index = 0; index < config.image.parameters.length; index += 2) {
    const key = config.image.parameters[index];
    const value = config.image.parameters[index + 1];
    if (key?.kind !== 'name' || value === undefined || value.kind === 'stray-delimiter') return invalid('inline Indexed parameters are malformed');
    const name = new TextDecoder('latin1').decode(key.bytes);
    const entry = name === 'CS' || name === 'ColorSpace' ? converted : value;
    tokens.push(latin1(serializeObject(key, { fractionDigits: 5 })), latin1(serializeObject(entry, { fractionDigits: 5 })));
  }
  return { replacement: `BI ${tokens.join(' ')} ID\n${latin1(config.image.data)}\nEI`, width, height, bits, data: config.image.data, asXObject: false };
};

const inlineColorTransform = (values: ReadonlyMap<string, PdfDirectObject>): 0 | 1 | undefined => {
  const decodeParameters = values.get('DP') ?? values.get('DecodeParms');
  const dictionary = decodeParameters?.kind === 'array' ? decodeParameters.items[0] : decodeParameters;
  if (dictionary === undefined || dictionary.kind === 'null') return undefined;
  if (dictionary.kind !== 'dictionary') return invalid('inline JPEG DecodeParms must be a dictionary');
  const value = dictionary.entries.get(pdfName('ColorTransform').bytes);
  if (value === undefined) return undefined;
  if (value.kind !== 'integer' || (value.value !== 0 && value.value !== 1)) return invalid('inline JPEG ColorTransform must be 0 or 1');
  return value.value;
};

const transcodeCompressedInline = (config: InlineConfig, values: ReadonlyMap<string, PdfDirectObject>): ConvertedInlineImage => {
  const { document, image, resources, options } = config;
  const width = number(values.get('W') ?? values.get('Width'), 'Width');
  const height = number(values.get('H') ?? values.get('Height'), 'Height');
  const bits = number(values.get('BPC') ?? values.get('BitsPerComponent'), 'BitsPerComponent');
  if (bits !== 8) return invalid('inline JPEG BitsPerComponent must be 8');
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const maxRowBytes = Math.min(internals.maxDecodedBytes, 4 * 1024 * 1024);
  const colorTransform = inlineColorTransform(values);
  // ISO 32000-1:2008, 7.4.8, Table 13: APP14 overrides an inline image's DecodeParms ColorTransform.
  const { maxDecodedBytes } = internals;
  const jpeg = decodeJpeg(image.data, colorTransform === undefined ? { maxRowBytes, maxDecodedBytes } : { maxRowBytes, maxDecodedBytes, colorTransform });
  if (jpeg.components !== 3 || jpeg.width !== width || jpeg.height !== height) return invalid('inline JPEG frame geometry differs from its dictionary');
  for (const row of jpeg.rows()) void row;
  const space = resolveSourceSpace(document, pdfName('DeviceRGB'), { resources, sourceRgbProfile: options.sourceRgbProfile });
  if (space.kind !== 'rgb') return invalid('DefaultRGB is not RGB');
  const intent = options.intent === undefined || options.intent === 'document' ? config.intent : options.intent;
  const decode = decodeValues(values.get('D') ?? values.get('Decode'));
  const produce: StreamProducer = function* () {
    const transform = createColorTransform(space.source, options.outputProfile, {
      intent,
      blackPointCompensation: options.blackPointCompensation !== false,
      lut8LabEncoding: options.lut8LabEncoding ?? 'icc',
    });
    const deflater = createDeflateStream();
    for (const row of jpeg.rows()) yield* deflater.push(convertImageRow(row, { width, channels: 3, bits: 8, transform, decode }));
    yield deflater.finish();
  };
  return { replacement: `/${config.xObjectName} Do`, width, height, bits: 8, data: new Uint8Array(), asXObject: true, produce };
};

const compressedImage = (config: InlineConfig, values: ReadonlyMap<string, PdfDirectObject>): ConvertedInlineImage | undefined => {
  const { document, image, resources, options } = config;
  const filter = values.get('F') ?? values.get('Filter');
  let filters: readonly PdfDirectObject[] = [];
  if (filter?.kind === 'array') filters = filter.items;
  else if (filter !== undefined) filters = [filter];
  const compressed = filters.find(item => item.kind === 'name' && ['DCT', 'DCTDecode', 'JPXDecode'].includes(latin1(item.bytes)));
  if (compressed?.kind !== 'name') return undefined;
  if (options.compressedRgbImages === 'refuse') {
    throw new UnsupportedFeatureError('compressed RGB inline image conversion is unavailable', 'compressed-rgb-image');
  }
  if (options.compressedRgbImages === 'transcode') {
    const name = latin1(compressed.bytes);
    if (filters.length !== 1 || (name !== 'DCT' && name !== 'DCTDecode')) {
      throw new UnsupportedFeatureError('only a single DCTDecode inline filter can be transcoded', 'compressed-rgb-image');
    }
    return transcodeCompressedInline(config, values);
  }
  const space = resolveSourceSpace(document, pdfName('DeviceRGB'), { resources, sourceRgbProfile: options.sourceRgbProfile });
  if (space.kind !== 'rgb' || space.source.kind !== 'icc') {
    throw new UnsupportedFeatureError('compressed RGB inline image has no ICC profile to keep', 'compressed-rgb-image');
  }
  const width = number(values.get('W') ?? values.get('Width'), 'Width');
  const height = number(values.get('H') ?? values.get('Height'), 'Height');
  const bits = number(values.get('BPC') ?? values.get('BitsPerComponent'), 'BitsPerComponent');
  const aliases = new Map([
    ['AHx', 'ASCIIHexDecode'],
    ['A85', 'ASCII85Decode'],
    ['LZW', 'LZWDecode'],
    ['Fl', 'FlateDecode'],
    ['RL', 'RunLengthDecode'],
    ['CCF', 'CCITTFaxDecode'],
    ['DCT', 'DCTDecode'],
  ]);
  const expanded = filters.map(item => {
    if (item.kind !== 'name') return invalid('compressed inline image Filter must contain names');
    const name = latin1(item.bytes);
    return pdfName(aliases.get(name) ?? name);
  });
  const keptFilter = expanded.length === 1 ? expanded[0] : pdfArray(expanded);
  return {
    replacement: `/${config.xObjectName} Do`,
    width,
    height,
    bits,
    data: image.data,
    asXObject: true,
    keptProfile: space.source.profile.bytes,
    keptFilter,
    keptDecodeParms: values.get('DP') ?? values.get('DecodeParms'),
  };
};

/** Converts an inline image using its current graphics-state intent and the same row evaluator as image XObjects. */
export const convertInlineImage = (config: InlineConfig): ConvertedInlineImage | undefined => {
  const { document, image, resources, options } = config;
  const values = parameters(image);
  const color = values.get('CS') ?? values.get('ColorSpace');
  if (color?.kind === 'array') return indexedImage(config, values, color);
  if (color === undefined) return invalid('inline image ColorSpace is missing');
  if (color.kind !== 'name') return undefined;
  const family = new TextDecoder('latin1').decode(color.bytes);
  if (family !== 'RGB' && family !== 'DeviceRGB') return undefined;
  const kept = compressedImage(config, values);
  if (kept !== undefined) return kept;
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const ceiling = Math.min(internals.maxDecodedBytes, 4 * 1024 * 1024);
  const { width, height, bits, inputRow, outputBits } = geometry(values, ceiling);
  const data = decodedData(internals, { kind: 'stream', dictionary: filterDictionary(values), data: image.data });
  if (typeof data === 'string') return invalid(`inline image cannot be decoded: ${data}`);
  if (data.length !== inputRow * height) return invalid('inline image data length does not match its dimensions');
  const space = resolveSourceSpace(document, pdfName('DeviceRGB'), { resources, sourceRgbProfile: options.sourceRgbProfile });
  if (space.kind !== 'rgb') return invalid('DefaultRGB is not RGB');
  const intent = options.intent === undefined || options.intent === 'document' ? config.intent : options.intent;
  const transform = createColorTransform(space.source, options.outputProfile, {
    intent,
    blackPointCompensation: options.blackPointCompensation !== false,
    lut8LabEncoding: options.lut8LabEncoding ?? 'icc',
  });
  const decode = decodeValues(values.get('D') ?? values.get('Decode'));
  const writer = new ByteWriter();
  for (let row = 0; row < height; row++) {
    writer.writeBytes(convertImageRow(data.subarray(row * inputRow, (row + 1) * inputRow), { width, channels: 3, bits, transform, decode }));
  }
  const output = writer.toUint8Array();
  const compressed = deflateZlib(output);
  const asXObject = output.length > 4096;
  const replacement = asXObject
    ? `/${config.xObjectName} Do`
    : `BI /W ${String(width)} /H ${String(height)} /BPC ${String(outputBits)} /CS /CMYK /F /Fl ID\n${latin1(compressed)}\nEI`;
  return { replacement, width, height, bits: outputBits, data: compressed, asXObject };
};

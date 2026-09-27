import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { PredictorParameters } from './predictor.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pdfName } from '../object/pdfObject.ts';

import { decodeAscii85 } from './ascii85.ts';
import { decodeAsciiHex } from './asciiHex.ts';
import { decodeLzw } from './lzw.ts';
import { undoPredictor } from './predictor.ts';
import { decodeRunLength } from './runLength.ts';

export interface DecodeContext {
  /** Largest decoded size accepted, in bytes; larger output throws ResourceLimitError. */
  readonly maxDecodedBytes: number;
  readonly warn: (warning: LoadWarning) => void;
  /** Follows indirect references in Filter and DecodeParms; without it they must be direct. */
  readonly deref?: (value: PdfDirectObject | undefined) => PdfObject | undefined;
}

type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
// ISO 32000-1:2008, Table 94 gives the abbreviations for inline images; readers accept them in stream dictionaries too.
const NAMES: ReadonlyMap<string, string> = new Map([
  ['AHx', 'ASCIIHexDecode'],
  ['A85', 'ASCII85Decode'],
  ['LZW', 'LZWDecode'],
  ['Fl', 'FlateDecode'],
  ['RL', 'RunLengthDecode'],
  ['CCF', 'CCITTFaxDecode'],
  ['DCT', 'DCTDecode'],
]);

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const asList = (value: PdfDirectObject | undefined, context: DecodeContext): (PdfObject | undefined)[] => {
  const deref = context.deref ?? ((item: PdfDirectObject | undefined): PdfObject | undefined => item);
  const resolved = deref(value);
  if (resolved === undefined || resolved.kind === 'null') return [];
  return resolved.kind === 'array' ? resolved.items.map(item => deref(item)) : [resolved];
};

const integerParameter = (parameters: PdfDictionaryEntries | undefined, key: string, fallback: number): number => {
  const value = parameters?.get(pdfName(key).bytes);
  if (value === undefined) return fallback;
  if (value.kind !== 'integer') throw new ParseError(`the decode parameter ${key} is not an integer`, 0);
  return value.value;
};

// ISO 32000-1:2008, 7.4.4.3, Table 8: Predictor defaults to 1, Colors to 1, BitsPerComponent to 8 and Columns to 1.
const predictorParameters = (parameters: PdfDictionaryEntries | undefined): PredictorParameters => ({
  predictor: integerParameter(parameters, 'Predictor', 1),
  colors: integerParameter(parameters, 'Colors', 1),
  bitsPerComponent: integerParameter(parameters, 'BitsPerComponent', 8),
  columns: integerParameter(parameters, 'Columns', 1),
});

const FLATE_WARNINGS = {
  'trailing-data': 'flate-trailing-data',
  'truncated-trailer': 'flate-truncated-trailer',
  'checksum-mismatch': 'flate-checksum-mismatch',
} as const;

const inflate = (data: Uint8Array, context: DecodeContext): Uint8Array => {
  const inflated = inflateZlib(data, { maxOutputBytes: context.maxDecodedBytes });
  for (const warning of inflated.warnings) {
    context.warn({ code: FLATE_WARNINGS[warning.code], detail: `FlateDecode data: ${warning.code} at byte ${String(warning.offset)}` });
  }
  return inflated.data;
};

interface FilterStep {
  readonly name: string;
  readonly parameters: PdfDictionaryEntries | undefined;
}

const applyFilter = ({ name, parameters }: FilterStep, data: Uint8Array, context: DecodeContext): Uint8Array => {
  const limit = context.maxDecodedBytes;
  switch (name) {
    case 'FlateDecode': {
      return undoPredictor(inflate(data, context), predictorParameters(parameters));
    }
    case 'LZWDecode': {
      const decoded = decodeLzw(data, { earlyChange: integerParameter(parameters, 'EarlyChange', 1), maxOutputBytes: limit });
      return undoPredictor(decoded, predictorParameters(parameters));
    }
    case 'ASCIIHexDecode': {
      return decodeAsciiHex(data, limit);
    }
    case 'ASCII85Decode': {
      return decodeAscii85(data, limit);
    }
    case 'RunLengthDecode': {
      return decodeRunLength(data, limit);
    }
    case 'Crypt': {
      // ISO 32000-1:2008, 7.4.10: Crypt filters need the document's security handler; pdfwright does not decrypt.
      throw new UnsupportedFeatureError('the Crypt filter needs decryption, which pdfwright does not perform');
    }
    default: {
      throw new UnsupportedFeatureError(`the ${name} filter is not supported for decoding`);
    }
  }
};

/**
 * Decodes a stream's data through the filters its dictionary names; ISO 32000-1:2008, 7.3.8.2, Table 5, Filter: "Multiple filters shall be specified in the order in which they are to be applied."
 * Filters that are not implemented throw UnsupportedFeatureError; decoded output above maxDecodedBytes throws ResourceLimitError.
 */
export const decodeStream = (stream: PdfStream, context: DecodeContext): Uint8Array => {
  const filters = asList(stream.dictionary.get(FILTER), context);
  const parameters = asList(stream.dictionary.get(DECODE_PARMS), context);
  let { data } = stream;
  for (const [index, filter] of filters.entries()) {
    if (filter?.kind !== 'name') throw new ParseError('a stream filter is not a name', 0);
    const name = latin1(filter.bytes);
    const parameter = parameters[index];
    data = applyFilter({ name: NAMES.get(name) ?? name, parameters: parameter?.kind === 'dictionary' ? parameter.entries : undefined }, data, context);
    if (data.length > context.maxDecodedBytes) {
      throw new ResourceLimitError(`decoded stream exceeds maxDecodedBytes (${String(context.maxDecodedBytes)} bytes)`);
    }
  }
  return data;
};

import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { PredictorParameters } from './predictor.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pdfName } from '../object/pdfObject.ts';

import { undoPredictor } from './predictor.ts';

export interface DecodeContext {
  /** Largest decoded size accepted, in bytes; larger output throws ResourceLimitError. */
  readonly maxDecodedBytes: number;
  readonly warn: (warning: LoadWarning) => void;
}

type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const FLATE = 'FlateDecode';

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const asList = (value: PdfDirectObject | undefined): (PdfDirectObject | undefined)[] => {
  if (value === undefined) return [];
  return value.kind === 'array' ? value.items : [value];
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

/**
 * Decodes a stream's data through the filters its dictionary names (ISO 32000-1:2008, 7.4.1: "The filters shall be applied in the order given").
 * Filters that are not implemented throw UnsupportedFeatureError; decoded output above maxDecodedBytes throws ResourceLimitError.
 */
export const decodeStream = (stream: PdfStream, context: DecodeContext): Uint8Array => {
  const filters = asList(stream.dictionary.get(FILTER));
  const parameters = asList(stream.dictionary.get(DECODE_PARMS));
  let { data } = stream;
  for (const [index, filter] of filters.entries()) {
    if (filter?.kind !== 'name') throw new ParseError('a stream filter is not a name', 0);
    const name = latin1(filter.bytes);
    const parameter = parameters[index];
    const entries = parameter?.kind === 'dictionary' ? parameter.entries : undefined;
    if (name !== FLATE) throw new UnsupportedFeatureError(`the ${name} filter is not supported for decoding`);
    data = undoPredictor(inflate(data, context), predictorParameters(entries));
    if (data.length > context.maxDecodedBytes) {
      throw new ResourceLimitError(`decoded stream exceeds maxDecodedBytes (${String(context.maxDecodedBytes)} bytes)`);
    }
  }
  return data;
};

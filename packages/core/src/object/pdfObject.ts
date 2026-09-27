import type { Length } from '../length/length.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { formatInteger } from '../number/formatNumber.ts';

import { assertNameBytes } from './nameBytes.ts';
import { PdfDictionaryEntries } from './pdfDictionaryEntries.ts';

export { PdfDictionaryEntries } from './pdfDictionaryEntries.ts';

// ISO 32000-1:2008, 7.3.8.1: "All streams shall be indirect objects", so array items and dictionary values are direct objects only.
export type PdfDirectObject =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer'; value: number }
  | { kind: 'real'; value: number | Length }
  | { kind: 'name'; bytes: Uint8Array }
  | { kind: 'string'; bytes: Uint8Array; encoding: 'literal' | 'hex' }
  | { kind: 'array'; items: PdfDirectObject[] }
  | { kind: 'dictionary'; entries: PdfDictionaryEntries }
  | { kind: 'reference'; objectNumber: number; generation: number };

export type PdfObject = PdfDirectObject | { kind: 'stream'; dictionary: PdfDictionaryEntries; data: Uint8Array };

export type PdfReference = Extract<PdfObject, { kind: 'reference' }>;

export const pdfNameFromBytes = (bytes: Uint8Array): Extract<PdfObject, { kind: 'name' }> => {
  assertNameBytes(bytes);
  return { kind: 'name', bytes: Uint8Array.from(bytes) };
};

export const pdfName = (ascii: string): Extract<PdfObject, { kind: 'name' }> => {
  const bytes = new Uint8Array(ascii.length);
  for (let index = 0; index < ascii.length; index++) {
    const code = ascii.codePointAt(index) ?? 0;
    if (code < 0x21 || code > 0x7e) throw new InvalidArgumentError('name must use printable ASCII');
    bytes[index] = code;
  }
  return pdfNameFromBytes(bytes);
};

export const pdfString = (bytes: Uint8Array, encoding: 'literal' | 'hex' = 'literal'): Extract<PdfObject, { kind: 'string' }> => ({
  kind: 'string',
  bytes: Uint8Array.from(bytes),
  encoding,
});

export const pdfLiteralString = (text: string): Extract<PdfObject, { kind: 'string' }> => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) ?? 0;
    if (code > 127) throw new InvalidArgumentError('literal text must be ASCII');
    bytes[index] = code;
  }
  return pdfString(bytes);
};

export const pdfInteger = (value: number): Extract<PdfObject, { kind: 'integer' }> => {
  formatInteger(value);
  return { kind: 'integer', value };
};

// A Length keeps its exact rational value, so serialization rounds it once, as formatLength does.
export const pdfReal = (value: number | Length): Extract<PdfObject, { kind: 'real' }> => {
  if (typeof value === 'number' ? !Number.isFinite(value) : value.denominator <= 0n) throw new InvalidArgumentError('real must be finite');
  return { kind: 'real', value };
};

export const pdfArray = (items: PdfDirectObject[]): Extract<PdfObject, { kind: 'array' }> => ({ kind: 'array', items });

export const pdfDictionary = (entries: PdfDictionaryEntries = new PdfDictionaryEntries()): Extract<PdfObject, { kind: 'dictionary' }> => ({
  kind: 'dictionary',
  entries,
});

export const pdfReference = (objectNumber: number, generation: number): Extract<PdfObject, { kind: 'reference' }> => {
  if (!Number.isSafeInteger(objectNumber) || objectNumber < 1 || objectNumber > 2147483647) {
    throw new InvalidArgumentError('invalid object number');
  }
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 65535) {
    throw new InvalidArgumentError('invalid generation');
  }
  return { kind: 'reference', objectNumber, generation };
};

import type { Length } from '../length/length.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { formatInteger } from '../number/formatNumber.ts';

import { assertNameBytes } from './nameBytes.ts';
import { PdfDictionaryEntries } from './pdfDictionaryEntries.ts';

export { PdfDictionaryEntries } from './pdfDictionaryEntries.ts';

/** Why a parser kept a token as raw bytes instead of reading it as an object. */
export type InvalidObjectReason = 'malformed-number' | 'integer-out-of-range' | 'real-out-of-range' | 'unknown-keyword';

// ISO 32000-1:2008, 7.3.8.1: "All streams shall be indirect objects", so array items and dictionary values are direct objects only.
/** A PDF value that can appear directly in an array or dictionary; stream values require indirect objects under ISO 32000-1:2008, 7.3.8.1. */
export type PdfDirectObject =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer'; value: number }
  | { kind: 'real'; value: number | Length }
  | { kind: 'name'; bytes: Uint8Array }
  | { kind: 'string'; bytes: Uint8Array; encoding: 'literal' | 'hex' }
  | { kind: 'array'; items: PdfDirectObject[] }
  | { kind: 'dictionary'; entries: PdfDictionaryEntries }
  | { kind: 'reference'; objectNumber: number; generation: number }
  // A token a parser read but could not interpret; its bytes are one run of regular characters and are written back verbatim.
  | { kind: 'invalid'; bytes: Uint8Array; reason: InvalidObjectReason };

/** A direct PDF value or an indirect stream with its dictionary and encoded bytes, as described in ISO 32000-1:2008, 7.3.8. */
export type PdfObject = PdfDirectObject | { kind: 'stream'; dictionary: PdfDictionaryEntries; data: Uint8Array };

/** An object number and generation pair resolved under ISO 32000-1:2008, 7.3.10; `pdfReference` checks their numeric bounds. */
export type PdfReference = Extract<PdfObject, { kind: 'reference' }>;

/**
 * Copies name bytes after enforcing the 127-byte and no-null limits in ISO 32000-1:2008, 7.3.5 and Annex C, Table C.1.
 * @param bytes The original PDF name bytes without a slash.
 * @throws InvalidArgumentError with no reason when the name exceeds 127 bytes or contains zero.
 */
export const pdfNameFromBytes = (bytes: Uint8Array): Extract<PdfObject, { kind: 'name' }> => {
  assertNameBytes(bytes);
  return { kind: 'name', bytes: Uint8Array.from(bytes) };
};

/**
 * Encodes printable ASCII as a PDF name, copying at most 127 bytes under ISO 32000-1:2008, 7.3.5 and Annex C, Table C.1.
 * @param ascii Printable ASCII without the leading slash.
 * @throws InvalidArgumentError with no reason for a nonprintable character or a name over 127 bytes.
 */
export const pdfName = (ascii: string): Extract<PdfObject, { kind: 'name' }> => {
  const bytes = new Uint8Array(ascii.length);
  for (let index = 0; index < ascii.length; index++) {
    const code = ascii.codePointAt(index) ?? 0;
    if (code < 0x21 || code > 0x7e) throw new InvalidArgumentError('name must use printable ASCII');
    bytes[index] = code;
  }
  return pdfNameFromBytes(bytes);
};

/**
 * Copies PDF string bytes with literal encoding by default, or hex encoding when selected, under ISO 32000-1:2008, 7.3.4.
 * @param bytes The encoded string bytes.
 * @param encoding `literal` by default or `hex`; this constructor imposes no byte-length limit and throws no validation error.
 */
export const pdfString = (bytes: Uint8Array, encoding: 'literal' | 'hex' = 'literal'): Extract<PdfObject, { kind: 'string' }> => ({
  kind: 'string',
  bytes: Uint8Array.from(bytes),
  encoding,
});

/**
 * Encodes ASCII text as a literal PDF string under ISO 32000-1:2008, 7.3.4.
 * @param text Characters with code points from 0 to 127.
 * @throws InvalidArgumentError with no reason when a character exceeds ASCII; there is no length limit here.
 */
export const pdfLiteralString = (text: string): Extract<PdfObject, { kind: 'string' }> => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) ?? 0;
    if (code > 127) throw new InvalidArgumentError('literal text must be ASCII');
    bytes[index] = code;
  }
  return pdfString(bytes);
};

/**
 * Builds a PDF integer within the signed range −2,147,483,647 to 2,147,483,647 from ISO 32000-1:2008, Annex C, Table C.1.
 * @param value A safe integer in that range.
 * @throws InvalidArgumentError with no reason for a fractional or out-of-range value.
 */
export const pdfInteger = (value: number): Extract<PdfObject, { kind: 'integer' }> => {
  formatInteger(value);
  return { kind: 'integer', value };
};

// A Length keeps its exact rational value, so serialization rounds it once, as formatLength does.
/**
 * Builds a finite PDF real or exact rational length under ISO 32000-1:2008, 7.3.3.
 * @param value A finite number or a `Length` with a positive denominator.
 * @throws InvalidArgumentError with no reason for a nonfinite number or nonpositive denominator.
 */
export const pdfReal = (value: number | Length): Extract<PdfObject, { kind: 'real' }> => {
  if (typeof value === 'number' ? !Number.isFinite(value) : value.denominator <= 0n) throw new InvalidArgumentError('real must be finite');
  return { kind: 'real', value };
};

/**
 * Wraps direct PDF values in an array under ISO 32000-1:2008, 7.3.6.
 * @param items Direct values in order; this wrapper adds no default, validation, or length limit.
 */
export const pdfArray = (items: PdfDirectObject[]): Extract<PdfObject, { kind: 'array' }> => ({ kind: 'array', items });

/**
 * Wraps PDF dictionary entries, using an empty dictionary by default, under ISO 32000-1:2008, 7.3.7.
 * @param entries Name/value entries; key validation occurs when `PdfDictionaryEntries.set` receives a key.
 */
export const pdfDictionary = (entries: PdfDictionaryEntries = new PdfDictionaryEntries()): Extract<PdfObject, { kind: 'dictionary' }> => ({
  kind: 'dictionary',
  entries,
});

/**
 * Names an indirect object with number 1–2,147,483,647 and generation 0–65,535 under ISO 32000-1:2008, 7.3.10 and Annex C, Table C.1.
 * @param objectNumber Positive in-range integer.
 * @param generation In-range nonnegative integer.
 * @throws InvalidArgumentError with no reason for either invalid bound.
 */
export const pdfReference = (objectNumber: number, generation: number): Extract<PdfObject, { kind: 'reference' }> => {
  if (!Number.isSafeInteger(objectNumber) || objectNumber < 1 || objectNumber > 2147483647) {
    throw new InvalidArgumentError('invalid object number');
  }
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 65535) {
    throw new InvalidArgumentError('invalid generation');
  }
  return { kind: 'reference', objectNumber, generation };
};

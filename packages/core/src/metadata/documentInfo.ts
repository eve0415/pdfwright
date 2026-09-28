import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { ValidationError } from '../error/validationError.ts';
import { pdfDocEncodingUnicode } from '../font/encoding/simpleEncodings.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName, pdfString } from '../object/pdfObject.ts';

export interface DocumentInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: PdfDate;
  modificationDate?: PdfDate;
  /** Whether the document has been trapped (ISO 32000-1:2008, Table 317); written as a name. */
  trapped?: 'True' | 'False' | 'Unknown';
}

// ISO 32000-1:2008, Annex D, Table D.2 maps these codes to the same Unicode code points; it marks the other C0 codes and 0x7F undefined and maps 0x18-0x1F to spacing accents.
const selfMapped = (code: number): boolean => (code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d;

// ISO 32000-1:2008, 7.9.2.2 encodes text strings as PDFDocEncoding or UTF-16BE with a FE FF byte-order marker.
export const pdfTextString = (value: string): PdfDirectObject => {
  const units: number[] = [];
  let ascii = true;
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index);
    if (code === undefined) throw new ValidationError('invalid text character');
    if (!selfMapped(code)) ascii = false;
    if (code >= 0xd800 && code <= 0xdfff) throw new ValidationError('text contains an unpaired UTF-16 surrogate');
    if (code > 0xffff) {
      const scalar = code - 0x10000;
      units.push(0xd800 + Math.floor(scalar / 1024), 0xdc00 + (scalar % 1024));
      index++;
    } else units.push(code);
  }
  if (ascii) return pdfString(Uint8Array.from(units));
  const bytes = new Uint8Array(units.length * 2 + 2);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let index = 0; index < units.length; index++) {
    const code = units[index] ?? 0;
    bytes[2 + index * 2] = Math.floor(code / 256);
    bytes[3 + index * 2] = code % 256;
  }
  return pdfString(bytes, 'hex');
};

// ISO 32000-1:2008, 14.3.3, Table 317 defines document information keys and omits values that are not known.
export const documentInfoDictionary = (info: DocumentInfo): PdfDictionaryEntries => {
  const entries = new PdfDictionaryEntries();
  for (const [key, value] of [
    ['Title', info.title],
    ['Author', info.author],
    ['Subject', info.subject],
    ['Keywords', info.keywords],
    ['Creator', info.creator],
    ['Producer', info.producer],
  ] as const) {
    if (value !== undefined) entries.set(pdfName(key).bytes, pdfTextString(value));
  }
  if (info.creationDate !== undefined) entries.set(pdfName('CreationDate').bytes, pdfDateObject(info.creationDate));
  if (info.modificationDate !== undefined) entries.set(pdfName('ModDate').bytes, pdfDateObject(info.modificationDate));
  // Table 317, Trapped: "This shall be the name True, not the boolean value true".
  if (info.trapped !== undefined) entries.set(pdfName('Trapped').bytes, pdfName(info.trapped));
  return entries;
};

export interface TextString {
  readonly text: string;
  readonly encoding: 'pdfdoc' | 'utf-16be';
  /** The language escapes removed from UTF-16BE text, in order, as the ISO 639 code with the ISO 3166 country code after a hyphen when one is given. */
  readonly languages: readonly string[];
  /** How many undecodable bytes or code units were read as U+FFFD: undefined PDFDocEncoding codes, unpaired surrogates, an odd final byte. */
  readonly replaced: number;
}

/** A value of the document information dictionary: a text string, a name (Trapped), or another kind of object, whose kind is reported. */
export type InfoValue =
  | ({ readonly kind: 'text' } & TextString)
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'other'; readonly type: PdfObject['kind'] };

const ESCAPE = 0x1b;
const isAsciiLetter = (byte: number | undefined): boolean => byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a));

// ISO 32000-1:2008, 7.9.2.2: an escape is U+001B, "A 2- byte ISO 639 language code", "(Optional) A 2-byte ISO 3166 country code" and U+001B again.
const languageEscape = (bytes: Uint8Array, start: number): { readonly code: string; readonly end: number } | undefined => {
  const letters = (from: number): boolean => isAsciiLetter(bytes[from]) && isAsciiLetter(bytes[from + 1]);
  const escapeAt = (at: number): boolean => bytes[at] === 0 && bytes[at + 1] === ESCAPE;
  if (!escapeAt(start) || !letters(start + 2)) return undefined;
  const language = String.fromCodePoint(bytes[start + 2] ?? 0, bytes[start + 3] ?? 0);
  if (escapeAt(start + 4)) return { code: language, end: start + 6 };
  if (!letters(start + 4) || !escapeAt(start + 6)) return undefined;
  return { code: `${language}-${String.fromCodePoint(bytes[start + 4] ?? 0, bytes[start + 5] ?? 0)}`, end: start + 8 };
};

const readUtf16 = (bytes: Uint8Array): TextString => {
  let text = '';
  let replaced = 0;
  const languages: string[] = [];
  let index = 2;
  while (index + 1 < bytes.length) {
    const escape = languageEscape(bytes, index);
    if (escape !== undefined) {
      languages.push(escape.code);
      index = escape.end;
      continue;
    }
    const unit = (bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0);
    const next = (bytes[index + 2] ?? 0) * 256 + (bytes[index + 3] ?? 0);
    index += 2;
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < bytes.length && next >= 0xdc00 && next <= 0xdfff) {
      text += String.fromCodePoint(0x10000 + (unit - 0xd800) * 1024 + (next - 0xdc00));
      index += 2;
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      text += '\uFFFD';
      replaced++;
    } else text += String.fromCodePoint(unit);
  }
  if (index < bytes.length) {
    text += '\uFFFD';
    replaced++;
  }
  return { text, encoding: 'utf-16be', languages, replaced };
};

/** Decodes a text string (ISO 32000-1:2008, 7.9.2.2): UTF-16BE after the bytes 254 and 255, with language escapes removed, and PDFDocEncoding through Annex D otherwise. */
export const readTextString = (bytes: Uint8Array): TextString => {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return readUtf16(bytes);
  let text = '';
  let replaced = 0;
  for (const byte of bytes) {
    const unicode = pdfDocEncodingUnicode(byte);
    if (unicode === undefined) replaced++;
    text += String.fromCodePoint(unicode ?? 0xfffd);
  }
  return { text, encoding: 'pdfdoc', languages: [], replaced };
};

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

// ISO 32000-1:2008, 14.3.3: "The value associated with any key not specifically mentioned in Table 317 shall be a text string"; Trapped is a name.
/** The values of a document information dictionary by key, with indirect values resolved through `deref`. */
export const readInfoValues = (entries: PdfDictionaryEntries, deref: (reference: PdfReference) => PdfObject | undefined): ReadonlyMap<string, InfoValue> => {
  const values = new Map<string, InfoValue>();
  for (const [key, stored] of entries.entries()) {
    const value = stored.kind === 'reference' ? (deref(stored) ?? { kind: 'null' }) : stored;
    if (value.kind === 'null') continue;
    if (value.kind === 'string') values.set(latin1(key), { kind: 'text', ...readTextString(value.bytes) });
    else if (value.kind === 'name') values.set(latin1(key), { kind: 'name', name: latin1(value.bytes) });
    else values.set(latin1(key), { kind: 'other', type: value.kind });
  }
  return values;
};

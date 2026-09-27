import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { ValidationError } from '../error/validationError.ts';
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
  return entries;
};

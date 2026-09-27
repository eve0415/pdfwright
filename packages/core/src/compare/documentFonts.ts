import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { FontIdentity } from './pdfDifference.ts';
import type { ResolvedTexts } from './resolvedText.ts';

import { md5 } from '../hash/md5.ts';
import { pdfName } from '../object/pdfObject.ts';

import { decodeForComparison } from './pageContent.ts';

const SUBTYPE = pdfName('Subtype').bytes;
const BASE_FONT = pdfName('BaseFont').bytes;
const ENCODING = pdfName('Encoding').bytes;
const DESCRIPTOR = pdfName('FontDescriptor').bytes;
const DESCENDANTS = pdfName('DescendantFonts').bytes;
const PROGRAMS = [pdfName('FontFile').bytes, pdfName('FontFile2').bytes, pdfName('FontFile3').bytes];

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const dictionaryOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const nameOf = (value: PdfObject | undefined): string => (value?.kind === 'name' ? latin1(value.bytes) : '');

const referenceKey = (value: PdfDirectObject): string | undefined =>
  value.kind === 'reference' ? `${String(value.objectNumber)}.${String(value.generation)}` : undefined;

/**
 * The fonts of one document, with each font's identity worked out once however many pages use it.
 */
export class DocumentFonts {
  private readonly document: DocumentInternals;
  private readonly texts: ResolvedTexts;
  private readonly identities = new Map<string, FontIdentity>();

  constructor(document: DocumentInternals, texts: ResolvedTexts) {
    this.document = document;
    this.texts = texts;
  }

  resolve(value: PdfDirectObject | undefined): PdfObject | undefined {
    return this.document.objects.deref(value);
  }

  // The embedded program's decoded bytes identify it; a program that cannot be decoded is identified by its raw bytes (ISO 32000-1:2008, 9.9, Table 126).
  private program(font: PdfDictionaryEntries): string {
    const descendant = this.resolve(font.get(DESCENDANTS));
    const first = descendant?.kind === 'array' ? dictionaryOf(this.resolve(descendant.items[0])) : undefined;
    const descriptor = dictionaryOf(this.resolve((first ?? font).get(DESCRIPTOR)));
    for (const key of PROGRAMS) {
      const stream = this.resolve(descriptor?.get(key));
      if (stream?.kind !== 'stream') continue;
      const decoded = decodeForComparison(this.document, stream);
      return hex(md5(decoded.ok ? decoded.bytes : stream.data));
    }
    return '';
  }

  // A predefined encoding or CMap by name; an encoding dictionary by its resolved value, so that key order and object numbers do not matter; an embedded CMap by its decoded bytes (9.6.6, 9.7.5).
  private encoding(font: PdfDictionaryEntries): string {
    const encoding = this.resolve(font.get(ENCODING));
    if (encoding === undefined || encoding.kind === 'name') return nameOf(encoding);
    if (encoding.kind !== 'stream') {
      const text = this.texts.text(encoding);
      return hex(md5(latin1Bytes(text)));
    }
    const decoded = decodeForComparison(this.document, encoding);
    return hex(md5(decoded.ok ? decoded.bytes : encoding.data));
  }

  identity(font: PdfDictionaryEntries, value: PdfDirectObject): FontIdentity {
    const key = referenceKey(value);
    const known = key === undefined ? undefined : this.identities.get(key);
    if (known !== undefined) return known;
    const identity: FontIdentity = {
      subtype: nameOf(this.resolve(font.get(SUBTYPE))),
      baseFont: nameOf(this.resolve(font.get(BASE_FONT))),
      encoding: this.encoding(font),
      program: this.program(font),
    };
    if (key !== undefined) this.identities.set(key, identity);
    return identity;
  }
}

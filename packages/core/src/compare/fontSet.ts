import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { FontIdentity } from './pdfDifference.ts';

import { md5 } from '../hash/md5.ts';
import { pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { decodeForComparison } from './pageContent.ts';

const FONT = pdfName('Font').bytes;
const XOBJECT = pdfName('XObject').bytes;
const PATTERN = pdfName('Pattern').bytes;
const RESOURCES = pdfName('Resources').bytes;
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

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const dictionaryOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const nameOf = (value: PdfObject | undefined): string => (value?.kind === 'name' ? latin1(value.bytes) : '');

class FontCollector {
  private readonly document: DocumentInternals;
  private readonly seen = new Set<string>();
  readonly fonts = new Map<string, FontIdentity>();

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  private deref(value: PdfDirectObject | undefined): PdfObject | undefined {
    return this.document.objects.deref(value);
  }

  // Each resource object is visited once, which also ends cycles through forms that use themselves.
  private once(value: PdfDirectObject | undefined): boolean {
    if (value?.kind !== 'reference') return true;
    const key = `${String(value.objectNumber)}.${String(value.generation)}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  // The embedded program's decoded bytes identify it; a program that cannot be decoded is identified by its raw bytes (ISO 32000-1:2008, 9.9, Table 126).
  private program(font: PdfDictionaryEntries): string {
    const descendant = this.deref(font.get(DESCENDANTS));
    const first = descendant?.kind === 'array' ? dictionaryOf(this.deref(descendant.items[0])) : undefined;
    const descriptor = dictionaryOf(this.deref((first ?? font).get(DESCRIPTOR)));
    for (const key of PROGRAMS) {
      const stream = this.deref(descriptor?.get(key));
      if (stream?.kind !== 'stream') continue;
      const decoded = decodeForComparison(this.document, stream);
      return hex(md5(decoded.ok ? decoded.bytes : stream.data));
    }
    return '';
  }

  private encoding(font: PdfDictionaryEntries): string {
    const encoding = this.deref(font.get(ENCODING));
    if (encoding === undefined || encoding.kind === 'name') return nameOf(encoding);
    return encoding.kind === 'stream' ? hex(md5(encoding.data)) : hex(md5(serializeObject(encoding, { fractionDigits: 6 })));
  }

  private font(value: PdfDirectObject | undefined): void {
    if (!this.once(value)) return;
    const font = dictionaryOf(this.deref(value));
    if (font === undefined) return;
    const identity: FontIdentity = {
      subtype: nameOf(this.deref(font.get(SUBTYPE))),
      baseFont: nameOf(this.deref(font.get(BASE_FONT))),
      encoding: this.encoding(font),
      program: this.program(font),
    };
    this.fonts.set(JSON.stringify(identity), identity);
    // ISO 32000-1:2008, 9.6.5: a Type 3 font's glyph procedures use the font's own Resources.
    this.resources(font.get(RESOURCES));
  }

  private category(resources: PdfDictionaryEntries, key: Uint8Array, visit: (value: PdfDirectObject) => void): void {
    const entries = dictionaryOf(this.deref(resources.get(key)));
    for (const [, value] of entries?.entries() ?? []) visit(value);
  }

  // Fonts reachable from a resource dictionary, through form XObjects and patterns with their own resources.
  resources(value: PdfDirectObject | undefined): void {
    if (!this.once(value)) return;
    const resources = dictionaryOf(this.deref(value));
    if (resources === undefined) return;
    this.category(resources, FONT, font => {
      this.font(font);
    });
    for (const key of [XOBJECT, PATTERN]) {
      this.category(resources, key, item => {
        if (!this.once(item)) return;
        this.resources(dictionaryOf(this.deref(item))?.get(RESOURCES));
      });
    }
  }
}

/** The fonts a resource dictionary reaches, by identity. */
export const fontSet = (document: DocumentInternals, resources: PdfDirectObject | undefined): Map<string, FontIdentity> => {
  const collector = new FontCollector(document);
  collector.resources(resources);
  return collector.fonts;
};

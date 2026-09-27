import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { md5 } from '../hash/md5.ts';
import { pdfName } from '../object/pdfObject.ts';

const hex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
};

const numberText = (value: Extract<PdfObject, { kind: 'integer' | 'real' }>): string =>
  String(typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator));

const scalarText = (value: Exclude<PdfObject, { kind: 'array' | 'dictionary' | 'stream' | 'reference' }>): string => {
  switch (value.kind) {
    case 'integer':
    case 'real': {
      return `n${numberText(value)}`;
    }
    case 'name': {
      return `/${hex(value.bytes)}`;
    }
    case 'string': {
      return `(${hex(value.bytes)})`;
    }
    case 'invalid': {
      return `?${hex(value.bytes)}`;
    }
    case 'boolean': {
      return value.value ? 'true' : 'false';
    }
    case 'null': {
      return 'null';
    }
    default: {
      return 'null';
    }
  }
};

/** How many references deep a described value may lead. */
const MAX_DEPTH = 64;

class Describer {
  private readonly document: DocumentInternals;
  private readonly path = new Set<string>();

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  private reference(value: Extract<PdfDirectObject, { kind: 'reference' }>): string {
    const key = `${String(value.objectNumber)}.${String(value.generation)}`;
    if (this.path.has(key)) return 'cycle';
    if (this.path.size >= MAX_DEPTH) throw new ResourceLimitError(`a compared value leads through more than ${String(MAX_DEPTH)} references`);
    this.path.add(key);
    const text = this.text(this.document.objects.deref(value));
    this.path.delete(key);
    return text;
  }

  text(value: PdfObject | undefined): string {
    if (value === undefined) return 'null';
    if (value.kind === 'reference') return this.reference(value);
    if (value.kind === 'array') return `[${value.items.map(item => this.text(item)).join(' ')}]`;
    if (value.kind === 'dictionary') return this.entries(value.entries);
    if (value.kind === 'stream') return `${this.entries(value.dictionary)}stream${hex(md5(value.data))}`;
    return scalarText(value);
  }

  // Dictionaries compare regardless of key order, and an entry whose value is null is the same as an absent one (ISO 32000-1:2008, 7.3.7).
  private entries(entries: Extract<PdfObject, { kind: 'dictionary' }>['entries']): string {
    const texts: string[] = [];
    for (const [key, item] of entries.entries()) {
      const text = this.text(item);
      if (text !== 'null') texts.push(`/${hex(key)} ${text}`);
    }
    return `<<${texts.toSorted().join(' ')}>>`;
  }
}

/**
 * A canonical text for a value with its references followed, for comparing values that two documents may number, order or spell differently: numbers by value, strings and names by bytes, dictionaries by sorted keys, stream data by digest.
 * ISO 32000-1:2008, 7.3.10: "An indirect reference to an undefined object shall not be considered an error by a conforming reader; it shall be treated as a reference to the null object."
 */
export const resolvedText = (document: DocumentInternals, value: PdfObject | undefined): string => new Describer(document).text(value);

const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;

/** The filters and their parameters that a stream's data is encoded with (ISO 32000-1:2008, 7.3.8.2, Table 5), as resolved text. */
export const encodingText = (document: DocumentInternals, stream: Extract<PdfObject, { kind: 'stream' }>): string =>
  `${resolvedText(document, stream.dictionary.get(FILTER))} ${resolvedText(document, stream.dictionary.get(DECODE_PARMS))}`;

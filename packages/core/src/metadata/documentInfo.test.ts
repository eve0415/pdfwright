import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { createDocument } from '../document/pdfDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference, pdfString } from '../object/pdfObject.ts';

import { pdfTextString, readInfoValues, readTextString } from './documentInfo.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('document information', () => {
  it('writes ASCII text, UTF-16BE text, and explicit dates', () => {
    const date = pdfDate({ year: 2024, month: 2, day: 29, hour: 12, minute: 34, second: 56, offset: 'Z' });
    const document = createDocument({
      info: {
        title: 'Print (page)',
        author: '日本',
        subject: 'Proof',
        keywords: 'ink',
        creator: 'Artwork',
        producer: 'Press',
        creationDate: date,
        modificationDate: date,
      },
    });
    const pdf = ascii(document.save().toBytes());
    for (const fragment of [
      String.raw`/Title(Print \(page\))`,
      '/Author<FEFF65E5672C>',
      '/Subject(Proof)',
      '/Keywords(ink)',
      '/Creator(Artwork)',
      '/Producer(Press)',
      '/CreationDate(D:20240229123456Z)',
      '/ModDate(D:20240229123456Z)',
      '/Info',
    ]) {
      expect(pdf).toContain(fragment);
    }
  });

  it('uses PDFDocEncoding only for code points it maps to themselves', () => {
    const pdf = ascii(
      createDocument({ info: { title: 'a\u0018b', author: '\u007F', subject: 'tab\there\r\n', keywords: '\u0001' }, metadata: { xmp: false } })
        .save()
        .toBytes(),
    );
    for (const fragment of ['/Title<FEFF006100180062>', '/Author<FEFF007F>', String.raw`/Subject(tab\there\r\n)`, '/Keywords<FEFF0001>']) {
      expect(pdf).toContain(fragment);
    }
  });

  it('writes Trapped as a name', () => {
    const texts = (['True', 'False', 'Unknown'] as const).map(trapped =>
      ascii(
        createDocument({ info: { trapped }, metadata: { xmp: false } })
          .save()
          .toBytes(),
      ),
    );
    expect(texts.map(text => /\/Trapped\/(\w+)/u.exec(text)?.[1])).toStrictEqual(['True', 'False', 'Unknown']);
  });

  it('writes no implicit metadata or clock values', () => {
    const pdf = ascii(createDocument().save().toBytes());
    expect(pdf).not.toContain('/Info');
    expect(pdf).not.toContain('/Producer');
    expect(pdf).not.toContain('/CreationDate');
    expect(pdf).not.toContain('/ModDate');
  });

  it('encodes supplementary Unicode with its surrogate pair and rejects malformed text', () => {
    const pdf = ascii(
      createDocument({ info: { title: '😀' }, metadata: { xmp: false } })
        .save()
        .toBytes(),
    );
    expect(pdf).toContain('/Title<FEFFD83DDE00>');
    expect(() => createDocument({ info: { title: '\uD800' }, metadata: { xmp: false } }).save()).toThrow(ValidationError);
  });
});

const utf16 = (...units: Array<number>): Uint8Array => Uint8Array.from([0xfe, 0xff, ...units.flatMap(unit => [Math.floor(unit / 256), unit % 256])]);

const stringBytes = (value: PdfDirectObject): Uint8Array => (value.kind === 'string' ? value.bytes : new Uint8Array());

describe('reading text strings', () => {
  it('decodes PDFDocEncoding through Table D.2, replacing undefined codes', () => {
    expect(readTextString(Uint8Array.of(0x41, 0x80, 0x93, 0xa0, 0xe9, 0x7f, 0x09))).toStrictEqual({
      text: 'A•ﬁ€é�\t',
      encoding: 'pdfdoc',
      languages: [],
      replaced: 1,
    });
  });

  it('decodes UTF-16BE with surrogate pairs and replaces unpaired surrogates and an odd final byte', () => {
    expect(readTextString(utf16(0x5c_71, 0xd8_42, 0xdf_b7, 0xd8_00, 0x00_41))).toStrictEqual({
      text: '山\u{20BB7}�A',
      encoding: 'utf-16be',
      languages: [],
      replaced: 1,
    });
    expect(readTextString(Uint8Array.of(0xfe, 0xff, 0x00, 0x41, 0x00))).toStrictEqual({ text: 'A�', encoding: 'utf-16be', languages: [], replaced: 1 });
  });

  // ISO 32000-1:2008, 7.9.2.2: only the bytes 254 followed by 255 mark UTF-16BE; anything else, including an empty string, is PDFDocEncoding.
  it.each([
    ['an empty string', new Uint8Array(), { text: '', encoding: 'pdfdoc', languages: [], replaced: 0 }],
    ['a byte-order mark alone', Uint8Array.of(0xfe, 0xff), { text: '', encoding: 'utf-16be', languages: [], replaced: 0 }],
    ['a lone 254 byte', Uint8Array.of(0xfe), { text: 'þ', encoding: 'pdfdoc', languages: [], replaced: 0 }],
    ['the marker bytes reversed', Uint8Array.of(0xff, 0xfe), { text: 'ÿþ', encoding: 'pdfdoc', languages: [], replaced: 0 }],
  ])('decodes %s', (_name, bytes, expected) => {
    expect(readTextString(bytes)).toStrictEqual(expected);
  });

  // ISO 32000-1:2008, 7.9.2.2: an escape is U+001B, two ASCII letters, optionally two more, and U+001B; anything else is text.
  it.each([
    ['numerals between two escapes', utf16(0x1b, 0x31_32, 0x1b, 0x41), { text: '\u001B\u3132\u001BA', languages: [], replaced: 0 }],
    ['an escape truncated at the end', utf16(0x1b, 0x6a_61), { text: '\u001B\u6A61', languages: [], replaced: 0 }],
    ['a country code without its closing escape', utf16(0x1b, 0x65_6e, 0x55_53), { text: '\u001B\u656E\u5553', languages: [], replaced: 0 }],
    ['a high surrogate before an escape', utf16(0xd8_00, 0x1b, 0x6a_61, 0x1b, 0x41), { text: '\uFFFDA', languages: ['ja'], replaced: 1 }],
    ['a lone low surrogate', utf16(0xdc_00, 0x41), { text: '\uFFFDA', languages: [], replaced: 1 }],
  ])('removes only well-formed language escapes and replaces only unpaired surrogates: %s', (_name, bytes, expected) => {
    expect(readTextString(bytes)).toStrictEqual({ encoding: 'utf-16be', ...expected });
  });

  it('removes language escapes and reports their codes', () => {
    const bytes = utf16(0x1b, 0x6a_61, 0x1b, 0x5c_71, 0x1b, 0x65_6e, 0x55_53, 0x1b, 0x41);
    expect(readTextString(bytes)).toStrictEqual({ text: '山A', encoding: 'utf-16be', languages: ['ja', 'en-US'], replaced: 0 });
  });

  it('reads back every string the writer produces', () => {
    for (const text of ['Print (page)', '日本', 'a\u0018b', '😀', 'tab\there\r\n']) {
      const bytes = stringBytes(pdfTextString(text));
      expect(readTextString(bytes).text).toBe(text);
    }
  });
});

describe('writing text strings', () => {
  // ISO 32000-1:2008, Annex D, Table D.2 maps 0xE9 to U+00E9 too, but only the self-mapped ASCII range is written as PDFDocEncoding.
  it.each([
    ['é', pdfString(Uint8Array.of(0xfe, 0xff, 0x00, 0xe9), 'hex')],
    ['\u00FF', pdfString(Uint8Array.of(0xfe, 0xff, 0x00, 0xff), 'hex')],
    ['~', pdfString(Uint8Array.of(0x7e))],
  ])('writes %j in the encoding its code points need', (text, expected) => {
    expect(pdfTextString(text)).toStrictEqual(expected);
  });

  it.each([['\uD800'], ['\uDC00'], ['a\uDBFF']])('rejects the unpaired surrogate in %j', text => {
    expect(() => pdfTextString(text)).toThrow(ValidationError);
  });
});

describe('reading document information', () => {
  it('reads text strings, names and other values by key', () => {
    const entries = new PdfDictionaryEntries([
      [pdfName('Title').bytes, pdfString(utf16(0x65_e5, 0x67_2c))],
      [pdfName('Trapped').bytes, pdfName('True')],
      [pdfName('Pages').bytes, pdfInteger(3)],
      [pdfName('Author').bytes, pdfReference(7, 0)],
    ]);
    const objects = new Map([[7, pdfString(Uint8Array.of(0x42))]]);
    const values = readInfoValues(entries, reference => objects.get(reference.objectNumber));
    expect(Object.fromEntries(values)).toStrictEqual({
      Title: { kind: 'text', text: '日本', encoding: 'utf-16be', languages: [], replaced: 0 },
      Trapped: { kind: 'name', name: 'True' },
      Pages: { kind: 'other', type: 'integer' },
      Author: { kind: 'text', text: 'B', encoding: 'pdfdoc', languages: [], replaced: 0 },
    });
  });

  // ISO 32000-1:2008, 7.3.9: a null value, or a reference to an object that does not exist, is the same as an absent entry.
  it('leaves out null values and missing references and reports the kind of a dictionary or array', () => {
    const entries = new PdfDictionaryEntries([
      [pdfName('Title').bytes, { kind: 'null' }],
      [pdfName('Author').bytes, pdfReference(8, 0)],
      [pdfName('Subject').bytes, pdfReference(9, 0)],
      [pdfName('Keywords').bytes, pdfDictionary(new PdfDictionaryEntries())],
      [pdfName('Creator').bytes, pdfArray([])],
    ]);
    const objects = new Map<number, PdfObject>([[9, { kind: 'null' }]]);
    const values = readInfoValues(entries, reference => objects.get(reference.objectNumber));
    expect(Object.fromEntries(values)).toStrictEqual({
      Keywords: { kind: 'other', type: 'dictionary' },
      Creator: { kind: 'other', type: 'array' },
    });
  });
});

describe('properties', () => {
  // U+001B is left out because in UTF-16BE it opens a language escape (ISO 32000-1:2008, 7.9.2.2), which the writer does not escape.
  const text = fc.string({ unit: 'binary', maxLength: 64 }).filter(value => !value.includes('\u001B'));

  it('reads back every string of Unicode scalar values the writer produces', () => {
    fc.assert(
      fc.property(text, value => {
        const read = readTextString(stringBytes(pdfTextString(value)));
        expect({ text: read.text, replaced: read.replaced, languages: read.languages }).toStrictEqual({ text: value, replaced: 0, languages: [] });
      }),
    );
  });
});

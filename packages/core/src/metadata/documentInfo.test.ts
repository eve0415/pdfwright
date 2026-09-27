import type { PdfDirectObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { createDocument } from '../document/pdfDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries, pdfInteger, pdfName, pdfReference, pdfString } from '../object/pdfObject.ts';

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
      createDocument({ info: { title: 'a\u0018b', author: '\u007F', subject: 'tab\there\r\n', keywords: '\u0001' } })
        .save()
        .toBytes(),
    );
    for (const fragment of ['/Title<FEFF006100180062>', '/Author<FEFF007F>', String.raw`/Subject(tab\there\r\n)`, '/Keywords<FEFF0001>']) {
      expect(pdf).toContain(fragment);
    }
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
      createDocument({ info: { title: '😀' } })
        .save()
        .toBytes(),
    );
    expect(pdf).toContain('/Title<FEFFD83DDE00>');
    expect(() => createDocument({ info: { title: '\uD800' } }).save()).toThrow(ValidationError);
  });
});

const utf16 = (...units: number[]): Uint8Array => Uint8Array.from([0xfe, 0xff, ...units.flatMap(unit => [Math.floor(unit / 256), unit % 256])]);

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
    expect(readTextString(utf16(0x5c71, 0xd842, 0xdfb7, 0xd800, 0x0041))).toStrictEqual({
      text: '山\u{20BB7}�A',
      encoding: 'utf-16be',
      languages: [],
      replaced: 1,
    });
    expect(readTextString(Uint8Array.of(0xfe, 0xff, 0x00, 0x41, 0x00)).text).toBe('A�');
  });

  it('removes language escapes and reports their codes', () => {
    const bytes = utf16(0x1b, 0x6a61, 0x1b, 0x5c71, 0x1b, 0x656e, 0x5553, 0x1b, 0x41);
    expect(readTextString(bytes)).toStrictEqual({ text: '山A', encoding: 'utf-16be', languages: ['ja', 'en-US'], replaced: 0 });
  });

  it('reads back every string the writer produces', () => {
    for (const text of ['Print (page)', '日本', 'a\u0018b', '😀', 'tab\there\r\n']) {
      const bytes = stringBytes(pdfTextString(text));
      expect(readTextString(bytes).text).toBe(text);
    }
  });
});

describe('reading document information', () => {
  it('reads text strings, names and other values by key', () => {
    const entries = new PdfDictionaryEntries([
      [pdfName('Title').bytes, pdfString(utf16(0x65e5, 0x672c))],
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
});

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';

import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const lastModified = pdfDate({ year: 2024, month: 3, day: 2, hour: 1, minute: 4, second: 5, offset: 'Z' });

describe('page-piece data and indirect objects', () => {
  it('keeps caller stream bytes unchanged and repeats the date in the page data dictionary', () => {
    const document = createDocument();
    const data = new TextEncoder().encode('private raw bytes (unchanged)');
    const privateRef = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.pieceInfo({ lastModified, data: { Illustrator: { private: privateRef } } });
    const pdf = ascii(document.save().toBytes());
    expect(pdf).toContain(`/LastModified(D:20240302010405Z)/PieceInfo<</Illustrator<</LastModified(D:20240302010405Z)`);
    expect(pdf).toContain('stream\nprivate raw bytes (unchanged)\nendstream');
    expect(pdf).toContain('/Private 3 0 R');
  });

  it('writes form and document data, with the document date in Info ModDate', () => {
    const document = createDocument({ info: { modificationDate: lastModified } });
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)) }, content => {
      content.path(path => path.rect(0, 0, 20, 20));
    });
    group.pieceInfo({ lastModified, data: new Map([[new Uint8Array([0x82, 0x62]), { private: { kind: 'integer', value: 7 } }]]) });
    document.pieceInfo({ data: { App: { private: { kind: 'boolean', value: true } } } });
    const pdf = ascii(document.save().toBytes());
    expect(pdf).toContain('/#82b<</LastModified(D:20240302010405Z)/Private 7>>');
    expect(pdf).toContain('/ModDate(D:20240302010405Z)');
    expect(pdf).toContain('/PieceInfo<</App<</LastModified(D:20240302010405Z)');
  });

  it('requires an explicit Info modification date for document data and rejects direct private streams', () => {
    const document = createDocument();
    expect(() => {
      document.pieceInfo({ data: { App: {} } });
    }).toThrow(ValidationError);
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    const stream = { kind: 'stream', dictionary: new PdfDictionaryEntries(), data: new Uint8Array([1]) } as const;
    // @ts-expect-error ISO 32000-1:2008, 7.3.8.1 requires streams to be indirect, so Private takes direct objects only.
    page.pieceInfo({ lastModified, data: { App: { private: stream } } });
    expect(() => document.save()).toThrow(InvalidArgumentError);
  });
});

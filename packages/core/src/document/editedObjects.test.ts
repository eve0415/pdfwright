import type { LoadedDocument } from './loadDocument.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';

const load = (): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<<>>>>' },
          { number: 5, generation: 2, body: '(five)' },
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

describe('object changes', () => {
  it('replaces an object, keeping it apart from the caller value and from later reads', () => {
    const document = load();
    const value = pdfInteger(42);
    document.set(pdfReference(5, 2), value);
    const read = document.get(pdfReference(5, 2));
    expect([read, read === value]).toStrictEqual([value, false]);
  });

  it('shows changes to page views and returns copies of changed dictionaries', () => {
    const document = load();
    const mediaBox = pdfArray([0, 0, 20, 30].map(value => pdfInteger(value)));
    const page = pdfDictionary(
      new PdfDictionaryEntries([
        [pdfName('Type').bytes, pdfName('Page')],
        [pdfName('MediaBox').bytes, mediaBox],
      ]),
    );
    document.set(pdfReference(3, 0), page);
    page.entries.delete(pdfName('MediaBox').bytes);
    expect(document.page(0).boxes().MediaBox.rect).toStrictEqual([0, 0, 20, 30]);
    const copy = document.get(pdfReference(3, 0));
    expect(copy).toStrictEqual(document.get(pdfReference(3, 0)));
  });

  it('reports the warnings of a source object once however often it is read', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
            { number: 3, body: '<</A 1/A 2>>' },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    document.get(pdfReference(3, 0));
    document.get(pdfReference(3, 0));
    expect(document.warnings.map(warning => warning.code)).toStrictEqual(['duplicate-key']);
  });

  it('deletes objects and numbers new objects above every number in use', () => {
    const document = load();
    document.delete(pdfReference(5, 2));
    expect(document.get(pdfReference(5, 2))).toStrictEqual({ kind: 'null' });
    expect([document.object(pdfInteger(1)), document.object(pdfInteger(2))]).toStrictEqual([pdfReference(6, 0), pdfReference(7, 0)]);
    expect(document.get(pdfReference(7, 0))).toStrictEqual(pdfInteger(2));
  });

  it('refuses to change objects that are not in use or under another generation', () => {
    const document = load();
    expect(() => {
      document.set(pdfReference(4, 0), pdfInteger(1));
    }).toThrow(InvalidArgumentError);
    expect(() => {
      document.set(pdfReference(5, 0), pdfInteger(1));
    }).toThrow(InvalidArgumentError);
    document.delete(pdfReference(5, 2));
    expect(() => {
      document.delete(pdfReference(5, 2));
    }).toThrow(InvalidArgumentError);
  });
});

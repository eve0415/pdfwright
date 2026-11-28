import type { TestObject } from '../testing/pdfBuilder.ts';
import type { LoadedDocument } from './loadDocument.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { mm } from '../length/length.ts';
import { pdfInteger, pdfName } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { objectText } from './inspectSaved.ts';
import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

// A one-page document whose page dictionary holds `extra`, with further objects from 9 on.
const load = (extra: string, objects: ReadonlyArray<TestObject> = []): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/Resources<<>>${extra}>>` },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

describe('page rectangles', () => {
  // ISO 32000-1:2008, 7.9.5: a rectangle is an array of four numbers.
  it.each([
    ['three numbers', '/MediaBox[0 0 10]'],
    ['five numbers', '/MediaBox[0 0 10 10 10]'],
    ['a dictionary', '/MediaBox<</A 1>>'],
  ])('refuses a MediaBox of %s', (_, box) => {
    const page = load(box).page(0);
    expect(() => page.boxes()).toThrow(ParseError);
    expect(() => page.boxes()).toThrow(/the MediaBox of page 3 0 R/u);
  });

  // ISO 32000-1:2008, 7.9.5, NOTE: readers normalise a rectangle given by its other pair of corners.
  it('normalises corners and follows references to its numbers', () => {
    const swapped = load('/MediaBox[100 100 0 0]').page(0).boxes().MediaBox.rect;
    const referenced = load('/MediaBox[0 0 9 0 R 100]', [{ number: 9, body: '50' }])
      .page(0)
      .boxes().MediaBox.rect;
    expect([swapped, referenced]).toStrictEqual([
      [0, 0, 100, 100],
      [0, 0, 50, 100],
    ]);
  });

  it('reads a box set as an exact length at the default 5 fraction digits', () => {
    const page = load('/MediaBox[0 0 100 100]').page(0);
    page.setBox('TrimBox', rect(mm(10), mm(10), mm(20), mm(20)));
    expect(page.boxes().TrimBox.rect).toStrictEqual([28.34646, 28.34646, 56.69291, 56.69291]);
  });

  it('refuses a Rotate that is not a number, naming the page', () => {
    const page = load('/MediaBox[0 0 10 10]/Rotate/Ninety').page(0);
    expect(() => page.boxes()).toThrow(ParseError);
    expect(() => page.boxes()).toThrow(/the Rotate of page 3 0 R/u);
  });
});

describe('page resources', () => {
  // ISO 32000-1:2008, 7.7.3.3, Table 30: Resources is a dictionary.
  it.each([
    ['an integer', '/Resources 5', []],
    ['a reference to a string', '/Resources 9 0 R', [{ number: 9, body: '(text)' }]],
  ])('refuses at load a page whose Resources is %s', (_, resources, objects) => {
    const text = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]${resources}>>` },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]);
    expect(() => loadDocument(text.bytes)).toThrow(ParseError);
  });
});

describe('copies of page entries', () => {
  it('returns a fresh copy of the LastModified date and the PieceInfo on every call', () => {
    const page = load('/MediaBox[0 0 10 10]/LastModified(D:20260101000000Z)/PieceInfo<</Example<</Private 1>>>>').page(0);
    const date = page.lastModified();
    const piece = page.pieceInfo();
    if (date?.kind === 'string') {
      date.bytes.fill(0x58);
    }
    if (piece?.kind === 'dictionary') {
      piece.entries.set(pdfName('Example').bytes, pdfInteger(1));
    }
    expect([page.lastModified(), page.pieceInfo()].map(value => objectText(value ?? { kind: 'null' }))).toStrictEqual([
      '(D:20260101000000Z)',
      '<</Example<</Private 1>>>>',
    ]);
  });
});

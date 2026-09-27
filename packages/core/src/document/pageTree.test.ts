import type { TestObject } from '../testing/pdfBuilder.ts';
import type { LoadOptions, LoadedDocument } from './loadDocument.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ValidationError } from '../error/validationError.ts';
import { mm, pt } from '../length/length.ts';
import { pdfName, pdfReference, pdfString } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };

const load = (objects: readonly TestObject[], options?: LoadOptions): LoadedDocument =>
  loadDocument(buildPdf([{ xref: 'classic', objects: [catalog, ...objects], trailer: '/Root 1 0 R' }]).bytes, options);

// Root 2 holds MediaBox, Rotate and Resources; intermediate node 3 holds CropBox; pages 4 and 5 sit under 3, page 6 under the root.
const tree = [
  { number: 2, body: '<</Type/Pages/Kids[3 0 R 6 0 R]/Count 3/MediaBox[0 0 600 800]/Rotate 90/Resources<</Font<<>>>>>>' },
  { number: 3, body: '<</Kids[4 0 R 5 0 R]/Count 2/Parent 2 0 R/CropBox[10 10 590 790]>>' },
  { number: 4, body: '<</Type/Page/Parent 3 0 R/TrimBox[40 40 20 20]/UserUnit 2>>' },
  { number: 5, body: '<</Type/Page/Parent 3 0 R/MediaBox[0 0 300 400]/Rotate 0/Resources<</XObject<<>>>>/BleedBox 7 0 R>>' },
  { number: 6, body: '<</Type/Page/Parent 2 0 R>>' },
  { number: 7, body: '[5 5 295 395]' },
];

// Page tree nodes 2 to depth + 1, each the only kid of the one before; the root carries MediaBox and Resources.
const chain = (depth: number): TestObject[] =>
  Array.from({ length: depth }, (_, index) => ({
    number: index + 2,
    body: `<</Type/Pages/Kids[${String(index + 3)} 0 R]/Count 1${index === 0 ? '/MediaBox[0 0 7 7]/Resources<<>>' : ''}>>`,
  }));

const resourceKeys = (document: LoadedDocument, index: number): string[] =>
  [...document.page(index).resources().entries()].map(([key]) => new TextDecoder().decode(key));

describe('page tree', () => {
  it('lists pages in order through intermediate nodes, inferring a missing Type from Kids', () => {
    const document = load(tree);
    expect([document.pageCount, [0, 1, 2].map(index => document.page(index).reference.objectNumber)]).toStrictEqual([3, [4, 5, 6]]);
    expect(() => document.page(3)).toThrow(InvalidArgumentError);
    expect(() => document.page(-1)).toThrow(InvalidArgumentError);
  });

  it('inherits MediaBox, CropBox, Rotate and Resources and applies the Table 30 defaults', () => {
    const document = load(tree);
    expect(document.page(0).boxes()).toStrictEqual({
      MediaBox: { rect: [0, 0, 600, 800], explicit: true, inheritedFrom: pdfReference(2, 0) },
      CropBox: { rect: [10, 10, 590, 790], explicit: true, inheritedFrom: pdfReference(3, 0) },
      BleedBox: { rect: [10, 10, 590, 790], explicit: false },
      TrimBox: { rect: [20, 20, 40, 40], explicit: true },
      ArtBox: { rect: [10, 10, 590, 790], explicit: false },
      rotate: 90,
      userUnit: 2,
    });
    expect(document.page(1).boxes()).toMatchObject({
      MediaBox: { rect: [0, 0, 300, 400], explicit: true },
      BleedBox: { rect: [5, 5, 295, 395] },
      rotate: 0,
      userUnit: 1,
    });
    expect([resourceKeys(document, 0), resourceKeys(document, 1), resourceKeys(document, 2)]).toStrictEqual([['Font'], ['XObject'], ['Font']]);
  });

  it('returns copies of resources that do not change the document', () => {
    const document = load(tree);
    document.page(0).resources().set(pdfName('Extra').bytes, { kind: 'null' });
    expect(resourceKeys(document, 0)).toStrictEqual(['Font']);
  });

  it('warns about pages without resources and leaves the status intact', () => {
    const bare = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    ]);
    expect([bare.structure.status, bare.warnings.map(warning => warning.code), resourceKeys(bare, 0)]).toStrictEqual(['intact', ['resources-missing'], []]);
    expect(() => bare.page(0).boxes()).toThrow(new ParseError('page 3 0 R has no MediaBox, on itself or on an ancestor', 0));
  });

  it('reads inherited attributes that refer to missing objects as absent', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 5 5]/Resources<</Font<<>>>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox 9 0 R/Resources 9 0 R/TrimBox 9 0 R>>' },
    ]);
    expect([document.page(0).boxes().MediaBox.rect, document.page(0).boxes().TrimBox.explicit, resourceKeys(document, 0)]).toStrictEqual([
      [0, 0, 5, 5],
      false,
      ['Font'],
    ]);
  });

  it('keeps a malformed box number as read and throws when the box is used', () => {
    const malformed = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/Resources<<>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 --300 400]>>' },
    ]);
    expect([malformed.structure.status, malformed.warnings.map(warning => warning.code)]).toStrictEqual(['tolerated', ['invalid-token']]);
    expect(() => malformed.page(0).boxes()).toThrow(new ParseError('the MediaBox of page 3 0 R[2] must be a number but is the token --300', 0));
  });

  it('walks a deep tree and inherits from its root', () => {
    const nodes = chain(5000);
    const document = load([...nodes, { number: 5002, body: '<</Type/Page>>' }]);
    expect([document.pageCount, document.page(0).boxes().MediaBox]).toStrictEqual([
      1,
      { rect: [0, 0, 7, 7], explicit: true, inheritedFrom: pdfReference(2, 0) },
    ]);
  });

  it('throws for missing kids, kids of the wrong type and cycles instead of skipping them', () => {
    const root = { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' };
    expect(() => load([root])).toThrow(new ParseError('page tree node 2 0 R has kid 3 0 R, which is missing', 0));
    expect(() => load([root, { number: 3, body: '<</Type/Font>>' }])).toThrow(ParseError);
    expect(() => load([root, { number: 3, body: '[1]' }])).toThrow(ParseError);
    expect(() => load([root, { number: 3, body: '<</Type/Pages/Kids[2 0 R]/Count 1>>' }])).toThrow(ParseError);
  });

  it('refuses a root Count that differs from the leaves unless the leaves are accepted', () => {
    for (const count of [1, 3]) {
      const objects = [
        { number: 2, body: `<</Type/Pages/Kids[3 0 R 4 0 R]/Count ${String(count)}/MediaBox[0 0 1 1]/Resources<<>>>>` },
        { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
        { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
      ];
      expect(() => load(objects)).toThrow(ParseError);
      const document = load(objects, { pageCountMismatch: 'use-leaves' });
      expect([document.pageCount, document.structure.status, document.warnings.map(warning => warning.code)]).toStrictEqual([
        2,
        'intact',
        ['page-count-mismatch'],
      ]);
    }
  });
});

describe('page box edits', () => {
  it('sets a box on the page alone, leaving the ancestor it inherits from unchanged', () => {
    const document = load(tree);
    document.page(0).setBox('MediaBox', rect(pt(0), pt(0), pt(500), pt(700)));
    document.page(0).setBox('TrimBox', rect(mm(10), mm(10), mm(5), mm(5)));
    expect(document.page(0).boxes()).toMatchObject({
      MediaBox: { rect: [0, 0, 500, 700], explicit: true },
      TrimBox: { rect: [14.17323, 14.17323, 28.34646, 28.34646] },
    });
    expect([document.page(2).boxes().MediaBox.rect, document.get(pdfReference(2, 0))]).toStrictEqual([[0, 0, 600, 800], load(tree).get(pdfReference(2, 0))]);
  });

  it('removes a box so that the inherited value or the default applies', () => {
    const document = load(tree);
    document.page(1).setBox('MediaBox', undefined);
    document.page(0).setBox('TrimBox', undefined);
    expect([document.page(1).boxes().MediaBox, document.page(0).boxes().TrimBox]).toStrictEqual([
      { rect: [0, 0, 600, 800], explicit: true, inheritedFrom: pdfReference(2, 0) },
      { rect: [10, 10, 590, 790], explicit: false },
    ]);
  });

  it('refuses boxes outside the MediaBox, without area, or a removal that leaves no MediaBox', () => {
    const document = load(tree);
    const page = document.page(0);
    expect(() => {
      page.setBox('TrimBox', rect(pt(0), pt(0), pt(700), pt(10)));
    }).toThrow(ValidationError);
    expect(() => {
      page.setBox('CropBox', rect(pt(5), pt(5), pt(5), pt(10)));
    }).toThrow(ValidationError);
    const lone = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/Resources<<>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>' },
    ]);
    expect(() => {
      lone.page(0).setBox('MediaBox', undefined);
    }).toThrow(ValidationError);
    expect(lone.page(0).boxes().MediaBox.rect).toStrictEqual([0, 0, 10, 10]);
  });
});

describe('page LastModified', () => {
  it('sets and removes the date on request only', () => {
    const document = load(tree);
    expect(document.page(0).lastModified()).toBeUndefined();
    document.page(0).setLastModified(pdfDate({ year: 2026, month: 9, day: 27, hour: 3, minute: 4, second: 5, offset: 'Z' }));
    expect(document.page(0).lastModified()).toStrictEqual(pdfString(new TextEncoder().encode('D:20260927030405Z')));
    document.page(0).setLastModified(undefined);
    expect(document.page(0).lastModified()).toBeUndefined();
  });

  it('refuses to remove the date from a page with PieceInfo', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 1 1]/Resources<<>>>>' },
      { number: 3, body: "<</Type/Page/Parent 2 0 R/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')>>" },
    ]);
    expect(() => {
      document.page(0).setLastModified(undefined);
    }).toThrow(ValidationError);
    expect(document.page(0).pieceInfo()?.kind).toBe('dictionary');
  });
});

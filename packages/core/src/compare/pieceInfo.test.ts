import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PdfDifference, ValuePath } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { pt } from '../length/length.ts';
import { PdfDictionaryEntries, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const page = (pieceInfo = '<</Illustrator 9 0 R>>', extra = ''): TestObject => ({
  number: 3,
  body: `<</Type/Page/Parent 2 0 R/PieceInfo${pieceInfo}/LastModified(D:20070624192720-05'00')/MediaBox[0 0 612 792]/Resources<<>>${extra}>>`,
});

const objects = (overrides: readonly TestObject[] = [], catalog = ''): TestObject[] => {
  const base: TestObject[] = [
    { number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` },
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    page(),
    { number: 9, body: "<</LastModified(D:20070624192720-05'00')/Private 10 0 R>>" },
    { number: 10, body: streamBody('', 'AIPrivateData1 %%EndData') },
    { number: 11, body: '<</Title(Plate)>>' },
  ];
  const replaced = base.map(object => overrides.find(override => override.number === object.number) ?? object);
  return [...replaced, ...overrides.filter(override => !base.some(object => object.number === override.number))];
};

const load = (list: readonly TestObject[]): ReturnType<typeof loadDocument> =>
  loadDocument(buildPdf([{ xref: 'classic', objects: list, trailer: '/Root 1 0 R/Info 11 0 R' }]).bytes);

const kinds = (differences: readonly PdfDifference[]): string[] =>
  differences.map(difference => (difference.kind === 'piece-info' ? `piece-info:${difference.aspect}` : difference.kind));

const paths = (differences: readonly PdfDifference[]): ValuePath[] =>
  differences.map(difference => (difference.kind === 'last-modified' ? difference.path : []));

const source = load(objects());

describe('page-piece data, LastModified and attribute comparison', () => {
  it('keeps page-piece data identical in all three aspects across a box edit', () => {
    const edited = load(objects());
    edited.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    for (const mode of ['incremental', 'full'] as const) {
      const saved = loadDocument(edited.save({ mode }).chunks);
      expect(kinds(compareDocuments(source, saved).differences)).toStrictEqual(['page-box']);
    }
  });

  it('reports changed private data by value and by stored bytes', () => {
    const changed = load(objects([{ number: 10, body: streamBody('', 'AIPrivateData1 %%EndDatX') }]));
    expect(kinds(compareDocuments(source, changed).differences)).toStrictEqual(['piece-info:value', 'piece-info:stream-bytes']);
  });

  it('reports a changed date or scalar in private data by value only', () => {
    const dated = load(objects([{ number: 9, body: '<</LastModified(D:20250101000000Z)/Private 10 0 R>>' }]));
    const scalar = load(objects([{ number: 9, body: "<</LastModified(D:20070624192720-05'00')/Private 10 0 R/Version 2>>" }]));
    expect([kinds(compareDocuments(source, dated).differences), kinds(compareDocuments(source, scalar).differences)]).toStrictEqual([
      ['last-modified'],
      ['piece-info:value'],
    ]);
  });

  it('reports a direct PieceInfo whose source bytes changed although its value did not', () => {
    const respaced = load(objects([page('<< /Illustrator 9 0 R >>')]));
    expect(compareDocuments(source, respaced).differences).toMatchObject([
      {
        kind: 'piece-info',
        owner: { kind: 'page', page: 0 },
        aspect: 'source-bytes',
        a: { text: '<</Illustrator 9 0 R>>' },
        b: { text: '<< /Illustrator 9 0 R >>' },
      },
    ]);
  });

  it('reports LastModified changes on the page and in data dictionaries', () => {
    const edited = load(objects([{ number: 9, body: '<</LastModified(D:20250101000000Z)/Private 10 0 R>>' }]));
    edited.page(0).setLastModified(pdfDate({ year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5, offset: 'Z' }));
    const { differences } = compareDocuments(source, edited, { include: ['lastModified'] });
    expect(paths(differences)).toStrictEqual([['PieceInfo', 'Illustrator', 'LastModified'], ['LastModified']]);
  });

  it('compares references to pages by page position and does not report page changes as catalog changes', () => {
    const outlined = objects(
      [
        { number: 12, body: '<</Count 1/First 13 0 R/Last 13 0 R>>' },
        { number: 13, body: '<</Title(Page)/Parent 12 0 R/Dest[3 0 R/Fit]>>' },
      ],
      '/Outlines 12 0 R',
    );
    const original = load(outlined);
    const edited = load(outlined);
    edited.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    const saved = loadDocument(edited.save().chunks);
    expect(kinds(compareDocuments(original, saved).differences)).toStrictEqual(['page-box']);
  });

  it('reports other page entries, catalog and Info changes, and settled duplicate keys', () => {
    const changed = load(objects([page(undefined, '/Group<</S/Transparency>>/Rotate 0/Rotate 0'), { number: 11, body: '<</Title(Other)>>' }], '/Lang(en)'));
    expect(kinds(compareDocuments(source, changed).differences)).toStrictEqual([
      'page-attribute',
      'ambiguous-duplicate-key',
      'document-attribute',
      'document-attribute',
    ]);
    const document = load(objects());
    document.set(pdfReference(11, 0), { kind: 'dictionary', entries: new PdfDictionaryEntries([[pdfName('Title').bytes, pdfName('Plate')]]) });
    expect(compareDocuments(source, document, { include: ['documentAttributes'] }).differences).toMatchObject([
      { kind: 'document-attribute', path: ['Info', 'Title'] },
    ]);
  });
});

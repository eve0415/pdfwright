import type { LoadedDocument } from '../document/loadDocument.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PdfDifference, ValuePath } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { pt } from '../length/length.ts';
import { PdfDictionaryEntries, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const page = (pieceInfo = '<</Illustrator 9 0 R>>', extra = '', resources = '<<>>', lastModified = "/LastModified(D:20070624192720-05'00')"): TestObject => ({
  number: 3,
  body: `<</Type/Page/Parent 2 0 R/PieceInfo${pieceInfo}${lastModified}/MediaBox[0 0 612 792]/Resources${resources}${extra}>>`,
});

const objects = (overrides: ReadonlyArray<TestObject> = [], catalog = ''): Array<TestObject> => {
  const base: Array<TestObject> = [
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

const load = (list: ReadonlyArray<TestObject>, trailer = '/Root 1 0 R/Info 11 0 R'): LoadedDocument =>
  loadDocument(buildPdf([{ xref: 'classic', objects: list, trailer }]).bytes);

const kinds = (differences: ReadonlyArray<PdfDifference>): Array<string> =>
  differences.map(difference => (difference.kind === 'piece-info' ? `piece-info:${difference.aspect}` : difference.kind));

const paths = (differences: ReadonlyArray<PdfDifference>): Array<ValuePath> =>
  differences.map(difference => (difference.kind === 'last-modified' ? difference.path : []));

// Each difference as its kind, or piece-info aspect, followed by its path.
const places = (differences: ReadonlyArray<PdfDifference>): Array<Array<string | number>> =>
  differences.map(difference => [kinds([difference])[0] ?? '', ...('path' in difference ? difference.path : [])]);

const source = load(objects());

const named = (name: string, data = 'AIPrivateData1 %%EndData'): LoadedDocument =>
  load(objects([page(`<</${name} 9 0 R>>`), { number: 10, body: streamBody('', data) }]));

const outlinedTo = (target: number): LoadedDocument =>
  load(
    objects(
      [
        { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>' },
        { number: 4, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>' },
        { number: 12, body: '<</Count 1/First 13 0 R/Last 13 0 R>>' },
        { number: 13, body: `<</Title(Page)/Parent 12 0 R/Dest[${String(target)} 0 R/Fit]>>` },
      ],
      '/Outlines 12 0 R',
    ),
  );

const unreadable = (): LoadedDocument => load(objects([page(' 8 0 R'), { number: 8, body: '<</Type/Font/Subtype [1 2>>' }]));

const catalogData = (data: string, date = 'D:2020'): LoadedDocument =>
  load(
    objects(
      [
        { number: 12, body: '<</Private 13 0 R>>' },
        { number: 13, body: streamBody('', data) },
      ],
      `/PieceInfo<</App 12 0 R>>/LastModified(${date})`,
    ),
  );

const indirect = (number: number, body: string): LoadedDocument => load(objects([page(` ${String(number)} 0 R`), { number, body }]));

describe('page-piece data, LastModified and attribute comparison', () => {
  it('compares non-ASCII application names by their original name bytes', () => {
    expect(compareDocuments(named('#E9'), named('#E9')).differences).toStrictEqual([]);
    expect(places(compareDocuments(named('#E9'), named('#E8')).differences)).toStrictEqual([
      ['piece-info:value', 'PieceInfo', '\u00E9'],
      ['piece-info:value', 'PieceInfo', '\u00E8'],
      ['piece-info:source-bytes', 'PieceInfo'],
    ]);
    expect(places(compareDocuments(named('#E9'), named('#E9', 'AIPrivateData1 %%EndDatX')).differences)).toStrictEqual([
      ['piece-info:value', 'PieceInfo', '\u00E9', 'Private'],
      ['piece-info:stream-bytes', 'PieceInfo', '\u00E9', 'Private'],
    ]);
  });

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
    const renumbered = load(
      objects(
        [
          { number: 2, body: '<</Type/Pages/Kids[5 0 R]/Count 1>>' },
          { number: 3, body: '<<>>' },
          { ...page(), number: 5 },
          { number: 12, body: '<</Count 1/First 13 0 R/Last 13 0 R>>' },
          { number: 13, body: '<</Title(Page)/Parent 12 0 R/Dest[5 0 R/Fit]>>' },
        ],
        '/Outlines 12 0 R',
      ),
    );
    expect(compareDocuments(original, renumbered).differences).toStrictEqual([]);
  });

  it('reports a reference to a page that names another page position', () => {
    expect(compareDocuments(outlinedTo(3), outlinedTo(4)).differences).toStrictEqual([
      { kind: 'document-attribute', path: ['Root', 'Outlines', 'First', 'Dest', 0], a: { kind: 'page', text: 'page 0' }, b: { kind: 'page', text: 'page 1' } },
    ]);
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

  it('reports page-piece and LastModified differences only under their own area, and unreadable page-piece data under either', () => {
    const changed = load(objects([{ number: 10, body: streamBody('', 'AIPrivateData1 %%EndDatX') }]));
    const dated = load(objects([{ number: 9, body: '<</LastModified(D:20250101000000Z)/Private 10 0 R>>' }]));
    expect([
      compareDocuments(source, changed, { include: ['lastModified'] }).differences,
      compareDocuments(source, dated, { include: ['pieceInfo'] }).differences,
    ]).toStrictEqual([[], []]);
    const both = [
      { kind: 'undecodable', where: ['page', 0, 'PieceInfo'], document: 'a' },
      { kind: 'undecodable', where: ['page', 0, 'PieceInfo'], document: 'b' },
    ];
    expect([
      compareDocuments(unreadable(), unreadable(), { include: ['lastModified'] }).differences,
      compareDocuments(unreadable(), unreadable(), { include: ['pieceInfo'] }).differences,
    ]).toMatchObject([both, both]);
  });

  it('compares the page-piece data and LastModified of the catalog', () => {
    const owner = { kind: 'catalog' };
    expect(compareDocuments(catalogData('x'), catalogData('y')).differences).toMatchObject([
      { kind: 'piece-info', owner, aspect: 'value', path: ['PieceInfo', 'App', 'Private'] },
      { kind: 'piece-info', owner, aspect: 'stream-bytes', path: ['PieceInfo', 'App', 'Private'] },
    ]);
    expect(compareDocuments(catalogData('x'), catalogData('x', 'D:2021')).differences).toStrictEqual([
      { kind: 'last-modified', owner, path: ['LastModified'], a: latin1Bytes('D:2020'), b: latin1Bytes('D:2021') },
    ]);
  });

  it('reports page-piece data of an application only one document has', () => {
    const extra = load(objects([page('<</Illustrator 9 0 R/App2<</Private 1>>>>')]));
    expect(compareDocuments(extra, source).differences).toMatchObject([
      { kind: 'piece-info', owner: { kind: 'page', page: 0 }, aspect: 'value', path: ['PieceInfo', 'App2'], a: { kind: 'dictionary' }, b: { kind: 'absent' } },
      { kind: 'piece-info', aspect: 'source-bytes', path: ['PieceInfo'] },
    ]);
  });

  it('compares a PieceInfo that is not a dictionary as a value', () => {
    expect(compareDocuments(load(objects([page(' 5')])), load(objects([page('<<>>')]))).differences).toMatchObject([
      { kind: 'piece-info', aspect: 'value', path: ['PieceInfo'], a: { kind: 'integer', text: '5' }, b: { kind: 'dictionary', text: '<<>>' } },
      { kind: 'piece-info', aspect: 'source-bytes', path: ['PieceInfo'], a: { text: '5' }, b: { text: '<<>>' } },
    ]);
  });

  it('reports a LastModified that only one document has', () => {
    const undated = load(objects([{ number: 9, body: '<</Private 10 0 R>>' }]));
    const pageUndated = load(objects([page(undefined, '', '<<>>', '')]));
    const date = latin1Bytes("D:20070624192720-05'00'");
    const owner = { kind: 'page', page: 0 };
    expect([compareDocuments(source, undated).differences, compareDocuments(source, pageUndated).differences]).toStrictEqual([
      [{ kind: 'last-modified', owner, path: ['PieceInfo', 'Illustrator', 'LastModified'], a: date, b: undefined }],
      [{ kind: 'last-modified', owner, path: ['LastModified'], a: date, b: undefined }],
    ]);
  });

  it('compares source bytes only for a PieceInfo written directly in a page the document has not changed', () => {
    expect(compareDocuments(indirect(20, '<</Illustrator 9 0 R>>'), indirect(21, '<< /Illustrator 9 0 R >>')).differences).toStrictEqual([]);
    const respaced = load(objects([page('<< /Illustrator 9 0 R >>')]));
    respaced.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    expect(kinds(compareDocuments(source, respaced).differences)).toStrictEqual(['page-box']);
  });

  it('reports private data recompressed to the same decoded bytes by stored bytes only', () => {
    const deflated = latin1Text(deflateZlib(latin1Bytes('AIPrivateData1 %%EndData')));
    const recompressed = load(objects([{ number: 10, body: streamBody('/Filter/FlateDecode', deflated) }]));
    expect(kinds(compareDocuments(source, recompressed).differences)).toStrictEqual(['piece-info:stream-bytes']);
  });
});

// The base document with the page resources replaced, and further objects such as forms and their page-piece data.
const withForms = (resources: string, forms: ReadonlyArray<TestObject>): LoadedDocument => load(objects([page(undefined, '', resources), ...forms]));

const form = (number: number, dictionary: string): TestObject => ({ number, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 1 1]${dictionary}`, '') });

const owned = (data: string): LoadedDocument =>
  withForms('<</XObject<</X1 12 0 R>>>>', [form(12, '/PieceInfo<</App<</Private 13 0 R>>>>'), { number: 13, body: streamBody('', data) }]);

const nested = (data: string): LoadedDocument =>
  withForms('<</XObject<</X1 12 0 R>>>>', [
    form(12, '/Resources<</XObject<</X2 14 0 R>>>>'),
    form(14, '/PieceInfo<</App<</Private 13 0 R>>>>'),
    { number: 13, body: streamBody('', data) },
  ]);

const recursive = (value: number): LoadedDocument =>
  withForms('<</XObject<</X1 12 0 R>>>>', [form(12, `/Resources<</XObject<</Self 12 0 R>>>>/PieceInfo<</App<</V ${String(value)}>>>>`)]);

describe('page-piece data of forms', () => {
  it('reports page-piece data of a form with the form as its owner', () => {
    const owner = { kind: 'form', page: 0, path: ['Resources', 'XObject', 'X1'] };
    expect(compareDocuments(owned('x'), owned('y')).differences).toMatchObject([
      { kind: 'page-resources', page: 0, path: ['Resources', 'XObject', 'X1', 'PieceInfo', 'App', 'Private'] },
      { kind: 'piece-info', owner, aspect: 'value', path: ['PieceInfo', 'App', 'Private'] },
      { kind: 'piece-info', owner, aspect: 'stream-bytes', path: ['PieceInfo', 'App', 'Private'] },
    ]);
  });

  it('follows forms through the resources of forms', () => {
    const owner = { kind: 'form', page: 0, path: ['Resources', 'XObject', 'X1', 'Resources', 'XObject', 'X2'] };
    expect(compareDocuments(nested('x'), nested('y'), { include: ['pieceInfo'] }).differences).toMatchObject([
      { kind: 'piece-info', owner, aspect: 'value' },
      { kind: 'piece-info', owner, aspect: 'stream-bytes' },
    ]);
  });

  it('visits a form that names itself once', () => {
    const owner = { kind: 'form', page: 0, path: ['Resources', 'XObject', 'X1'] };
    expect(compareDocuments(recursive(1), recursive(1)).differences).toStrictEqual([]);
    expect(compareDocuments(recursive(1), recursive(2), { include: ['pieceInfo'] }).differences).toMatchObject([
      { kind: 'piece-info', owner, aspect: 'value', path: ['PieceInfo', 'App', 'V'] },
      { kind: 'piece-info', owner, aspect: 'source-bytes', path: ['PieceInfo'] },
    ]);
  });

  it('gives a form only one document has no page-piece owner', () => {
    const present = withForms('<</XObject<</X1 12 0 R>>>>', [form(12, '/PieceInfo<</App<</Private 1>>>>')]);
    expect(kinds(compareDocuments(present, source).differences)).toStrictEqual(['page-resources']);
  });
});

const annotated = (text: string): LoadedDocument => load(objects([page(undefined, `/Annots[<</Subtype/Text/Rect[0 0 1 1]/Contents(${text})>>]`)]));

describe('page and document attributes', () => {
  it('leaves page entries that other areas compare out of the page attributes', () => {
    const dated = load(objects([page(undefined, '', '<<>>', '/LastModified(D:20250101000000Z)')]));
    expect(compareDocuments(source, dated, { include: ['pageAttributes'] }).differences).toStrictEqual([]);
  });

  it('reports a change inside an annotation with its path from the page', () => {
    expect(compareDocuments(annotated('a'), annotated('b')).differences).toStrictEqual([
      { kind: 'page-attribute', page: 0, path: ['Annots', 0, 'Contents'], a: { kind: 'string', text: '(a)' }, b: { kind: 'string', text: '(b)' } },
    ]);
  });

  it('reports a document information dictionary only one document has', () => {
    expect(compareDocuments(source, load(objects(), '/Root 1 0 R')).differences).toStrictEqual([
      { kind: 'document-attribute', path: ['Info'], a: { kind: 'dictionary', text: '<</Title(Plate)>>' }, b: { kind: 'absent', text: '' } },
    ]);
  });
});

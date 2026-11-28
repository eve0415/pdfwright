import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PdfDifference } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { cmyk } from '../document/color.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { pt } from '../length/length.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };

const pdf = (objects: ReadonlyArray<TestObject>): Uint8Array => buildPdf([{ xref: 'classic', objects: [catalog, ...objects], trailer: '/Root 1 0 R' }]).bytes;

const twoPages = pdf([
  { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 600 800]/Resources<<>>>>' },
  { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
  { number: 4, body: '<</Type/Page/Parent 2 0 R/Rotate 90>>' },
]);

describe('document comparison: pages and boxes', () => {
  it('finds no difference between a document and its saves', () => {
    const source = loadDocument(twoPages);
    const incremental = loadDocument(twoPages);
    incremental.page(0).setBox('MediaBox', rect(pt(0), pt(0), pt(600), pt(800)));
    const saved = loadDocument(incremental.save({ mode: 'incremental' }).chunks);
    const full = loadDocument(loadDocument(twoPages).save({ mode: 'full' }).chunks);
    expect([compareDocuments(source, saved), compareDocuments(source, full)]).toStrictEqual([
      { equal: true, differences: [] },
      { equal: true, differences: [] },
    ]);
  });

  it('reports a changed box, Rotate and page count', () => {
    const edited = loadDocument(twoPages);
    edited.page(1).setBox('TrimBox', rect(pt(10), pt(10), pt(500), pt(700)));
    const onePage = loadDocument(
      pdf([
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 600 800]/Resources<<>>>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/Rotate 180>>' },
      ]),
    );
    expect(compareDocuments(loadDocument(twoPages), edited).differences).toStrictEqual([
      { kind: 'page-box', page: 1, box: 'TrimBox', a: { value: [0, 0, 600, 800], explicit: false }, b: { value: [10, 10, 500, 700], explicit: true } },
    ]);
    expect(compareDocuments(loadDocument(twoPages), onePage, { include: ['pages', 'boxes'] }).differences).toStrictEqual([
      { kind: 'page-count', a: 2, b: 1 },
      { kind: 'page-box', page: 0, box: 'Rotate', a: { value: 0, explicit: true }, b: { value: 180, explicit: true } },
    ]);
  });

  it('refuses values that are not loaded documents', () => {
    const source = loadDocument(twoPages);
    expect(() => compareDocuments(source, { ...source })).toThrow(InvalidArgumentError);
  });
});

const unreadable = (entry: string): Uint8Array =>
  pdf([
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
    { number: 3, body: `<</Type/Page/Parent 2 0 R${entry}>>` },
    { number: 8, body: '<</Type/Font/Subtype [1 2>>' },
  ]);

describe('document comparison: objects that cannot be parsed', () => {
  it.each([
    ['/PieceInfo 8 0 R', [['page', 0, 'PieceInfo']]],
    ['/Contents[8 0 R]', [['page', 0, 'Contents']]],
    ['/MediaBox 8 0 R', [['page', 0]]],
    [
      '/Annots[8 0 R]',
      [
        ['page', 0, 'Annots', 0],
        ['page', 0, 'Annots'],
      ],
    ],
    [
      '/Resources<</XObject<</X1 8 0 R>>>>',
      [
        ['page', 0, 'Resources', 'XObject', 'X1'],
        ['page', 0, 'Resources'],
        ['page', 0, 'Resources', 'XObject', 'X1'],
      ],
    ],
  ])('reports %s in each document instead of throwing', (entry, places) => {
    const bytes = unreadable(entry);
    const { differences } = compareDocuments(loadDocument(bytes), loadDocument(Uint8Array.from(bytes)));
    const expected = places.flatMap(where => [
      { kind: 'undecodable', where, document: 'a' },
      { kind: 'undecodable', where, document: 'b' },
    ]);
    expect(differences).toMatchObject(expected);
  });
});

const duplicated = (resources: string): Uint8Array =>
  pdf([
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
    { number: 3, body: `<</Type/Page/Parent 2 0 R/Resources${resources}>>` },
    { number: 7, body: '<</CS0/DeviceRGB/CS0/DeviceCMYK>>' },
  ]);

const emptyPages = { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' };

const holding = (pages: string, page: string, objects: ReadonlyArray<TestObject>): Uint8Array =>
  pdf([
    { number: 2, body: `<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]${pages}>>` },
    { number: 3, body: `<</Type/Page/Parent 2 0 R${page}>>` },
    { number: 6, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
    ...objects,
  ]);

const tree = (rotate: string): Uint8Array =>
  pdf([
    { number: 2, body: `<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 100 100]${rotate}>>` },
    { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
  ]);

const streamed = (trailer: string): Uint8Array => buildPdf([{ xref: 'stream', objects: [catalog, emptyPages], trailer }]).bytes;

describe('document comparison: duplicate keys', () => {
  it.each(['<</ColorSpace<</CS0/DeviceRGB/CS0/DeviceCMYK>>>>', '<</ColorSpace 7 0 R>>'])('reports a duplicate key that an edit settled in %s', resources => {
    const bytes = duplicated(resources);
    const edited = loadDocument(bytes);
    const spot = edited.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 1) });
    edited.page(0).appendContent(builder => {
      builder.fillColor(spot, 1);
    });
    const saved = loadDocument(edited.save().chunks);
    const { differences } = compareDocuments(loadDocument(bytes), saved, { include: ['resources', 'pageAttributes'] });
    expect(differences).toContainEqual({
      kind: 'ambiguous-duplicate-key',
      where: ['page', 0, 'Resources', 'ColorSpace'],
      key: Uint8Array.of(0x43, 0x53, 0x30),
      document: 'a',
    });
  });

  it.each([
    {
      name: 'an inherited resource dictionary',
      a: holding('/Resources<</Font<</F1 6 0 R/F1 6 0 R>>>>', '', []),
      b: holding('/Resources<</Font<</F1 6 0 R>>>>', '', []),
      where: ['page', 0, 'Resources', 'Font'],
    },
    {
      name: 'a content stream dictionary',
      a: holding('', '/Contents 5 0 R', [{ number: 5, body: '<</Length 0/Length 0>>stream\n\nendstream' }]),
      b: holding('', '/Contents 5 0 R', [{ number: 5, body: '<</Length 0>>stream\n\nendstream' }]),
      where: ['page', 0, 'Contents', 0],
    },
    {
      name: 'an indirect PieceInfo',
      a: holding('', '/PieceInfo 7 0 R', [{ number: 7, body: '<</App<</Private 1/Private 1>>>>' }]),
      b: holding('', '/PieceInfo 7 0 R', [{ number: 7, body: '<</App<</Private 1>>>>' }]),
      where: ['page', 0, 'PieceInfo', 'App'],
    },
    {
      name: 'the trailer',
      a: buildPdf([{ xref: 'classic', objects: [catalog, emptyPages], trailer: '/Root 1 0 R/Root 1 0 R' }]).bytes,
      b: buildPdf([{ xref: 'classic', objects: [catalog, emptyPages], trailer: '/Root 1 0 R' }]).bytes,
      where: ['trailer'],
    },
  ])('reports a duplicate key in $name, naming the document that holds it', ({ a, b, where }) => {
    expect([compareDocuments(loadDocument(a), loadDocument(b)).differences, compareDocuments(loadDocument(b), loadDocument(a)).differences]).toMatchObject([
      [{ kind: 'ambiguous-duplicate-key', where, document: 'a' }],
      [{ kind: 'ambiguous-duplicate-key', where, document: 'b' }],
    ]);
  });

  it('reports nothing for a duplicate key both documents hold at the same place', () => {
    const both = holding('/Resources<</Font<</F1 6 0 R/F1 6 0 R>>>>', '', []);
    expect(compareDocuments(loadDocument(both), loadDocument(Uint8Array.from(both)))).toStrictEqual({ equal: true, differences: [] });
  });

  // ISO 32000-1:2008, 7.7.3.4: an inherited attribute is read from the ancestor that holds it, so that ancestor's duplicate key counts for every page under it.
  it('reports a duplicate key in an inheritable entry of an ancestor on each page that inherits it', () => {
    const rotate = latin1Bytes('Rotate');
    expect(compareDocuments(loadDocument(holding('/Rotate 90/Rotate 0', '', [])), loadDocument(holding('/Rotate 0', '', []))).differences).toStrictEqual([
      { kind: 'ambiguous-duplicate-key', where: ['page', 0], key: rotate, document: 'a' },
    ]);
    expect(compareDocuments(loadDocument(tree('/Rotate 90/Rotate 0')), loadDocument(tree('/Rotate 0'))).differences).toStrictEqual([
      { kind: 'ambiguous-duplicate-key', where: ['page', 0], key: rotate, document: 'a' },
      { kind: 'ambiguous-duplicate-key', where: ['page', 1], key: rotate, document: 'a' },
    ]);
  });

  it('reports a duplicate key in the dictionary of a cross-reference stream', () => {
    expect(compareDocuments(loadDocument(streamed('/Root 1 0 R/Root 1 0 R')), loadDocument(streamed('/Root 1 0 R'))).differences).toStrictEqual([
      { kind: 'ambiguous-duplicate-key', where: ['trailer'], key: latin1Bytes('Root'), document: 'a' },
    ]);
  });
});

const onePage = (page: string, pages = ''): Uint8Array =>
  pdf([
    { number: 2, body: `<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 600 800]/Resources<<>>${pages}>>` },
    { number: 3, body: `<</Type/Page/Parent 2 0 R${page}>>` },
    { number: 4, body: streamBody('', '0 0 m S') },
    { number: 5, body: streamBody('', '1 1 m S') },
  ]);

const userUnit = (a: number, b: number): PdfDifference => ({
  kind: 'page-box',
  page: 0,
  box: 'UserUnit',
  a: { value: a, explicit: true },
  b: { value: b, explicit: true },
});

const font = (body: string): Uint8Array =>
  pdf([
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
    { number: 3, body: '<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 8 0 R>>>>>>' },
    { number: 8, body },
  ]);

describe('document comparison: results and areas', () => {
  it('is unequal when it reports a difference', () => {
    expect(compareDocuments(loadDocument(twoPages), loadDocument(onePage('')))).toStrictEqual({
      equal: false,
      differences: [{ kind: 'page-count', a: 2, b: 1 }],
    });
  });

  // ISO 32000-1:2008, 7.7.3.3, Table 30: CropBox defaults to the MediaBox, so a CropBox equal to it differs only in being explicit.
  it('reports a box that differs only in being explicit', () => {
    expect(compareDocuments(loadDocument(onePage('/CropBox[0 0 600 800]')), loadDocument(onePage(''))).differences).toStrictEqual([
      { kind: 'page-box', page: 0, box: 'CropBox', a: { value: [0, 0, 600, 800], explicit: true }, b: { value: [0, 0, 600, 800], explicit: false } },
    ]);
  });

  // ISO 32000-1:2008, 7.7.3.3, Table 30: UserUnit defaults to 1.0 and, unlike Rotate, is not inheritable.
  it('compares UserUnit on the page itself and ignores one on an ancestor', () => {
    const onAncestor = loadDocument(onePage('', '/UserUnit 2'));
    expect([
      compareDocuments(loadDocument(onePage('/UserUnit 2')), loadDocument(onePage(''))).differences,
      compareDocuments(onAncestor, loadDocument(onePage(''))).differences,
      compareDocuments(onAncestor, loadDocument(onePage('/UserUnit 2'))).differences,
    ]).toStrictEqual([[userUnit(2, 1)], [], [userUnit(1, 2)]]);
  });

  it('compares only the areas it is asked to', () => {
    const [first, second] = [loadDocument(onePage('/Contents 4 0 R')), loadDocument(onePage('/Contents 5 0 R'))];
    expect([
      compareDocuments(first, second).differences,
      compareDocuments(first, second, { include: ['boxes'] }),
      compareDocuments(loadDocument(twoPages), second, { include: [] }),
    ]).toStrictEqual([
      [{ kind: 'page-content', page: 0, operationsA: 2, operationsB: 2, commonPrefix: 0, commonSuffix: 1 }],
      { equal: true, differences: [] },
      { equal: true, differences: [] },
    ]);
  });

  it('compares no page beyond the shorter page count', () => {
    const extra = pdf([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 600 800]/Resources<<>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
      { number: 4, body: '<</Type/Page/Parent 2 0 R/TrimBox[0 0 10 10]/Rotate 90>>' },
    ]);
    expect(compareDocuments(loadDocument(onePage('')), loadDocument(extra), { include: ['pages', 'boxes'] }).differences).toStrictEqual([
      { kind: 'page-count', a: 1, b: 2 },
    ]);
  });

  it('reports an object that only one document cannot parse in that document only', () => {
    const helvetica = { subtype: 'Type1', baseFont: 'Helvetica', encoding: '', program: '' };
    expect(
      compareDocuments(loadDocument(font('<</Type/Font/Subtype [1 2>>')), loadDocument(font('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'))).differences,
    ).toMatchObject([
      { kind: 'undecodable', where: ['page', 0, 'Resources', 'Font', 'F1'], document: 'a' },
      { kind: 'undecodable', where: ['page', 0, 'Resources'], document: 'a' },
      { kind: 'font-set', page: 0, added: [helvetica], removed: [] },
      { kind: 'font-set', page: 'document', added: [helvetica], removed: [] },
    ]);
  });
});

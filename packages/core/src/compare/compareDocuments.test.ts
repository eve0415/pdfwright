import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PdfDifference } from './pdfDifference.ts';

import fc from 'fast-check';
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

interface PageSpec {
  readonly rotate: number;
  readonly trim: number | null;
  readonly operations: ReadonlyArray<string>;
  readonly fonts: ReadonlyArray<number>;
}

interface DocumentSpec {
  readonly pages: ReadonlyArray<PageSpec>;
  /** The page an outline item points at, if the document has an outline. */
  readonly outline: number | null;
  readonly title: string | null;
}

const FONTS = ['Helvetica', 'Courier', 'Times-Roman'];

const pageSpec: fc.Arbitrary<PageSpec> = fc.record({
  rotate: fc.constantFrom(0, 90, 180, 270),
  trim: fc.option(fc.integer({ min: 10, max: 100 })),
  operations: fc.array(fc.constantFrom('0 0 m', '10 10 l', 'S', 'q', 'Q', '1 g', '0.5 G'), { maxLength: 4 }),
  fonts: fc.subarray([0, 1, 2]),
});

const documentSpec: fc.Arbitrary<DocumentSpec> = fc.array(pageSpec, { minLength: 1, maxLength: 3 }).chain(pages =>
  fc.record({
    pages: fc.constant(pages),
    outline: fc.option(fc.integer({ min: 0, max: pages.length - 1 })),
    title: fc.option(fc.constantFrom('Plate', 'Proof')),
  }),
);

// The object numbers a document of this shape uses: catalog, page tree, fonts, Info, outline, and a page and its content for each page.
const objectNumbers = (spec: DocumentSpec): Array<number> => [1, 2, 3, 4, 5, 6, 7, 8, ...spec.pages.flatMap((_, index) => [10 + 2 * index, 11 + 2 * index])];

// Writes the document with each object number n written as number(n), so that one shape can be numbered in different ways.
const writeSpec = (spec: DocumentSpec, number: (logical: number) => number = logical => logical): Uint8Array => {
  const ref = (logical: number): string => `${String(number(logical))} 0 R`;
  const objects: Array<TestObject> = [
    { number: number(1), body: `<</Type/Catalog/Pages ${ref(2)}${spec.outline === null ? '' : `/Outlines ${ref(7)}`}>>` },
    {
      number: number(2),
      body: `<</Type/Pages/Kids[${spec.pages.map((_, index) => ref(10 + 2 * index)).join(' ')}]/Count ${String(spec.pages.length)}/MediaBox[0 0 200 300]>>`,
    },
    ...FONTS.map((font, index): TestObject => ({ number: number(3 + index), body: `<</Type/Font/Subtype/Type1/BaseFont/${font}>>` })),
    { number: number(6), body: `<</Title(${spec.title ?? ''})>>` },
    { number: number(7), body: `<</Count 1/First ${ref(8)}/Last ${ref(8)}>>` },
    { number: number(8), body: `<</Title(Item)/Parent ${ref(7)}/Dest[${ref(10 + 2 * (spec.outline ?? 0))}/Fit]>>` },
    ...spec.pages.flatMap((page, index): Array<TestObject> => [
      {
        number: number(10 + 2 * index),
        body: `<</Type/Page/Parent ${ref(2)}/Contents ${ref(11 + 2 * index)}/Rotate ${String(page.rotate)}${page.trim === null ? '' : `/TrimBox[0 0 ${String(page.trim)} ${String(page.trim)}]`}/Resources<</Font<<${page.fonts.map(font => `/F${String(font)} ${ref(3 + font)}`).join('')}>>>>>>`,
      },
      { number: number(11 + 2 * index), body: streamBody('', page.operations.join(' ')) },
    ]),
  ];
  return buildPdf([{ xref: 'classic', objects, trailer: `/Root ${ref(1)}${spec.title === null ? '' : `/Info ${ref(6)}`}` }]).bytes;
};

// The same difference as compareDocuments(b, a) would report it.
const swapped = (difference: PdfDifference): PdfDifference => {
  switch (difference.kind) {
    case 'page-count': {
      return { ...difference, a: difference.b, b: difference.a };
    }
    case 'page-box': {
      return { ...difference, a: difference.b, b: difference.a };
    }
    case 'page-resources': {
      return { ...difference, a: difference.b, b: difference.a };
    }
    case 'piece-info': {
      return { ...difference, a: difference.b, b: difference.a };
    }
    case 'last-modified': {
      return { ...difference, a: difference.b, b: difference.a };
    }
    case 'page-attribute': {
      return { ...difference, a: difference.b, b: difference.a };
    }
    case 'document-attribute': {
      return { ...difference, a: difference.b, b: difference.a };
    }
    case 'page-content': {
      return { ...difference, operationsA: difference.operationsB, operationsB: difference.operationsA };
    }
    case 'font-set': {
      return { ...difference, added: difference.removed, removed: difference.added };
    }
    default: {
      return { ...difference, document: difference.document === 'a' ? 'b' : 'a' };
    }
  }
};

const sortedByText = (differences: ReadonlyArray<PdfDifference>): Array<PdfDifference> =>
  differences.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

describe('properties', () => {
  it('finds no difference between a document and its full and incremental saves', () => {
    fc.assert(
      fc.property(documentSpec, spec => {
        const document = loadDocument(writeSpec(spec));
        const saves = (['full', 'incremental'] as const).map(mode => compareDocuments(document, loadDocument(document.save({ mode }).chunks)));
        expect(saves).toStrictEqual([
          { equal: true, differences: [] },
          { equal: true, differences: [] },
        ]);
      }),
    );
  });

  it('finds no difference between documents that number the same objects differently', () => {
    const renumbered = documentSpec.chain(spec => {
      const numbers = objectNumbers(spec);
      return fc.record({ spec: fc.constant(spec), order: fc.shuffledSubarray(numbers, { minLength: numbers.length, maxLength: numbers.length }) });
    });
    fc.assert(
      fc.property(renumbered, ({ spec, order }) => {
        const numbers = objectNumbers(spec);
        const mapping = new Map(numbers.map((logical, index) => [logical, order[index] ?? logical]));
        const comparison = compareDocuments(loadDocument(writeSpec(spec)), loadDocument(writeSpec(spec, logical => mapping.get(logical) ?? logical)));
        expect(comparison).toStrictEqual({ equal: true, differences: [] });
      }),
    );
  });

  it('reports the same differences with the sides swapped when the documents are swapped', () => {
    fc.assert(
      fc.property(documentSpec, documentSpec, (specA, specB) => {
        const [a, b] = [loadDocument(writeSpec(specA)), loadDocument(writeSpec(specB))];
        const forward = compareDocuments(a, b);
        const backward = compareDocuments(b, a);
        expect([backward.equal, sortedByText(backward.differences)]).toStrictEqual([
          forward.equal,
          sortedByText(forward.differences.map(difference => swapped(difference))),
        ]);
      }),
    );
  });
});

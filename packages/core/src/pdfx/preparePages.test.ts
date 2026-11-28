import type { LoadedDocument, LoadOptions } from '../document/loadDocument.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';
import { pdfName } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { checkPdfX4 } from './checkPdfX4.ts';
import { preparePdfX4Pages } from './preparePages.ts';
import { pageDictionary } from './testing/pdfxDocument.ts';

const source = () =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>/Contents 5 0 R>>' },
        {
          number: 4,
          body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</ExtGState<</GS1 7 0 R>>>>/Contents 6 0 R>>',
        },
        { number: 5, body: streamBody('', '0 0 0 1 k') },
        { number: 6, body: streamBody('', '/GS1 gs 0 0 10 10 re f') },
        { number: 7, body: '<</Type/ExtGState/ca 0.5>>' },
      ],
      trailer: '/Root 1 0 R',
    },
  ]);

const boxed = (...pages: ReadonlyArray<string>) =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: `<</Type/Pages/Kids[${pages.map((_, index) => `${String(index + 3)} 0 R`).join(' ')}]/Count ${String(pages.length)}>>` },
          ...pages.map((boxes, index) => ({ number: index + 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]${boxes}/Resources<<>>>>` })),
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

/** One page with an explicit TrimBox, the given resources and content stream 4, and further objects numbered from 5. */
const single = (resources: string, content: string, extra: ReadonlyArray<TestObject> = [], page = '', options: LoadOptions = {}) =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/TrimBox[0 0 100 100]/Resources${resources}/Contents 4 0 R${page}>>` },
          { number: 4, body: content },
          ...extra,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
    options,
  );

const boxFinding = (document: LoadedDocument) => checkPdfX4(document).findings.find(finding => finding.rule === 'X4-BOXES')?.status;
const reloaded = (document: LoadedDocument) => loadDocument(document.save().toBytes());

const entriesObject = (entries: PdfDictionaryEntries) =>
  Object.fromEntries([...entries.entries()].map(([key, value]) => [new TextDecoder('latin1').decode(key), value]));

const pageGroup = (document: LoadedDocument, index: number) => {
  const group = pageDictionary(document, index).get(pdfName('Group').bytes);
  if (group?.kind !== 'dictionary') {
    throw new Error('group is not a dictionary');
  }
  return entriesObject(group.entries);
};

const hasGroup = (document: LoadedDocument, index: number): boolean => pageDictionary(document, index).has(pdfName('Group').bytes);

const addedGroups = (document: LoadedDocument) => preparePdfX4Pages(document).addedPageGroups;

/** A Type 3 font whose glyph a, object 6, names GS for the given graphics state. */
const type3 = (state: string) =>
  `<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 6 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]/Resources<</ExtGState<</GS ${state}>>>>>>`;

/** A Type 3 font without Resources whose CharProcs entry is the given value. */
const shownType3 = (procedures: string) =>
  `<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs ${procedures}/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]>>`;

type Nesting = 'form' | 'pattern' | 'Type 3 font';

/** A page whose content reaches the given number of nested forms, tiling patterns or Type 3 glyph procedures, numbered from 10, the deepest of which applies the transparent state in object 5. */
const nested = (kind: Nesting, levels: number) => {
  const objects: Array<TestObject> = [{ number: 5, body: '<</ca 0.5>>' }];
  const pattern = '/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1';
  const font = '/Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]';
  const select = {
    form: { category: 'XObject', operators: (name: string) => `/${name} Do` },
    pattern: { category: 'Pattern', operators: (name: string) => `/Pattern cs /${name} scn 0 0 1 1 re f` },
    'Type 3 font': { category: 'Font', operators: (name: string) => `BT /${name} 12 Tf (a) Tj ET` },
  } as const;
  const uses = (level: number) => {
    const name = `N${String(level)}`;
    const { category, operators } = select[kind];
    return { resources: `/${category}<</${name} ${String(10 + 2 * (level - 1))} 0 R>>`, operators: operators(name) };
  };
  for (let level = 1; level <= levels; level++) {
    const number = 10 + 2 * (level - 1);
    const deepest = level === levels;
    const next = uses(level + 1);
    const resources = deepest ? '/ExtGState<</GS 5 0 R>>' : next.resources;
    const operators = deepest ? '/GS gs 0 0 1 1 re f' : next.operators;
    if (kind === 'form') {
      objects.push({ number, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources<<${resources}>>`, operators) });
    } else if (kind === 'pattern') {
      objects.push({ number, body: streamBody(`${pattern}/Resources<<${resources}>>`, operators) });
    } else {
      objects.push(
        { number, body: `<<${font}/CharProcs<</a ${String(number + 1)} 0 R>>/Resources<<${resources}>>>>` },
        { number: number + 1, body: streamBody('', `0 0 d0 ${operators}`) },
      );
    }
  }
  const page = uses(1);
  return single(`<<${page.resources}>>`, streamBody('', page.operators), objects);
};

/** A page with an annotation whose N appearance leads through the given number of indirect subdictionaries, numbered from 10, to a transparency group form. */
const chained = (levels: number) =>
  single(
    '<<>>',
    streamBody('', ''),
    [
      ...Array.from({ length: levels }, (_, index) => ({ number: 10 + index, body: `<</On ${String(11 + index)} 0 R>>` })),
      { number: 10 + levels, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Group<</S/Transparency>>', '') },
    ],
    '/Annots[<</Type/Annot/Subtype/Stamp/Rect[0 0 1 1]/AP<</N 10 0 R>>>>]',
  );

const grow = ([left, bottom, right, top]: readonly [number, number, number, number], [dl, db, dr, dt]: readonly [number, number, number, number]) =>
  [left - dl, bottom - db, right + dr, top + dt] as const;

describe('pdfx page preparation', () => {
  it('adds MediaBox-sized TrimBoxes and an isolated CMYK group only to the transparent page', () => {
    const document = loadDocument(source().bytes);
    const result = preparePdfX4Pages(document);
    expect(result.addedTrimBoxes).toStrictEqual([0, 1]);
    expect(result.addedPageGroups).toStrictEqual([1]);
    expect(document.page(0).boxes().TrimBox.rect).toStrictEqual([0, 0, 100, 100]);
    expect(document.page(1).boxes().TrimBox.rect).toStrictEqual([0, 0, 200, 100]);
    expect([document.page(0).boxes().TrimBox.explicit]).toStrictEqual([true]);
  });

  it('writes the group dictionary and leaves a second preparation unchanged', () => {
    // ISO 32000-1:2008, 11.6.6, Table 147: a transparency group has S /Transparency, and CS and I set its blending space and isolation.
    const document = loadDocument(source().bytes);
    preparePdfX4Pages(document);
    expect([hasGroup(document, 0)]).toStrictEqual([false]);
    expect(pageGroup(document, 1)).toStrictEqual({ S: pdfName('Transparency'), CS: pdfName('DeviceCMYK'), I: { kind: 'boolean', value: true } });
    expect(preparePdfX4Pages(document)).toStrictEqual({ addedTrimBoxes: [], addedPageGroups: [] });
  });

  it.each<[string, string, 'incremental' | 'full']>([
    ['nothing to add', '<</ca 1>>', 'incremental'],
    ['a page group to add', '<</ca 0.5>>', 'full'],
  ])('saves a document with %s as %s', (_, state, mode) => {
    const document = single('<</ExtGState<</GS1 5 0 R>>>>', streamBody('', '/GS1 gs'), [{ number: 5, body: state }]);
    preparePdfX4Pages(document);
    expect(document.save().mode).toBe(mode);
  });

  it('defaults the TrimBox to the CropBox, reduced to the MediaBox and to an explicit BleedBox', () => {
    const document = boxed('/CropBox[10 10 90 90]', '/BleedBox[5 5 95 95]', '/CropBox[10 10 90 90]/BleedBox[20 0 100 80]', '/CropBox[-10 20 110 120]');
    expect(preparePdfX4Pages(document).addedTrimBoxes).toStrictEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map(index => document.page(index).boxes().TrimBox.rect)).toStrictEqual([
      [10, 10, 90, 90],
      [5, 5, 95, 95],
      [20, 10, 90, 80],
      [0, 20, 100, 100],
    ]);
    expect(boxFinding(document)).toBe('passed');
    expect(boxFinding(reloaded(document))).toBe('passed');
  });

  it('rounds a derived TrimBox inward so that it stays inside a CropBox written with more digits', () => {
    const document = boxed('/CropBox[8.503932 8.503938 91.574803 91.574807]');
    preparePdfX4Pages(document);
    expect(document.page(0).boxes().TrimBox.rect).toStrictEqual([8.50394, 8.50394, 91.5748, 91.5748]);
    expect(boxFinding(document)).toBe('passed');
    expect(boxFinding(reloaded(document))).toBe('passed');
  });

  it('derives a TrimBox from boxes that overlap by one unit of the last written digit', () => {
    const document = boxed('/CropBox[0 0 50.00001 50]/BleedBox[50 0 100 100]');
    preparePdfX4Pages(document);
    expect(document.page(0).boxes().TrimBox.rect).toStrictEqual([50, 0, 50.00001, 50]);
  });

  it.each<[string, string]>([
    ['do not overlap', '/CropBox[0 0 40 40]/BleedBox[50 50 100 100]'],
    ['share only an edge', '/CropBox[0 0 50 50]/BleedBox[50 0 100 100]'],
  ])('refuses a page whose CropBox and BleedBox %s before changing any page', (_, boxes) => {
    const document = boxed('', boxes);
    expect(() => preparePdfX4Pages(document)).toThrow(ValidationError);
    expect([document.page(0).boxes().TrimBox.explicit, document.page(1).boxes().TrimBox.explicit]).toStrictEqual([false, false]);
  });

  it('offers a refusal policy for pages without either print-area box', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/TrimBox[0 0 100 100]/Resources<</ExtGState<</GS1 6 0 R>>>>/Contents 5 0 R>>' },
            { number: 4, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
            { number: 5, body: streamBody('', '/GS1 gs') },
            { number: 6, body: '<</ca 0.5>>' },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect(() => preparePdfX4Pages(document, { pageBoxes: 'refuse' })).toThrow(ValidationError);
    expect([hasGroup(document, 0), document.page(1).boxes().TrimBox.explicit]).toStrictEqual([false, false]);
  });

  it('preserves an ArtBox without adding a competing TrimBox', () => {
    const document = loadDocument(source().bytes);
    document.page(0).setBox('ArtBox', [pt(0), pt(0), pt(90), pt(90)]);
    expect(preparePdfX4Pages(document).addedTrimBoxes).toStrictEqual([1]);
    expect([document.page(0).boxes().TrimBox.explicit]).toStrictEqual([false]);
  });

  it.each<[string, Array<number>]>([
    ['/ca 1', []],
    ['/CA 1', []],
    ['/BM/Normal', []],
    ['/BM/Compatible', []],
    ['/BM[/Normal]', []],
    ['/SMask/None', []],
    ['/ca 0.99999', [0]],
    ['/CA 0.5', [0]],
    ['/BM/Multiply', [0]],
    ['/BM[/Multiply/Normal]', [0]],
    ['/SMask<</S/Luminosity/G 6 0 R>>', [0]],
  ])('reads an ExtGState with %s as transparent only when it is', (state, groups) => {
    // ISO 32000-1:2008, 11.6.4 and Table 58: constant alpha below 1, a blend mode other than Normal or Compatible, or a soft mask other than None makes content transparent.
    const document = single('<</ExtGState<</GS1 5 0 R>>>>', streamBody('', '/GS1 gs 0 0 10 10 re f'), [
      { number: 5, body: `<<${state}>>` },
      { number: 6, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Group<</S/Transparency/CS/DeviceGray>>', '') },
    ]);
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  it.each<[string, string, Array<number>]>([
    ['a plain image', '', []],
    ['an image with SMask', '/SMask 6 0 R', [0]],
    ['an image with Mask', '/Mask[0 0]', [0]],
  ])('reads %s', (_, mask, groups) => {
    // ISO 32000-1:2008, 11.6.5.3: an SMask entry gives an image a soft mask; preparePdfX4Pages also counts a Mask entry (8.9.6) as needing a page group.
    const document = single('<</XObject<</Im1 5 0 R>>>>', streamBody('', '/Im1 Do'), [
      { number: 5, body: streamBody(`/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8${mask}`, 'x') },
      { number: 6, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8', 'x') },
    ]);
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  it.each<[string, string, string, Array<number>]>([
    ['an opaque form', '', '0 0 1 1 re f', []],
    ['a form with a non-transparency group', '/Group<</S/Other>>', '0 0 1 1 re f', []],
    ['a form with a transparency group', '/Group<</S/Transparency>>', '0 0 1 1 re f', [0]],
    ['a form whose own resources set ca 0.5', '/Resources<</ExtGState<</GS2 7 0 R>>>>', '/GS2 gs', [0]],
    ['a form without resources that uses the page ExtGState', '', '/GS1 gs', [0]],
  ])('reads %s drawn by the page', (_, dictionary, content, groups) => {
    // ISO 32000-1:2008, 7.8.3: a form without Resources uses the resources of the content stream that draws it.
    const document = single('<</XObject<</X1 5 0 R>>/ExtGState<</GS1 6 0 R>>>>', streamBody('', '/X1 Do'), [
      { number: 5, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 1 1]${dictionary}`, content) },
      { number: 6, body: '<</ca 0.5>>' },
      { number: 7, body: '<</ca 0.5>>' },
    ]);
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  it('stops at a form that draws itself', () => {
    const document = single('<</XObject<</X1 5 0 R>>>>', streamBody('', '/X1 Do'), [
      { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources<</XObject<</X1 5 0 R>>>>', '/X1 Do') },
    ]);
    expect(addedGroups(document)).toStrictEqual([]);
  });

  it.each<Nesting>(['form', 'pattern', 'Type 3 font'])('reads content nested through %s streams as deep as maxNesting and refuses one more', kind => {
    expect(addedGroups(nested(kind, 256))).toStrictEqual([0]);
    const prepare = () => preparePdfX4Pages(nested(kind, 257));
    expect(prepare).toThrow(ResourceLimitError);
    expect(prepare).toThrow(/maxNesting \(256\)/u);
  });

  it('leaves a page that already has a Group as it is', () => {
    const document = single(
      '<</ExtGState<</GS1 5 0 R>>>>',
      streamBody('', '/GS1 gs'),
      [{ number: 5, body: '<</ca 0.5>>' }],
      '/Group<</S/Transparency/CS/DeviceRGB>>',
    );
    expect(addedGroups(document)).toStrictEqual([]);
    expect(pageGroup(document, 0)).toStrictEqual({ S: pdfName('Transparency'), CS: pdfName('DeviceRGB') });
  });

  it.each<[string, string, ReadonlyArray<TestObject>]>([
    ['page content', streamBody('/Filter/FlateDecode', 'garbage'), []],
    ['a form XObject', streamBody('', '/X1 Do'), [{ number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Filter/FlateDecode', 'garbage') }]],
  ])('refuses %s that does not decode', (_, content, extra) => {
    const document = single('<</XObject<</X1 5 0 R>>>>', content, extra);
    expect(() => preparePdfX4Pages(document)).toThrow(ValidationError);
    expect(() => preparePdfX4Pages(document)).toThrow(expect.objectContaining({ reason: 'unreadable-resource' }));
  });

  it('adds a page group for transparency inside a selected tiling pattern', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</Pattern<</P 5 0 R>>>>/Contents 4 0 R>>' },
            { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 10 10 re f') },
            {
              number: 5,
              body: streamBody(
                '/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<</ExtGState<</GS 6 0 R>>>>',
                '/GS gs 0 0 10 10 re f',
              ),
            },
            { number: 6, body: '<</Type/ExtGState/ca 0.5>>' },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect(preparePdfX4Pages(document).addedPageGroups).toStrictEqual([0]);
  });

  it('adds a page group for a shading pattern ExtGState', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</Pattern<</P 5 0 R>>>>/Contents 4 0 R>>' },
            { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 10 10 re f') },
            { number: 5, body: '<</Type/Pattern/PatternType 2/Shading 7 0 R/ExtGState 6 0 R>>' },
            { number: 6, body: '<</Type/ExtGState/ca 0.5>>' },
            {
              number: 7,
              body: '<</ShadingType 2/ColorSpace/DeviceCMYK/Coords[0 0 10 10]/Function<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[1 1 1 1]/N 1>>>>',
            },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect(preparePdfX4Pages(document).addedPageGroups).toStrictEqual([0]);
  });

  it('reads annotation appearance subdictionaries as deep as maxNesting and refuses one more', () => {
    expect(addedGroups(chained(256))).toStrictEqual([0]);
    const prepare = () => preparePdfX4Pages(chained(257));
    expect(prepare).toThrow(ResourceLimitError);
    expect(prepare).toThrow(/maxNesting \(256\)/u);
  });

  it('adds a page group for transparency in an annotation appearance', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>/Annots[5 0 R]>>' },
            { number: 5, body: '<</Type/Annot/Subtype/Stamp/Rect[0 0 10 10]/AP<</N 6 0 R>>>>' },
            { number: 6, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</ExtGState<</GS 7 0 R>>>>', '/GS gs 0 0 10 10 re f') },
            { number: 7, body: '<</Type/ExtGState/ca 0.5>>' },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect(preparePdfX4Pages(document).addedPageGroups).toStrictEqual([0]);
  });

  it.each<[string, string, string, string, Array<number>]>([
    ['a glyph that sets a transparent ExtGState', '<</Font<</T3 5 0 R>>>>', 'BT /T3 12 Tf (a) Tj ET', '/GS gs 0 0 1 1 re f', [0]],
    ['an opaque glyph', '<</Font<</T3 5 0 R>>>>', 'BT /T3 12 Tf (a) Tj ET', '0 0 1 1 re f', []],
    ['a transparent glyph of a font that no Tf selects', '<</Font<</T3 5 0 R>>>>', 'BT ET', '/GS gs 0 0 1 1 re f', []],
  ])('reads Type 3 glyph procedures for %s', (_, resources, content, glyph, groups) => {
    // ISO 32000-1:2008, 9.6.5: the glyph procedures in CharProcs are content streams, run with the font's Resources.
    const document = single(resources, streamBody('', content), [
      {
        number: 5,
        body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 6 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]/Resources<</ExtGState<</GS 7 0 R>>>>>>',
      },
      { number: 6, body: streamBody('', `0 0 d0 ${glyph}`) },
      { number: 7, body: '<</ca 0.5>>' },
    ]);
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  it.each<[string, string, string, Array<number>]>([
    ['a Type 3 font with a transparent glyph', '/Subtype/Type3', '/F gs BT (a) Tj ET', [0]],
    ['a Type 1 font', '/Subtype/Type1/BaseFont/Helvetica', '/F gs BT (a) Tj ET', []],
    ['a Type 3 font with a transparent glyph, in a state that no gs applies', '/Subtype/Type3', 'BT (a) Tj ET', []],
  ])('reads the font that a graphics state Font entry selects, for %s', (_, subtype, content, groups) => {
    // ISO 32000-1:2008, 8.4.5, Table 58: Font in a graphics state parameter dictionary is an array of a font and a size, which gs selects as Tf does.
    const document = single('<</ExtGState<</F 8 0 R>>>>', streamBody('', content), [
      {
        number: 5,
        body: `<</Type/Font${subtype}/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 6 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]/Resources<</ExtGState<</GS 7 0 R>>>>>>`,
      },
      { number: 6, body: streamBody('', '0 0 d0 /GS gs 0 0 1 1 re f') },
      { number: 7, body: '<</ca 0.5>>' },
      { number: 8, body: '<</Font[5 0 R 12]>>' },
    ]);
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  it.each<[string, string, Array<number>]>([
    ['the second names a transparent state', '7 0 R', [0]],
    ['both name an opaque state', '9 0 R', []],
  ])('reads a glyph procedure that two Type 3 fonts share with the Resources of each, where %s', (_, second, groups) => {
    // ISO 32000-1:2008, 9.6.5 and Table 112: a glyph procedure runs with the Resources of the font that shows it.
    const document = single('<</Font<</T1 5 0 R/T2 8 0 R>>>>', streamBody('', 'BT /T1 12 Tf (a) Tj /T2 12 Tf (a) Tj ET'), [
      { number: 5, body: type3('9 0 R') },
      { number: 6, body: streamBody('', '0 0 d0 /GS gs 0 0 1 1 re f') },
      { number: 7, body: '<</ca 0.5>>' },
      { number: 8, body: type3(second) },
      { number: 9, body: '<</ca 1>>' },
    ]);
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  it.each<[string, string, ReadonlyArray<TestObject>, LoadOptions]>([
    ['an indirect font', '<</Font<</T3 5 0 R>>>>', [{ number: 5, body: '<<FONT>>' }], {}],
    ['a direct font', '<</Font<</T3 <<FONT>>>>>>', [], {}],
    // Each glyph procedure reads the Font dictionary again, and with no room in the object cache that gives a new font dictionary every time.
    [
      'a direct font in an indirect Font dictionary that the object cache drops',
      '<</Font 8 0 R>>',
      [{ number: 8, body: '<</T3 <<FONT>>>>' }],
      { parsedObjectCacheBytes: 1 },
    ],
  ])('ends the scan of a glyph that selects its own font, %s', (_, resources, extra, options) => {
    const font =
      '/Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 6 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]';
    const document = single(
      resources.replace('FONT', font),
      streamBody('', 'BT /T3 12 Tf (a) Tj ET'),
      [
        ...extra.map(object => ({ ...object, body: object.body.replace('FONT', font) })),
        { number: 6, body: streamBody('', '0 0 d0 BT /T3 12 Tf (a) Tj ET 0 0 1 1 re f') },
      ],
      '',
      options,
    );
    expect(addedGroups(document)).toStrictEqual([]);
  });

  it.each<[string, string, Array<number>]>([
    ['the same font each time', '', []],
    ['another direct font after it whose glyph is transparent', '/B 12 Tf (a) Tj', [0]],
  ])('reads a direct Type 3 font once however often Tf selects it, then %s', (_, last, groups) => {
    const document = single(
      `<</Font<</A ${shownType3('7 0 R')}/B ${shownType3('<</a 8 0 R>>')}>>/ExtGState<</GS 9 0 R>>>>`,
      streamBody('', `BT /A 12 Tf (a) Tj /A 12 Tf (a) Tj /A 12 Tf (a) Tj ${last} ET`),
      [
        { number: 6, body: streamBody('', '0 0 d0 0 0 1 1 re f') },
        { number: 7, body: '<</a 6 0 R>>' },
        { number: 8, body: streamBody('', '0 0 d0 /GS gs 0 0 1 1 re f') },
        { number: 9, body: '<</ca 0.5>>' },
      ],
    );
    const parts = internalsOf(document);
    if (parts === undefined) {
      throw new Error('document internals are unavailable');
    }
    const resolve = vi.spyOn(parts.objects, 'resolve');
    expect(addedGroups(document)).toStrictEqual(groups);
    expect(resolve.mock.calls.filter(([objectNumber]) => objectNumber === 7)).toHaveLength(1);
  });

  it('refuses a selected Type 3 font whose glyph procedure cannot be decoded', () => {
    const document = single('<</Font<</T3 5 0 R>>>>', streamBody('', 'BT /T3 12 Tf (a) Tj ET'), [
      {
        number: 5,
        body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 6 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]>>',
      },
      { number: 6, body: streamBody('/Filter/FlateDecode', 'garbage') },
    ]);
    const prepare = () => preparePdfX4Pages(document);
    expect(prepare).toThrow(ValidationError);
    expect(prepare).toThrow(expect.objectContaining({ reason: 'unreadable-resource' }));
  });

  it.each<[string, string, string, ReadonlyArray<TestObject>, Array<number>]>([
    ['shown in the page content', '<</Font<</T3 5 0 R>>/ExtGState<</GS 7 0 R>>>>', 'BT /T3 12 Tf (a) Tj ET', [], [0]],
    [
      'shown in a form whose resources name GS for a transparent state, on a page whose GS is opaque',
      '<</XObject<</F 8 0 R>>/ExtGState<</GS 9 0 R>>>>',
      '/F Do',
      [
        {
          number: 8,
          body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</Font<</T3 5 0 R>>/ExtGState<</GS 7 0 R>>>>', 'BT /T3 12 Tf (a) Tj ET'),
        },
        { number: 9, body: '<</ca 1>>' },
      ],
      [],
    ],
  ])('looks up the names of a Type 3 glyph without font Resources in the page resources, %s', (_, resources, content, extra, groups) => {
    // ISO 32000-1:2008, Table 112, Resources: "If any glyph descriptions refer to named resources but this dictionary is absent, the names shall be looked up in the resource dictionary of the page on which the font is used."
    const document = single(resources, streamBody('', content), [
      {
        number: 5,
        body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 6 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]>>',
      },
      { number: 6, body: streamBody('', '0 0 d0 /GS gs 0 0 1 1 re f') },
      { number: 7, body: '<</ca 0.5>>' },
      ...extra,
    ]);
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  it.each<[string, string, Array<number>]>([
    ['a normal appearance state', '/AS/On/AP<</N<</On 6 0 R/Off 7 0 R>>>>', [0]],
    ['only the rollover appearance', '/AP<</N 7 0 R/R 6 0 R>>', []],
    ['only the down appearance', '/AP<</N 7 0 R/D 6 0 R>>', []],
  ])('reads transparency in %s of an annotation', (_, appearance, groups) => {
    // ISO 32000-1:2008, 12.5.5, Table 168: printing uses the normal appearance; R and D apply only to interactive use.
    const document = single(
      '<<>>',
      streamBody('', ''),
      [
        { number: 5, body: `<</Type/Annot/Subtype/Widget/Rect[0 0 10 10]${appearance}>>` },
        { number: 6, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</ExtGState<</GS 8 0 R>>>>', '/GS gs 0 0 10 10 re f') },
        { number: 7, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '0 0 10 10 re f') },
        { number: 8, body: '<</ca 0.5>>' },
      ],
      '/Annots[5 0 R]',
    );
    expect(addedGroups(document)).toStrictEqual(groups);
  });

  describe('properties', () => {
    // Coordinates are integers in units of 1e-8 pt, so the exact intersection and its inward rounding to 5 decimals can be computed without floating point.
    const UNIT = 100_000_000;
    const decimal = (value: number): string => `${String(Math.trunc(value / UNIT))}.${String(value % UNIT).padStart(8, '0')}`;
    const rectangle = (box: readonly [number, number, number, number]) => `[${box.map(decimal).join(' ')}]`;
    const outset = fc.tuple(fc.nat(2 * UNIT), fc.nat(2 * UNIT), fc.nat(2 * UNIT), fc.nat(2 * UNIT));
    const boxes = fc.record({
      core: fc.tuple(
        fc.integer({ min: 5 * UNIT, max: 50 * UNIT }),
        fc.integer({ min: 5 * UNIT, max: 50 * UNIT }),
        fc.integer({ min: UNIT / 1000, max: 40 * UNIT }),
        fc.integer({ min: UNIT / 1000, max: 40 * UNIT }),
      ),
      media: outset,
      crop: fc.option(outset, { nil: undefined }),
      bleed: fc.option(outset, { nil: undefined }),
    });

    it('derives the inward-rounded intersection of the media, crop and bleed boxes, which the checker passes before and after a reload', () => {
      fc.assert(
        fc.property(boxes, ({ core: [x, y, width, height], media, crop, bleed }) => {
          const shared = [x, y, x + width, y + height] as const;
          const limits = [grow(shared, media), ...(crop === undefined ? [] : [grow(shared, crop)]), ...(bleed === undefined ? [] : [grow(shared, bleed)])];
          const mediaBox = grow(shared, media);
          const written = `/MediaBox${rectangle(mediaBox)}${crop === undefined ? '' : `/CropBox${rectangle(grow(shared, crop))}`}${bleed === undefined ? '' : `/BleedBox${rectangle(grow(shared, bleed))}`}`;
          const document = loadDocument(
            buildPdf([
              {
                xref: 'classic',
                objects: [
                  { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
                  { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
                  { number: 3, body: `<</Type/Page/Parent 2 0 R${written}/Resources<<>>>>` },
                ],
                trailer: '/Root 1 0 R',
              },
            ]).bytes,
          );
          const step = UNIT / 100_000;
          const expected = [
            Math.ceil(Math.max(...limits.map(box => box[0])) / step) / 100_000,
            Math.ceil(Math.max(...limits.map(box => box[1])) / step) / 100_000,
            Math.floor(Math.min(...limits.map(box => box[2])) / step) / 100_000,
            Math.floor(Math.min(...limits.map(box => box[3])) / step) / 100_000,
          ];
          expect(preparePdfX4Pages(document)).toStrictEqual({ addedTrimBoxes: [0], addedPageGroups: [] });
          expect(document.page(0).boxes().TrimBox.rect).toStrictEqual(expected);
          expect([boxFinding(document), boxFinding(reloaded(document))]).toStrictEqual(['passed', 'passed']);
          expect(preparePdfX4Pages(document)).toStrictEqual({ addedTrimBoxes: [], addedPageGroups: [] });
        }),
      );
    });
  });
});

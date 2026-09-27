import type { CMapProvider } from '../../font/cmap/cmapProvider.ts';
import type { PdfReference } from '../../object/pdfObject.ts';
import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { TestPage } from '../../testing/textPdf.ts';
import type { FontEntry, FontInventory, ListFontsOptions } from './listFonts.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { pdfReference } from '../../object/pdfObject.ts';
import { latin1Bytes, latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { listFonts } from './listFonts.ts';

const inventory = (pages: readonly TestPage[], objects: readonly TestObject[] = [], options: ListFontsOptions = {}): FontInventory =>
  listFonts(loadDocument(textPdfBytes({ pages, objects })), options);

const only = (result: FontInventory): FontEntry => {
  const [font, ...rest] = result.fonts;
  if (font === undefined || rest.length > 0) throw new Error(`expected one font, found ${String(result.fonts.length)}`);
  return font;
};

const onPage = (resources: string, objects: readonly TestObject[] = []): FontEntry => only(inventory([{ resources }], objects));

const program = (name: string): string =>
  latin1Text(syntheticTrueType({ name, glyphs: [{ advance: 500 }, { advance: 600, box: [0, 0, 500, 700] }], characters: [[0x41, 1]] }));

const embedded = (number: number, key: string, [data, dictionary = '']: readonly [string, string?]): readonly TestObject[] => [
  {
    number,
    body: `<</Type/FontDescriptor/FontName/X/Flags 32/FontBBox[0 0 1 1]/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80/${key} ${String(number + 1)} 0 R>>`,
  },
  { number: number + 1, body: streamBody(dictionary, data) },
];

const text = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : latin1Text(bytes));

const reference = (objectNumber: number): PdfReference => pdfReference(objectNumber, 0);

const TYPE3 =
  '/Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 111 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]';

const type0With = (cid: string): readonly TestObject[] => [
  { number: 100, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[102 0 R]>>' },
  { number: 102, body: `<</Type/Font/Subtype/${cid}/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor 103 0 R>>` },
  ...embedded(103, 'FontFile3', ['data', '/Subtype/CIDFontType0C']),
];

const taggedTrueType = (number: number, descriptor: number): TestObject => ({
  number,
  body: `<</Type/Font/Subtype/TrueType/BaseFont/AAAAAA+Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor ${String(descriptor)} 0 R>>`,
});

const helvetica = (number: number): TestObject => ({ number, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' });

const codes = (entry: FontEntry): string[] => entry.problems.map(problem => problem.code);

describe('font inventory', () => {
  it('reports a standard 14 font without a descriptor or Widths as not embedded and without problems', () => {
    const font = onPage('/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>');
    expect([font.key, font.subtype, text(font.name), font.embedding, font.subset, font.encoding, font.toUnicode, font.problems]).toStrictEqual([
      'direct:3.0:4631',
      'Type1',
      'Helvetica',
      { state: 'not-embedded', standard14: true },
      { state: 'not-subset' },
      { kind: 'font-program' },
      'absent',
      [],
    ]);
  });

  it('reports an embedded TrueType subset with its tag and encoding', () => {
    const font = onPage('/Font<</F1 100 0 R>>', [
      {
        number: 100,
        body: '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+Test/FirstChar 65/LastChar 65/Widths[600]/Encoding/WinAnsiEncoding/FontDescriptor 101 0 R>>',
      },
      ...embedded(101, 'FontFile2', [program('Test')]),
    ]);
    expect([font.key, font.reference, font.descriptor, font.embedding, font.subset, font.encoding, font.problems]).toStrictEqual([
      '100.0',
      reference(100),
      reference(101),
      { state: 'embedded', file: 'FontFile2', fileSubtype: undefined, matchesFontType: true },
      { state: 'subset', tag: 'ABCDEF' },
      { kind: 'named', name: 'WinAnsiEncoding', bytes: latin1Bytes('WinAnsiEncoding') },
      [],
    ]);
  });

  it('reports a Type 0 font with its descendant, collection, CMap and ToUnicode', () => {
    const font = onPage('/Font<</F1 100 0 R>>', [
      { number: 100, body: '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Test/Encoding/Identity-H/DescendantFonts[102 0 R]/ToUnicode 105 0 R>>' },
      {
        number: 102,
        body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor 103 0 R/CIDToGIDMap/Identity>>',
      },
      ...embedded(103, 'FontFile2', [program('Test')]),
      { number: 105, body: streamBody('', 'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0001> <0041> endbfchar endcmap') },
    ]);
    expect([font.descendant, font.descriptor, font.embedding, font.encoding, font.toUnicode]).toStrictEqual([
      { subtype: 'CIDFontType2', reference: reference(102), registry: latin1Bytes('Adobe'), ordering: latin1Bytes('Identity'), supplement: 0 },
      reference(103),
      { state: 'embedded', file: 'FontFile2', fileSubtype: undefined, matchesFontType: true },
      { kind: 'cmap', name: latin1Bytes('Identity-H'), predefined: true, embedded: false, writingMode: 0, available: true },
      'present',
    ]);
  });

  it('says whether the provider supplied a predefined CMap other than Identity', () => {
    const objects: readonly TestObject[] = [
      {
        number: 100,
        body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/90ms-RKSJ-V/DescendantFonts[<</Type/Font/Subtype/CIDFontType0/BaseFont/Test>>]>>',
      },
    ];
    const cmap = latin1Bytes('/WMode 1 def begincmap 1 begincodespacerange <00> <FF> endcodespacerange endcmap');
    const provider: CMapProvider = { cmap: name => new Map([['90ms-RKSJ-V', cmap]]).get(name) };
    const without = only(inventory([{ resources: '/Font<</F1 100 0 R>>' }], objects)).encoding;
    const supplied = only(inventory([{ resources: '/Font<</F1 100 0 R>>' }], objects, { cmapProvider: provider })).encoding;
    expect([without, supplied]).toStrictEqual([
      { kind: 'cmap', name: latin1Bytes('90ms-RKSJ-V'), predefined: true, embedded: false, writingMode: 1, available: false },
      { kind: 'cmap', name: latin1Bytes('90ms-RKSJ-V'), predefined: true, embedded: false, writingMode: 1, available: true },
    ]);
  });

  it('flags a program the font type cannot use', () => {
    const font = onPage('/Font<</F1 100 0 R>>', [
      { number: 100, body: '<</Type/Font/Subtype/Type1/BaseFont/Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>' },
      ...embedded(101, 'FontFile2', [program('Test')]),
    ]);
    expect([font.embedding, codes(font)]).toStrictEqual([
      { state: 'embedded', file: 'FontFile2', fileSubtype: undefined, matchesFontType: false },
      ['embedding-type-mismatch'],
    ]);
  });

  it('accepts FontFile3 programs by their Subtype as Table 126 lists them', () => {
    const cases = [
      ['Type1', 'Type1C', true],
      ['Type1', 'OpenType', true],
      ['MMType1', 'OpenType', false],
      ['TrueType', 'OpenType', true],
      ['TrueType', 'Type1C', false],
    ] as const;
    const results = cases.map(
      ([subtype, fileSubtype]) =>
        onPage('/Font<</F1 100 0 R>>', [
          { number: 100, body: `<</Type/Font/Subtype/${subtype}/BaseFont/Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>` },
          ...embedded(101, 'FontFile3', ['data', `/Subtype/${fileSubtype}`]),
        ]).embedding,
    );
    expect(results).toStrictEqual(
      cases.map(([, fileSubtype, matches]) => ({ state: 'embedded', file: 'FontFile3', fileSubtype: latin1Bytes(fileSubtype), matchesFontType: matches })),
    );
  });

  it('reads the embedded program of a Type 0 font from its descendant, accepting CIDFontType0C only for CIDFontType0', () => {
    const results = ['CIDFontType0', 'CIDFontType2'].map(cid => onPage('/Font<</F1 100 0 R>>', type0With(cid)).embedding);
    expect(results).toStrictEqual([
      { state: 'embedded', file: 'FontFile3', fileSubtype: latin1Bytes('CIDFontType0C'), matchesFontType: true },
      { state: 'embedded', file: 'FontFile3', fileSubtype: latin1Bytes('CIDFontType0C'), matchesFontType: false },
    ]);
  });

  it('reports a subset tag that is not six uppercase letters as malformed', () => {
    const font = onPage('/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/AbCDEF+Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>>>', [
      { number: 101, body: '<</Type/FontDescriptor/FontName/AbCDEF+Test/Flags 32>>' },
    ]);
    expect([font.subset, codes(font)]).toStrictEqual([{ state: 'not-subset' }, ['subset-tag-malformed']]);
  });

  it('reports one subset tag on fonts with different programs as reused, and not when they share a program', () => {
    const different = inventory(
      [{ resources: '/Font<</F1 100 0 R/F2 110 0 R>>' }],
      [taggedTrueType(100, 101), ...embedded(101, 'FontFile2', [program('One')]), taggedTrueType(110, 111), ...embedded(111, 'FontFile2', [program('Two')])],
    );
    const shared = inventory(
      [{ resources: '/Font<</F1 100 0 R/F2 110 0 R>>' }],
      [taggedTrueType(100, 101), ...embedded(101, 'FontFile2', [program('One')]), taggedTrueType(110, 101)],
    );
    expect([different, shared].map(result => result.fonts.map(entry => codes(entry)))).toStrictEqual([
      [['subset-tag-reused'], ['subset-tag-reused']],
      [[], []],
    ]);
  });

  it('reports a Type 3 font by its descriptor name, with embedding and subset not applicable', () => {
    const font = onPage('/Font<</T3 110 0 R>>', [
      { number: 110, body: `<<${TYPE3}/FontDescriptor 112 0 R>>` },
      { number: 111, body: streamBody('', '1000 0 0 0 750 750 d1 0 0 750 750 re f') },
      { number: 112, body: '<</Type/FontDescriptor/FontName/AAAAAA+Chromium/Flags 4>>' },
    ]);
    expect([text(font.name), font.embedding, font.subset, font.encoding, font.problems]).toStrictEqual([
      'AAAAAA+Chromium',
      { state: 'not-applicable' },
      { state: 'not-applicable', tag: 'AAAAAA' },
      { kind: 'differences', base: undefined, differences: 1 },
      [],
    ]);
  });

  it('flags a missing descriptor and missing widths for a simple font outside the standard 14, but not for a Type 3 font', () => {
    const plain = onPage('/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/NotStandard>>>>');
    const type3 = onPage('/Font<</T3 110 0 R>>', [
      { number: 110, body: `<<${TYPE3}>>` },
      { number: 111, body: streamBody('', '1000 0 d0') },
    ]);
    expect([codes(plain), plain.embedding, type3.problems]).toStrictEqual([
      ['descriptor-missing', 'widths-missing'],
      { state: 'not-embedded', standard14: false },
      [],
    ]);
  });

  it('exempts only Type 1 fonts with a standard 14 name from the descriptor requirement', () => {
    const trueType = onPage('/Font<</F1<</Type/Font/Subtype/TrueType/BaseFont/Helvetica/FirstChar 65/LastChar 65/Widths[600]>>>>');
    expect(codes(trueType)).toStrictEqual(['descriptor-missing']);
  });

  it('reads a ToUnicode entry that is not a stream as unreadable', () => {
    const font = onPage('/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica/ToUnicode/Identity-H>>>>');
    expect([font.toUnicode, codes(font)]).toStrictEqual(['unreadable', ['to-unicode-unreadable']]);
  });

  it('keeps a font whose program, descriptor entries or Type 3 resources cannot be read, and reports the damage', () => {
    const damaged = { number: 150, body: '<</A [ 1 2' };
    const trueType = onPage('/Font<</F1 100 0 R>>', [
      { number: 100, body: '<</Type/Font/Subtype/TrueType/BaseFont/Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>' },
      { number: 101, body: '<</Type/FontDescriptor/FontName/Test/Flags 32/FontFile2 150 0 R>>' },
      damaged,
    ]);
    const type3 = onPage('/Font<</T3 110 0 R>>', [
      { number: 110, body: `<<${TYPE3}/FontDescriptor 112 0 R/Resources 150 0 R>>` },
      { number: 111, body: streamBody('', '1000 0 d0 0 0 1 1 re f') },
      { number: 112, body: '<</Type/FontDescriptor/FontName 150 0 R/Flags 4>>' },
      damaged,
    ]);
    expect([trueType.embedding, codes(trueType), type3.type3, codes(type3)]).toStrictEqual([
      { state: 'unreadable', file: 'FontFile2' },
      ['font-unreadable'],
      { glyphs: 'vector', procedures: 1, coloured: 1 },
      ['font-unreadable'],
    ]);
  });

  it('lists the pages whose resources reach each font, ordered by the first page and then by object number', () => {
    const result = inventory(
      [{ resources: '/Font<</F1 120 0 R>>' }, { resources: '/XObject<</X1 130 0 R>>' }, { resources: '/Font<</F1 120 0 R/F2 100 0 R>>' }],
      [helvetica(100), helvetica(120), { number: 130, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources<</Font<</F3 100 0 R>>>>', '') }],
    );
    expect(result.fonts.map(font => [font.key, font.pages])).toStrictEqual([
      ['120.0', [0, 2]],
      ['100.0', [1, 2]],
    ]);
  });

  it('keys a direct font in a form as content interpretation does', () => {
    const result = inventory(
      [{ resources: '/XObject<</X1 130 0 R>>' }],
      [
        {
          number: 130,
          body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources<</Font<</F3<</Type/Font/Subtype/Type1/BaseFont/Courier>>>>>>', ''),
        },
      ],
    );
    expect(result.fonts.map(font => font.key)).toStrictEqual(['direct:130.0:4633']);
  });

  it('refuses a shownOn that is not a boolean', () => {
    const document = loadDocument(textPdfBytes({ pages: [{}] }));
    for (const value of ['no', 0, null]) {
      const options: ListFontsOptions = {};
      Reflect.set(options, 'shownOn', value);
      expect(() => listFonts(document, options)).toThrow(InvalidArgumentError);
    }
  });

  it('refuses a value that is not a loaded document', () => {
    const source = loadDocument(textPdfBytes({ pages: [{}] }));
    expect(() => listFonts({ ...source })).toThrow(InvalidArgumentError);
  });
});

const shown = (pages: readonly TestPage[], objects: readonly TestObject[] = [], options: ListFontsOptions = {}): string[][] =>
  inventory(pages, objects, options).fonts.map(font => [font.key, font.shownOn.join(' ')]);

const appearance = (number: number, font: string): TestObject => ({
  number,
  body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</Font<</F1 ${font}>>>>`, 'BT /F1 1 Tf (c) Tj ET'),
});

describe('pages that show each font', () => {
  it('lists the pages whose content shows a string with the font, keyed as the resource walk keys it', () => {
    const helveticaResource = '/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>/F2 100 0 R>>';
    const result = shown(
      [
        { resources: helveticaResource, content: 'BT /F1 12 Tf (a) Tj /F2 12 Tf () Tj ET' },
        { resources: '/XObject<</X1 130 0 R>>', content: '/X1 Do' },
      ],
      [
        helvetica(100),
        { number: 130, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources<</Font<</F3 100 0 R>>>>', 'BT /F3 1 Tf (b) Tj ET') },
      ],
    );
    expect(result).toStrictEqual([
      ['100.0', '1'],
      ['direct:3.0:4631', '0'],
    ]);
  });

  it('counts a font set by a graphics state, text in printable annotation appearances, and text inside Type 3 glyph procedures', () => {
    const result = shown(
      [
        {
          resources: '/ExtGState<</G1<</Font[101 0 R 12]>>>>/Font<</T3 110 0 R>>',
          content: 'BT /G1 gs (a) Tj ET BT /T3 10 Tf (a) Tj ET',
          entries:
            '/Annots[<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/F 4/AP<</N 120 0 R>>>> <</Type/Annot/Subtype/Square/Rect[0 0 10 10]/AP<</N 121 0 R>>>>]',
        },
      ],
      [
        helvetica(100),
        helvetica(101),
        helvetica(102),
        helvetica(103),
        {
          number: 110,
          body: `<<${TYPE3}/Resources<</Font<</F9 100 0 R>>>>>>`,
        },
        { number: 111, body: streamBody('', '1000 0 d0 BT /F9 1 Tf (A) Tj ET') },
        appearance(120, '102 0 R'),
        appearance(121, '103 0 R'),
      ],
    );
    expect(result).toStrictEqual([
      ['100.0', '0'],
      ['101.0', '0'],
      ['102.0', '0'],
      ['103.0', ''],
      ['110.0', '0'],
    ]);
  });

  it('lists a direct font in a shared indirect Font dictionary or graphics state once, and every page that shows it', () => {
    const pages = [0, 1].map(() => ({ resources: '/Font 100 0 R/ExtGState<</G1 101 0 R>>', content: 'BT /F1 12 Tf (a) Tj /G1 gs (b) Tj ET' }));
    const result = shown(pages, [
      { number: 100, body: '<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>' },
      { number: 101, body: '<</Font[<</Type/Font/Subtype/Type1/BaseFont/Courier>> 12]>>' },
    ]);
    expect(result).toStrictEqual([
      ['direct:100.0:4631', '0 1'],
      ['direct:101.0:ExtGState:', '0 1'],
    ]);
  });

  it('leaves shownOn empty when asked not to interpret content', () => {
    const result = shown([{ resources: '/Font<</F1 100 0 R>>', content: 'BT /F1 12 Tf (a) Tj ET' }], [helvetica(100)], { shownOn: false });
    expect(result).toStrictEqual([['100.0', '']]);
  });
});

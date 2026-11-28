import type { CMapProvider } from '../../font/cmap/cmapProvider.ts';
import type { PdfReference } from '../../object/pdfObject.ts';
import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { TestPage, TextPdf } from '../../testing/textPdf.ts';
import type { FontEntry, FontInventory, ListFontsOptions } from './listFonts.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { pdfReference } from '../../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { listFonts } from './listFonts.ts';

const inventory = (pages: ReadonlyArray<TestPage>, objects: ReadonlyArray<TestObject> = [], options: ListFontsOptions = {}): FontInventory =>
  listFonts(loadDocument(textPdfBytes({ pages, objects })), options);

const DAMAGED: TestObject = { number: 150, body: '<</A [ 1 2' };

const only = (result: FontInventory): FontEntry => {
  const [font, ...rest] = result.fonts;
  if (font === undefined || rest.length > 0) {
    throw new Error(`expected one font, found ${String(result.fonts.length)}`);
  }
  return font;
};

const onPage = (resources: string, objects: ReadonlyArray<TestObject> = []): FontEntry => only(inventory([{ resources }], objects));

const program = (name: string): string =>
  latin1Text(syntheticTrueType({ name, glyphs: [{ advance: 500 }, { advance: 600, box: [0, 0, 500, 700] }], characters: [[0x41, 1]] }));

const embedded = (number: number, key: string, [data, dictionary = '']: readonly [string, string?]): ReadonlyArray<TestObject> => [
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

const type0With = (cid: string, fileSubtype = 'CIDFontType0C'): ReadonlyArray<TestObject> => [
  { number: 100, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[102 0 R]>>' },
  { number: 102, body: `<</Type/Font/Subtype/${cid}/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor 103 0 R>>` },
  ...embedded(103, 'FontFile3', ['data', `/Subtype/${fileSubtype}`]),
];

const taggedTrueType = (number: number, descriptor: number): TestObject => ({
  number,
  body: `<</Type/Font/Subtype/TrueType/BaseFont/AAAAAA+Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor ${String(descriptor)} 0 R>>`,
});

const helvetica = (number: number): TestObject => ({ number, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' });

const codes = (entry: FontEntry): Array<string> => entry.problems.map(problem => problem.code);

describe('font inventory', () => {
  it('lists a font only named by AcroForm default resources', () => {
    const { bytes } = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R/AcroForm 4 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
          { number: 4, body: '<</DR 5 0 R/Fields[]>>' },
          { number: 5, body: '<</Font<</F1 6 0 R>>>>' },
          helvetica(6),
        ],
        trailer: '/Root 1 0 R',
      },
    ]);
    const result = listFonts(loadDocument(bytes));
    expect(result.fonts.map(font => [text(font.name), font.pages, font.shownOn])).toStrictEqual([['Helvetica', [], []]]);
  });

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
    const objects: ReadonlyArray<TestObject> = [
      {
        number: 100,
        body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/90ms-RKSJ-V/DescendantFonts[<</Type/Font/Subtype/CIDFontType0/BaseFont/Test>>]>>',
      },
    ];
    const cmap = latin1Bytes('/WMode 1 def begincmap 1 begincodespacerange <00> <FF> endcodespacerange endcmap');
    const provider: CMapProvider = { cmap: name => new Map([['90ms-RKSJ-V', cmap]]).get(name) };
    const without = only(inventory([{ resources: '/Font<</F1 100 0 R>>' }], objects));
    const supplied = only(inventory([{ resources: '/Font<</F1 100 0 R>>' }], objects, { cmapProvider: provider }));
    // ISO 32000-1:2008, Table 117: a CIDFont's FontDescriptor is required, so both report it missing.
    expect([without.encoding, codes(without), supplied.encoding, codes(supplied)]).toStrictEqual([
      { kind: 'cmap', name: latin1Bytes('90ms-RKSJ-V'), predefined: true, embedded: false, writingMode: 1, available: false },
      ['descriptor-missing', 'cmap-unavailable'],
      { kind: 'cmap', name: latin1Bytes('90ms-RKSJ-V'), predefined: true, embedded: false, writingMode: 1, available: true },
      ['descriptor-missing'],
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

  // ISO 32000-1:2008, Table 126: FontFile holds a Type 1 program, for Type1 and MMType1 fonts; a FontFile3 stream is told apart by its Subtype.
  it.each([
    ['Type1', 'FontFile', undefined, true],
    ['MMType1', 'FontFile', undefined, true],
    ['MMType1', 'FontFile3', 'Type1C', true],
    ['TrueType', 'FontFile', undefined, false],
    ['Type1', 'FontFile3', undefined, false],
  ] as const)('checks a %s font with a %s program of Subtype %s against Table 126', (subtype, file, fileSubtype, matches) => {
    const font = onPage('/Font<</F1 100 0 R>>', [
      { number: 100, body: `<</Type/Font/Subtype/${subtype}/BaseFont/Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>` },
      ...embedded(101, file, ['data', fileSubtype === undefined ? '' : `/Subtype/${fileSubtype}`]),
    ]);
    expect(font.embedding).toStrictEqual({
      state: 'embedded',
      file,
      fileSubtype: fileSubtype === undefined ? undefined : latin1Bytes(fileSubtype),
      matchesFontType: matches,
    });
  });

  it('reads the embedded program of a Type 0 font from its descendant, accepting CIDFontType0C only for CIDFontType0', () => {
    const results = ['CIDFontType0', 'CIDFontType2'].map(cid => onPage('/Font<</F1 100 0 R>>', type0With(cid)).embedding);
    expect(results).toStrictEqual([
      { state: 'embedded', file: 'FontFile3', fileSubtype: latin1Bytes('CIDFontType0C'), matchesFontType: true },
      { state: 'embedded', file: 'FontFile3', fileSubtype: latin1Bytes('CIDFontType0C'), matchesFontType: false },
    ]);
  });

  it('accepts an OpenType program for either kind of CIDFont', () => {
    const results = ['CIDFontType0', 'CIDFontType2'].map(cid => onPage('/Font<</F1 100 0 R>>', type0With(cid, 'OpenType')).embedding);
    expect(results).toStrictEqual(
      ['CIDFontType0', 'CIDFontType2'].map(() => ({ state: 'embedded', file: 'FontFile3', fileSubtype: latin1Bytes('OpenType'), matchesFontType: true })),
    );
  });

  // ISO 32000-1:2008, Table 122: at most one of FontFile, FontFile2 and FontFile3 is present; the first that is a stream is taken.
  it.each([
    ['FontFile and FontFile2 streams', '/FontFile 102 0 R/FontFile2 103 0 R', 'FontFile'],
    ['a FontFile that is not a stream and a FontFile2 stream', '/FontFile 42/FontFile2 103 0 R', 'FontFile2'],
  ])('takes the first program of a descriptor with %s', (_, programs, file) => {
    const font = onPage('/Font<</F1 100 0 R>>', [
      { number: 100, body: '<</Type/Font/Subtype/TrueType/BaseFont/Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>' },
      { number: 101, body: `<</Type/FontDescriptor/FontName/Test/Flags 32${programs}>>` },
      { number: 102, body: streamBody('', 'type 1') },
      { number: 103, body: streamBody('', program('Test')) },
    ]);
    expect(font.embedding.state === 'embedded' ? font.embedding.file : font.embedding.state).toBe(file);
  });

  it('reports a subset tag that is not six uppercase letters as malformed', () => {
    const font = onPage('/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/AbCDEF+Test/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>>>', [
      { number: 101, body: '<</Type/FontDescriptor/FontName/AbCDEF+Test/Flags 32>>' },
    ]);
    expect([font.subset, codes(font)]).toStrictEqual([{ state: 'not-subset' }, ['subset-tag-malformed']]);
  });

  // ISO 32000-1:2008, 9.6.4: "The tag shall consist of exactly six uppercase letters", followed by a plus sign.
  it.each([
    ['ABCDEF+', { state: 'subset', tag: 'ABCDEF' }, []],
    ['ABCDE+Test', { state: 'not-subset' }, []],
    ['ABCDEFG+Test', { state: 'not-subset' }, []],
    ['ABCDEF', { state: 'not-subset' }, []],
    ['ABCDE1+Test', { state: 'not-subset' }, ['subset-tag-malformed']],
  ])('reads the name %s as %o', (name, subset, problems) => {
    const font = onPage(`/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/${name}/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>>>`, [
      { number: 101, body: `<</Type/FontDescriptor/FontName/${name}/Flags 32>>` },
    ]);
    expect([font.subset, codes(font)]).toStrictEqual([subset, problems]);
  });

  it('reports no tag for a Type 3 font whose tag is malformed, and the malformed tag', () => {
    const font = onPage('/Font<</T3 110 0 R>>', [
      { number: 110, body: `<<${TYPE3}/FontDescriptor 112 0 R>>` },
      { number: 111, body: streamBody('', '1000 0 d0') },
      { number: 112, body: '<</Type/FontDescriptor/FontName/abcdef+X/Flags 4>>' },
    ]);
    expect([font.subset, codes(font)]).toStrictEqual([{ state: 'not-applicable', tag: undefined }, ['subset-tag-malformed']]);
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

  it('tells programs apart by their bytes, not their objects, and ignores a tagged font without a program', () => {
    const copies = inventory(
      [{ resources: '/Font<</F1 100 0 R/F2 110 0 R>>' }],
      [taggedTrueType(100, 101), ...embedded(101, 'FontFile2', [program('One')]), taggedTrueType(110, 111), ...embedded(111, 'FontFile2', [program('One')])],
    );
    const unembedded = inventory(
      [{ resources: '/Font<</F1 100 0 R/F2 110 0 R>>' }],
      [
        taggedTrueType(100, 101),
        ...embedded(101, 'FontFile2', [program('One')]),
        taggedTrueType(110, 111),
        { number: 111, body: '<</Type/FontDescriptor/FontName/AAAAAA+Test/Flags 32>>' },
      ],
    );
    expect([copies, unembedded].map(result => result.fonts.map(entry => codes(entry)))).toStrictEqual([
      [[], []],
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

  // ISO 32000-1:2008, Table 112: a Type 3 font's BaseFont is not defined, and its descriptor's FontName is the name a reader can give it.
  it.each([
    ['neither a descriptor nor a BaseFont', '', undefined],
    ['a BaseFont and no descriptor', '/BaseFont/Glyphs', 'Glyphs'],
    ['a BaseFont and a descriptor FontName', '/BaseFont/Glyphs/FontDescriptor 112 0 R', 'AAAAAA+Chromium'],
  ])('names a Type 3 font with %s', (_, entries, name) => {
    const font = onPage('/Font<</T3 110 0 R>>', [
      { number: 110, body: `<<${TYPE3}${entries}>>` },
      { number: 111, body: streamBody('', '1000 0 d0') },
      { number: 112, body: '<</Type/FontDescriptor/FontName/AAAAAA+Chromium/Flags 4>>' },
    ]);
    expect(text(font.name)).toBe(name);
  });

  // ISO 32000-1:2008, Table 116: Registry and Ordering are strings and Supplement an integer.
  it('reads only the string Registry and Ordering of a CIDSystemInfo, and no Supplement when it is absent', () => {
    const font = onPage('/Font<</F1 100 0 R>>', [
      { number: 100, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[102 0 R]>>' },
      { number: 102, body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry/Adobe/Ordering(Identity)>>/FontDescriptor 103 0 R>>' },
      ...embedded(103, 'FontFile2', [program('Test')]),
    ]);
    expect(font.descendant).toStrictEqual({
      subtype: 'CIDFontType2',
      reference: reference(102),
      registry: undefined,
      ordering: latin1Bytes('Identity'),
      supplement: undefined,
    });
  });

  // ISO 32000-1:2008, 9.10.3: "the value of the last byte in the string shall be less than or equal to 255 − (srcCode2 − srcCode1)".
  it.each([
    ['passes byte 255', '<00FA>', ['to-unicode-range-overflow']],
    ['ends at byte 255', '<00EF>', []],
  ])('reports a ToUnicode bfrange whose destination %s', (_, destination, problems) => {
    const cmap = `begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <51> ${destination} endbfrange endcmap`;
    const font = onPage('/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica/ToUnicode 100 0 R>>>>', [{ number: 100, body: streamBody('', cmap) }]);
    expect(codes(font)).toStrictEqual(problems);
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
    // The FontName and the Resources are objects damaged in different ways, so that each report is seen to come from its own read.
    const type3 = inventory(
      [{ resources: '/Font<</T3 110 0 R>>' }],
      [
        { number: 110, body: `<<${TYPE3}/FontDescriptor 112 0 R/Resources 151 0 R>>` },
        { number: 111, body: streamBody('', '1000 0 d0 0 0 1 1 re f') },
        { number: 112, body: '<</Type/FontDescriptor/FontName 150 0 R/Flags 4>>' },
        damaged,
        { number: 151, body: '<</C 1 2>>' },
      ],
    );
    const font = only(type3);
    expect([
      trueType.embedding,
      codes(trueType),
      font.type3,
      font.problems.map(problem => [problem.code, /FontName/u.test(problem.detail)]),
      type3.unreadable.map(entry => [entry.page, /a dictionary key must be a name/u.test(entry.reason)]),
    ]).toStrictEqual([
      { state: 'unreadable', file: 'FontFile2' },
      ['font-unreadable'],
      { glyphs: 'vector', procedures: 1, coloured: 1 },
      [['font-unreadable', true]],
      [[0, true]],
    ]);
  });

  it('lists the pages whose resources reach each font, ordered by the first page and then by object number', () => {
    // Page 3 first reaches 200 and 1000, whose keys sort the other way as text, and the resource walk meets 1000 first.
    const result = inventory(
      [
        { resources: '/Font<</F1 120 0 R>>' },
        { resources: '/XObject<</X1 130 0 R>>' },
        { resources: '/Font<</F1 120 0 R/F2 100 0 R>>' },
        { resources: '/Font<</F1 200 0 R/F2 1000 0 R>>' },
      ],
      [
        helvetica(100),
        helvetica(120),
        { number: 130, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources<</Font<</F3 100 0 R>>>>', '') },
        helvetica(200),
        helvetica(1000),
      ],
    );
    expect(result.fonts.map(font => [font.key, font.pages])).toStrictEqual([
      ['120.0', [0, 2]],
      ['100.0', [1, 2]],
      ['200.0', [3]],
      ['1000.0', [3]],
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

  it.each([
    [
      'a font dictionary that cannot be read',
      { pages: [{ resources: '/Font<</F1 100 0 R>>' }], objects: [{ number: 100, body: '<</Type/Font/Subtype/Type1/BaseFont 150 0 R>>' }, DAMAGED] },
      0,
      /font 100\.0/u,
    ],
    [
      'AcroForm default resources that cannot be read',
      { pages: [{}], objects: [DAMAGED], catalog: '/AcroForm<</DR 150 0 R/Fields[]>>' },
      -1,
      /unexpected keyword endobj/u,
    ],
    ['content that names a missing font', { pages: [{ resources: '', content: 'BT /Missing 12 Tf ET' }] }, 0, /Missing/u],
  ])('reports %s as unreadable on its page', (_, pdf: TextPdf, page, reason) => {
    const result = listFonts(loadDocument(textPdfBytes(pdf)));
    expect(result.unreadable.map(entry => [entry.page, reason.test(entry.reason)])).toStrictEqual([[page, true]]);
  });
});

const shown = (pages: ReadonlyArray<TestPage>, objects: ReadonlyArray<TestObject> = [], options: ListFontsOptions = {}): Array<Array<string>> =>
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

describe('properties', () => {
  // Names biased towards a plus sign at index 6, where the subset tag rule decides.
  const name = fc.oneof(
    fc.stringMatching(/^[A-Z]{6}\+[A-Za-z]{0,4}$/u),
    fc.stringMatching(/^[A-Za-z0-9]{6}\+[A-Za-z]{0,4}$/u),
    fc.stringMatching(/^[A-Za-z0-9+]{1,10}$/u),
  );

  // ISO 32000-1:2008, 9.6.4: a subset name begins with "exactly six uppercase letters" and a plus sign.
  it('reads a subset tag exactly when six uppercase letters precede a plus sign, and a malformed one when other characters do', () => {
    fc.assert(
      fc.property(name, baseFont => {
        const font = onPage(`/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/${baseFont}/FirstChar 65/LastChar 65/Widths[600]/FontDescriptor 101 0 R>>>>`, [
          { number: 101, body: `<</Type/FontDescriptor/FontName/${baseFont}/Flags 32>>` },
        ]);
        const tagged = /^[A-Z]{6}\+/u.test(baseFont);
        expect([font.subset, codes(font).includes('subset-tag-malformed')]).toStrictEqual([
          tagged ? { state: 'subset', tag: baseFont.slice(0, 6) } : { state: 'not-subset' },
          baseFont[6] === '+' && !tagged,
        ]);
      }),
    );
  });

  // Pages that each list some of a set of indirect fonts in some order, and perhaps a direct font of their own.
  const pages = fc
    .uniqueArray(fc.integer({ min: 100, max: 1500 }), { minLength: 1, maxLength: 5 })
    .chain(numbers => fc.array(fc.record({ fonts: fc.shuffledSubarray(numbers), direct: fc.boolean() }), { minLength: 1, maxLength: 4 }));

  it('orders fonts by the first page that reaches them, then indirect fonts by object number before direct fonts', () => {
    fc.assert(
      fc.property(pages, generated => {
        const numbers = [...new Set(generated.flatMap(page => page.fonts))];
        const result = inventory(
          generated.map(page => ({
            resources: `/Font<<${page.fonts.map((number, index) => `/F${String(index)} ${String(number)} 0 R`).join('')}${page.direct ? '/D<</Type/Font/Subtype/Type1/BaseFont/Courier>>' : ''}>>`,
          })),
          numbers.map(number => helvetica(number)),
          { shownOn: false },
        );
        const first = (number: number): number => generated.findIndex(page => page.fonts.includes(number));
        const expected = generated
          .flatMap((page, index) => [
            ...numbers.filter(number => first(number) === index).toSorted((left, right) => left - right),
            ...(page.direct ? ['direct'] : []),
          ])
          .map(font => (typeof font === 'number' ? `${String(font)}.0` : font));
        expect(result.fonts.map(font => (font.reference === undefined ? 'direct' : font.key))).toStrictEqual(expected);
      }),
    );
  });
});

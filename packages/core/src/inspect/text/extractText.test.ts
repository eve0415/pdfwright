import type { CMapProvider } from '../../font/cmap/cmapProvider.ts';
import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { TestPage } from '../../testing/textPdf.ts';
import type { ExtractTextOptions, PageGlyph, PageText } from './extractText.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { pdfReference } from '../../object/pdfObject.ts';
import { latin1Bytes, latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { extractText } from './extractText.ts';

// Code 32 is 250 thousandths wide, A (65) 600 and B (66) 500; the descriptor gives descent −200 and ascent 800.
const WIDTHS = [250, ...Array.from({ length: 32 }, () => 0), 600, 500].join(' ');
const SIMPLE_FONT: TestObject = {
  number: 101,
  body: `<</Type/Font/Subtype/Type1/BaseFont/Test/FirstChar 32/LastChar 66/Widths[${WIDTHS}]/FontDescriptor 110 0 R>>`,
};
const SIMPLE_DESCRIPTOR: TestObject = {
  number: 110,
  body: '<</Type/FontDescriptor/FontName/Test/Flags 32/FontBBox[0 -200 1000 800]/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80>>',
};
// An Identity-H font whose CID 32 is 500 thousandths wide and every other CID 1000, with descent −120 and ascent 880.
const HORIZONTAL_FONT: TestObject = { number: 102, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[104 0 R]>>' };
const CID_FONT: TestObject = {
  number: 104,
  body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000/W[32[500]]/FontDescriptor 111 0 R>>',
};
const CID_DESCRIPTOR: TestObject = {
  number: 111,
  body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontBBox[0 -120 1000 880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>',
};
const FONTS = [SIMPLE_FONT, SIMPLE_DESCRIPTOR, HORIZONTAL_FONT, CID_FONT, CID_DESCRIPTOR];
const FONT_RESOURCES = '/Font<</F1 101 0 R/H 102 0 R>>';

const extract = (page: TestPage, objects: readonly TestObject[] = [], options: ExtractTextOptions = {}): PageText =>
  extractText(loadDocument(textPdfBytes({ pages: [page], objects: [...FONTS, ...objects] })), 0, options);

const glyphs = (content: string, objects: readonly TestObject[] = [], resources = FONT_RESOURCES): readonly PageGlyph[] =>
  extract({ content, resources }, objects).glyphs;

const round = (values: readonly number[]): number[] => values.map(value => Math.round(value * 1e6) / 1e6 + 0);

const origins = (shown: readonly PageGlyph[]): number[][] => shown.map(glyph => round(glyph.origin));

const at = (shown: readonly PageGlyph[], index: number): PageGlyph => {
  const glyph = shown[index];
  if (glyph === undefined) throw new Error(`no glyph ${String(index)} among ${String(shown.length)}`);
  return glyph;
};

const one = (shown: readonly PageGlyph[]): PageGlyph => {
  if (shown.length !== 1) throw new Error(`expected one glyph, found ${String(shown.length)}`);
  return at(shown, 0);
};

const toUnicode = (entries: string): TestObject => ({
  number: 130,
  body: streamBody(
    '',
    `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange ${entries} endcmap end end`,
  ),
});
const simple = (encoding: string, extra = ''): TestObject => ({
  number: 105,
  body: `<</Type/Font/Subtype/Type1/BaseFont/Test/FirstChar 65/LastChar 66/Widths[600 500]/Encoding ${encoding}${extra}/FontDescriptor 110 0 R>>`,
});
const textOf = (content: string, objects: readonly TestObject[], options: ExtractTextOptions = {}): unknown[][] =>
  extract({ content, resources: '/Font<</T 105 0 R>>' }, objects, options).glyphs.map(glyph => [glyph.text, glyph.toUnicode, glyph.encodingText, glyph.reason]);

const type0 = (encoding: string, ordering: string, extra = ''): readonly TestObject[] => [
  { number: 105, body: `<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding ${encoding}/DescendantFonts[106 0 R]${extra}>>` },
  {
    number: 106,
    body: `<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(${ordering})/Supplement 0>>/DW 1000/FontDescriptor 111 0 R>>`,
  },
];
const cmapFile = (name: string, body: string): Uint8Array =>
  latin1Bytes(
    `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /${name} def ${body} endcmap CMapName currentdict /CMap defineresource pop end end`,
  );
// CID 2115 is 山 in Adobe-Japan1; the provider's maps are cut down to that one character.
const PROVIDED = new Map([
  ['Adobe-Japan1-UCS2', cmapFile('Adobe-Japan1-UCS2', '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0843> <5C71> endbfchar')],
  [
    '90ms-RKSJ-H',
    cmapFile(
      '90ms-RKSJ-H',
      '/CIDSystemInfo 3 dict dup begin /Registry (Adobe) def /Ordering (Japan1) def /Supplement 2 def end def 2 begincodespacerange <00> <80> <8140> <9FFC> endcodespacerange 1 begincidchar <8E52> 2115 endcidchar',
    ),
  ],
]);
const provider: CMapProvider = { cmap: name => PROVIDED.get(name) };

const spans = (content: string, resources = FONT_RESOURCES, objects: readonly TestObject[] = []): PageText => extract({ content, resources }, objects);

const vertical = (cidFont: string): readonly TestObject[] => [
  { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-V/DescendantFonts[106 0 R]>>' },
  {
    number: 106,
    body: `<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000${cidFont}/FontDescriptor 111 0 R>>`,
  },
];
const boxes = (shown: readonly PageGlyph[]): unknown[] => shown.map(glyph => [glyph.writingMode, round(glyph.origin), round(glyph.advance), round(glyph.quad)]);

const shownIn = (content: string, cidFont = ''): readonly PageGlyph[] => glyphs(content, vertical(cidFont), '/Font<</V 105 0 R>>');

describe('text extraction', () => {
  it('places each glyph at the origin the text rendering matrix gives, with its advance and advance box', () => {
    const shown = glyphs('BT /F1 10 Tf 100 200 Td (AB) Tj ET');
    const [a, b] = [at(shown, 0), at(shown, 1)];
    expect(shown).toHaveLength(2);
    // 9.4.4: Trm = [Tfs×Th 0 0 Tfs 0 Trise] × Tm × CTM; the box spans w0 = 0.6 and descent −0.2 to ascent 0.8, times Tfs 10.
    expect([latin1Text(a.code), a.font, round(a.origin), round(a.advance), round(a.quad), a.fontSize]).toStrictEqual([
      'A',
      '101.0',
      [100, 200],
      [6, 0],
      [100, 198, 106, 198, 106, 208, 100, 208],
      10,
    ]);
    expect([b.index, round(b.origin), round(b.advance)]).toStrictEqual([1, [106, 200], [5, 0]]);
  });

  it('adds character spacing to every glyph', () => {
    // 9.4.4: tx = ((w0 − Tj/1000) × Tfs + Tc + Tw) × Th = 0.6 × 10 + 2.
    const shown = glyphs('BT /F1 10 Tf 2 Tc 100 200 Td (AB) Tj ET');
    expect([origins(shown), round(at(shown, 0).advance)]).toStrictEqual([
      [
        [100, 200],
        [108, 200],
      ],
      [8, 0],
    ]);
  });

  it('adds word spacing to single-byte code 32 only, never to a two-byte code 32', () => {
    // 9.3.3: word spacing applies to "the single-byte character code 32 in a string when using a simple font or a composite font that defines code 32 as a single-byte code".
    expect(origins(glyphs('BT /F1 10 Tf 5 Tw 100 200 Td ( A) Tj ET'))).toStrictEqual([
      [100, 200],
      [107.5, 200],
    ]);
    expect(origins(glyphs('BT /H 10 Tf 5 Tw 100 200 Td <00200041> Tj ET'))).toStrictEqual([
      [100, 200],
      [105, 200],
    ]);
  });

  it('scales the box and the horizontal spacing by the horizontal scaling', () => {
    // 9.3.4: Th = Tz / 100 scales the glyph and Tc and Tw in horizontal writing: (0.6 × 10 + 1) × 0.5.
    const shown = glyphs('BT /F1 10 Tf 50 Tz 1 Tc 100 200 Td (AB) Tj ET');
    expect([round(at(shown, 0).quad), round(at(shown, 0).advance), round(at(shown, 1).origin)]).toStrictEqual([
      [100, 198, 103, 198, 103, 208, 100, 208],
      [3.5, 0],
      [103.5, 200],
    ]);
  });

  it('moves to the next line by the leading with T*, the quote and the double quote', () => {
    // Table 108 and Table 109: T*, ' and " move to the next line by −TL; " also sets Tw and Tc.
    const shown = glyphs('BT /F1 10 Tf 12 TL 50 700 Td (A) Tj T* (A) Tj (A) \' 3 1 (A B) " ET');
    expect(origins(shown)).toStrictEqual([
      [50, 700],
      [50, 688],
      [50, 676],
      [50, 664],
      [57, 664],
      [63.5, 664],
    ]);
  });

  it('raises the origin by the text rise', () => {
    expect(origins(glyphs('BT /F1 10 Tf 3 Ts 100 200 Td (A) Tj ET'))).toStrictEqual([[100, 203]]);
  });

  it('subtracts TJ numbers from the position of the next glyph', () => {
    // Table 109: a TJ number "shall be subtracted from the current horizontal or vertical coordinate", in thousandths of text space.
    expect(origins(glyphs('BT /F1 10 Tf 100 200 Td [(A) -500 (B)] TJ ET'))).toStrictEqual([
      [100, 200],
      [111, 200],
    ]);
  });

  it('transforms by the text matrix and the CTM', () => {
    const scaled = one(glyphs('2 0 0 2 10 20 cm BT /F1 10 Tf 1 0 0 1 5 5 Tm (A) Tj ET'));
    expect([round(scaled.origin), round(scaled.advance), scaled.fontSize]).toStrictEqual([[20, 30], [12, 0], 20]);
    const rotated = one(glyphs('BT /F1 10 Tf 0 1 -1 0 300 300 Tm (A) Tj ET'));
    expect([round(rotated.origin), round(rotated.advance), round(rotated.quad)]).toStrictEqual([
      [300, 300],
      [0, 6],
      [302, 300, 302, 306, 292, 306, 292, 300],
    ]);
  });

  it('places text in a form by its Matrix and names the form as the source', () => {
    const form = {
      number: 120,
      body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 500 500]/Matrix[1 0 0 1 50 60]/Resources<<${FONT_RESOURCES}>>`, 'BT /F1 10 Tf (A) Tj ET'),
    };
    const glyph = one(extract({ content: '/X Do', resources: '/XObject<</X 120 0 R>>' }, [form]).glyphs);
    expect([round(glyph.origin), glyph.source]).toStrictEqual([[50, 60], { kind: 'form', reference: pdfReference(120, 0) }]);
  });

  it('reads annotation appearances only when asked, under the appearance matrix', () => {
    // 12.5.5: the BBox [0 0 100 50] is mapped onto the Rect [200 300 400 400], a scale of 2 and a translation of (200, 300).
    const appearance = {
      number: 121,
      body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 100 50]/Resources<<${FONT_RESOURCES}>>`, 'BT /F1 10 Tf 10 10 Td (A) Tj ET'),
    };
    const annotation = { number: 122, body: '<</Type/Annot/Subtype/FreeText/Rect[200 300 400 400]/F 4/AP<</N 121 0 R>>>>' };
    const page: TestPage = { content: '', resources: FONT_RESOURCES, entries: '/Annots[122 0 R]' };
    expect(extract(page, [appearance, annotation]).glyphs).toStrictEqual([]);
    const glyph = one(extract(page, [appearance, annotation], { annotations: 'printable' }).glyphs);
    expect([round(glyph.origin), glyph.fontSize, glyph.source]).toStrictEqual([[220, 320], 20, { kind: 'annotation', index: 0 }]);
  });

  it('reports the marked-content sequences and MCIDs each glyph lies in', () => {
    const glyph = one(glyphs('/P <</MCID 3>> BDC /Artifact BMC BT /F1 10 Tf (A) Tj ET EMC EMC'));
    expect(glyph.markedContent.map(({ tag, mcid }) => [latin1Text(tag), mcid])).toStrictEqual([
      ['P', 3],
      ['Artifact', undefined],
    ]);
  });

  it('reports the code, CID, glyph index and text layers the font gives', () => {
    const glyph = one(glyphs('BT /H 10 Tf <0041> Tj ET'));
    expect([[...glyph.code], glyph.cid, glyph.gid, glyph.toUnicode, glyph.encodingText, glyph.notdef, glyph.writingMode]).toStrictEqual([
      [0, 65],
      65,
      65,
      null,
      null,
      false,
      0,
    ]);
  });

  it('keeps a string the font cannot split as one entry and loses the position after it', () => {
    const font: TestObject = { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/90ms-RKSJ-H/DescendantFonts[104 0 R]>>' };
    const shown = glyphs('BT /F1 10 Tf 100 200 Td (A) Tj /J 10 Tf <8341> Tj /F1 10 Tf (A) Tj 0 -20 Td (A) Tj ET', [font], '/Font<</F1 101 0 R/J 105 0 R>>');
    expect(shown.map(glyph => [[...glyph.code], glyph.font, round(glyph.origin), glyph.positionKnown])).toStrictEqual([
      [[65], '101.0', [100, 200], true],
      [[0x83, 0x41], '105.0', [106, 200], true],
      [[65], '101.0', [106, 200], false],
      [[65], '101.0', [100, 180], true],
    ]);
  });

  it('reports the CropBox and a bad page index', () => {
    const text = extract({ content: '', entries: '/CropBox[10 20 300 400]' });
    expect([text.page, text.cropBox, text.complete, text.warnings]).toStrictEqual([0, [10, 20, 300, 400], true, []]);
    expect(() => extractText(loadDocument(textPdfBytes({ pages: [{}] })), 1)).toThrow(InvalidArgumentError);
  });

  describe('glyph text', () => {
    it('takes ToUnicode first, then the glyph name of the encoding', () => {
      // 9.10.2: ToUnicode first; for a simple font the glyph name the encoding gives the code.
      expect(
        textOf('BT /T 10 Tf (AB) Tj ET', [simple('/WinAnsiEncoding', '/ToUnicode 130 0 R'), toUnicode('1 beginbfchar <41> <0058> endbfchar')]),
      ).toStrictEqual([
        ['X', 'X', 'A', undefined],
        ['B', null, 'B', undefined],
      ]);
    });

    it('gives no text for a glyph name that maps to nothing, and marks notdef glyphs', () => {
      expect(textOf('BT /T 10 Tf (AB) Tj ET', [simple('<</Differences[65/foo/.notdef]>>')])).toStrictEqual([
        [null, null, null, 'no-mapping'],
        [null, null, null, 'notdef'],
      ]);
    });

    it('maps CIDs of the Adobe collections through the registry–ordering–UCS2 map the provider supplies', () => {
      // 9.10.2: a descendant in "the Adobe-GB1, Adobe-CNS1, Adobe-Japan1, or Adobe-Korea1 character collection" maps through registry–ordering–UCS2.
      const objects = type0('/Identity-H', 'Japan1');
      expect(textOf('BT /T 10 Tf <0843> Tj ET', objects, { cmapProvider: provider })).toStrictEqual([['山', null, '山', undefined]]);
      expect(textOf('BT /T 10 Tf <0843> Tj ET', objects)).toStrictEqual([[null, null, null, 'predefined-cmap-unavailable']]);
      expect(textOf('BT /T 10 Tf <0843> Tj ET', type0('/Identity-H', 'Identity'), { cmapProvider: provider })).toStrictEqual([
        [null, null, null, 'no-mapping'],
      ]);
    });

    it('splits strings by a predefined CMap the provider supplies, and keeps them whole without one', () => {
      const objects = type0('/90ms-RKSJ-H', 'Japan1');
      const withProvider = extract({ content: 'BT /T 10 Tf <8E52> Tj ET', resources: '/Font<</T 105 0 R>>' }, objects, { cmapProvider: provider }).glyphs;
      expect(withProvider.map(glyph => [[...glyph.code], glyph.cid, glyph.text])).toStrictEqual([[[0x8e, 0x52], 2115, '山']]);
      expect(textOf('BT /T 10 Tf <8E52> Tj ET', objects)).toStrictEqual([[null, null, null, 'predefined-cmap-unavailable']]);
    });

    it('reports a string whose font cannot be decoded as undecodable', () => {
      const objects = [...type0('131 0 R', 'Identity'), { number: 131, body: streamBody('/Type/CMap/Filter/Unknown', 'data') }];
      expect(textOf('BT /T 10 Tf <0041> Tj ET', objects)).toStrictEqual([[null, null, null, 'undecodable']]);
    });
  });

  describe('actual text', () => {
    it('records the span each glyph is shown in, and its text', () => {
      // 14.9.4: replacement text is given "through an ActualText entry in a property list attached to the marked-content sequence with a Span tag".
      const text = spans('BT /H 10 Tf /Span <</ActualText <FEFF5C71>>> BDC <2F2D> Tj EMC <0041> Tj ET');
      expect([text.actualText, text.glyphs.map(glyph => glyph.actualText)]).toStrictEqual([[{ text: '山', language: undefined, glyphs: [0] }], [0, undefined]]);
    });

    it('spans strings and forms shown inside the sequence, and reads property lists by name', () => {
      const form = { number: 120, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 500 500]/Resources<<${FONT_RESOURCES}>>`, 'BT /F1 10 Tf (B) Tj ET') };
      const text = spans(
        '/Span /P1 BDC BT /F1 10 Tf (A) Tj ET /X Do EMC',
        `${FONT_RESOURCES}/XObject<</X 120 0 R>>/Properties<</P1<</ActualText (AB)/Lang (en)>>>>`,
        [form],
      );
      expect(text.actualText).toStrictEqual([{ text: 'AB', language: 'en', glyphs: [0, 1] }]);
    });

    it('lets the outermost of nested spans replace the glyphs and keeps the inner ones', () => {
      const text = spans('BT /F1 10 Tf /Span <</ActualText (xy)>> BDC (A) Tj /Span <</ActualText (y)>> BDC (B) Tj EMC EMC ET');
      expect([text.actualText.map(span => [span.text, span.glyphs]), text.glyphs.map(glyph => glyph.actualText)]).toStrictEqual([
        [
          ['xy', [0, 1]],
          ['y', [1]],
        ],
        [0, 0],
      ]);
    });

    it('ignores ActualText on sequences with other tags', () => {
      const text = spans('BT /F1 10 Tf /P <</ActualText (x)>> BDC (A) Tj EMC ET');
      expect([text.actualText, text.glyphs.map(glyph => glyph.actualText)]).toStrictEqual([[], [undefined]]);
    });
  });

  describe('vertical writing', () => {
    // CID 65 is 1000 thousandths wide; Identity-V selects writing mode 1.
    it('places the glyph by its position vector and its vertical displacement with the default DW2', () => {
      // 9.7.4.3: without W2 the position vector is (w0 ÷ 2, DW2[0]) and w1 is DW2[1], by default [880 −1000]; 9.2.4: the text position is origin 1.
      expect(boxes(shownIn('BT /V 20 Tf 80 200 Td <00410041> Tj ET'))).toStrictEqual([
        [1, [80, 200], [0, -20], [70, 180, 90, 180, 90, 200, 70, 200]],
        [1, [80, 180], [0, -20], [70, 160, 90, 160, 90, 180, 70, 180]],
      ]);
    });

    it('reads W2 in both forms and a DW2 of the font', () => {
      // 9.7.4.3: each W2 group is "c [ w11y v1x v1y w12y v2x v2y … ]" or "cfirst clast w11y v1x v1y".
      expect(boxes(shownIn('BT /V 20 Tf 80 200 Td <0041> Tj ET', '/W2[65[-500 250 772]]'))).toStrictEqual([
        [1, [80, 200], [0, -10], [75, 190, 95, 190, 95, 200, 75, 200]],
      ]);
      expect(boxes(shownIn('BT /V 20 Tf 80 200 Td <0042> Tj ET', '/W2[65 70 -800 400 900]'))).toStrictEqual([
        [1, [80, 200], [0, -16], [72, 184, 92, 184, 92, 200, 72, 200]],
      ]);
      expect(boxes(shownIn('BT /V 20 Tf 80 200 Td <0041> Tj ET', '/DW2[900 -1100]'))).toStrictEqual([
        [1, [80, 200], [0, -22], [70, 178, 90, 178, 90, 200, 70, 200]],
      ]);
    });

    it('adds character spacing without horizontal scaling, which scales only the glyph', () => {
      // 9.4.4: ty = (w1 − Tj/1000) × Tfs + Tc + Tw; 9.3.4 scales Tc and Tw only "If the writing mode is horizontal".
      expect(boxes(shownIn('BT /V 20 Tf 50 Tz 2 Tc 80 200 Td <00410041> Tj ET'))).toStrictEqual([
        [1, [80, 200], [0, -18], [75, 180, 85, 180, 85, 200, 75, 200]],
        [1, [80, 182], [0, -18], [75, 162, 85, 162, 85, 182, 75, 182]],
      ]);
    });

    it('subtracts TJ numbers from the vertical coordinate', () => {
      // Table 109: the number is "subtracted from the current horizontal or vertical coordinate, depending on the writing mode", so −500 moves the next glyph up by 10.
      expect(origins(shownIn('BT /V 20 Tf 80 200 Td [<0041> -500 <0041>] TJ ET'))).toStrictEqual([
        [80, 200],
        [80, 190],
      ]);
    });
  });
});

import type { PageGlyph } from './extractText.ts';
import type { GlyphLayout } from './orderGlyphs.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { extractText } from './extractText.ts';
import { orderGlyphs } from './orderGlyphs.ts';

// F1 draws code 65 (A) 600 thousandths wide; H is Identity-H with CID 32 500 thousandths wide and every other CID 1000.
const OBJECTS = [
  { number: 101, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/FirstChar 65/LastChar 66/Widths[600 600]>>' },
  { number: 102, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[104 0 R]>>' },
  {
    number: 104,
    body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000/W[32[500]]/FontDescriptor 111 0 R>>',
  },
  {
    number: 111,
    body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontBBox[0 -120 1000 880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>',
  },
];

const glyphs = (content: string): ReadonlyArray<PageGlyph> =>
  extractText(loadDocument(textPdfBytes({ pages: [{ content, resources: '/Font<</F1 101 0 R/H 102 0 R>>' }], objects: OBJECTS })), 0).glyphs;

const indexes = (ordered: ReadonlyArray<PageGlyph>): Array<number> => ordered.map(glyph => glyph.index);

// A glyph whose advance box is the rectangle; orderGlyphs reads only the box and the index.
const boxed = (index: number, [left, bottom, right, top]: readonly [number, number, number, number]): PageGlyph => ({
  index,
  code: new Uint8Array([65]),
  cid: undefined,
  gid: undefined,
  font: '101.0',
  text: 'A',
  toUnicode: null,
  encodingText: 'A',
  reason: undefined,
  notdef: false,
  empty: false,
  actualText: undefined,
  writingMode: 0,
  origin: [left, bottom],
  advance: [right - left, 0],
  width: 1,
  quad: [left, bottom, right, bottom, right, top, left, top],
  fontSize: top - bottom,
  renderMode: 0,
  visible: true,
  invisibleBecause: undefined,
  fillAlpha: 1,
  strokeAlpha: 1,
  softMasked: false,
  covered: false,
  coreHidden: 'none',
  clip: 'inside',
  positionKnown: true,
  extentEstimated: false,
  source: { kind: 'page' },
  markedContent: [],
});

const LAYOUTS: ReadonlyArray<GlyphLayout> = ['content', 'rows', 'columns-rtl'];

describe('glyph order', () => {
  it('keeps content order', () => {
    const shown = glyphs('BT /F1 10 Tf 100 100 Td (AB) Tj ET BT /F1 10 Tf 100 200 Td (BA) Tj ET');
    expect(indexes(orderGlyphs(shown.toReversed(), 'content'))).toStrictEqual([0, 1, 2, 3]);
  });

  it('orders rows top to bottom and each row left to right', () => {
    const shown = glyphs('BT /F1 10 Tf 100 100 Td (AB) Tj ET BT /F1 10 Tf 200 200 Td (A) Tj -100 0 Td (B) Tj ET');
    expect(indexes(orderGlyphs(shown, 'rows'))).toStrictEqual([3, 2, 0, 1]);
  });

  it.each([
    // Glyph 0 spans 0 to 10 up the page and glyph 1, to its right, rises higher: sharing a row they read 0 1, in rows of their own 1 0.
    ['overlap by exactly half the smaller extent share a row', [5, 15], [0, 1]],
    ['overlap by just under half the smaller extent do not', [5.01, 15.01], [1, 0]],
  ] as const)('puts glyphs whose vertical extents %s', (_, [bottom, top], expected) => {
    expect(indexes(orderGlyphs([boxed(0, [0, 0, 10, 10]), boxed(1, [20, bottom, 30, top])], 'rows'))).toStrictEqual(expected);
  });

  it('orders columns right to left, each top to bottom, with glyphs that share a top left to right', () => {
    // Two columns of full-width glyphs, the right one ending in a pair of half-width glyphs side by side, drawn right first, as tate-chu-yoko is.
    const shown = glyphs(
      'BT /H 10 Tf 100 300 Td <0041> Tj 0 -10 Td <0041> Tj ET BT /H 10 Tf 120 300 Td <0041> Tj 0 -10 Td <0041> Tj 5 -10 Td <0020> Tj -5 0 Td <0020> Tj ET',
    );
    expect(indexes(orderGlyphs(shown, 'columns-rtl'))).toStrictEqual([2, 3, 5, 4, 0, 1]);
  });

  it.each([
    // Ruby set beside its base: half-width glyphs 5 wide beside a column 100 to 110 wide; in the base column the ruby shares the first glyph's top and follows it.
    ['less than half its width in a column of its own', 108.75, [2, 0, 1]],
    ['exactly half its width in the same column', 107.5, [0, 2, 1]],
  ] as const)('puts a narrower column that overlaps another by %s', (_, x, expected) => {
    const shown = glyphs(`BT /H 10 Tf 100 300 Td <0041> Tj 0 -10 Td <0041> Tj ET BT /H 10 Tf ${String(x)} 300 Td <0020> Tj ET`);
    expect(indexes(orderGlyphs(shown, 'columns-rtl'))).toStrictEqual(expected);
  });

  it('orders glyphs that tie in a row or a column by content order', () => {
    // In the row both start at x 0 and glyph 1 rises higher; in the column both share a top and a left edge and glyph 1 reaches further right.
    const row = [boxed(0, [0, 0, 10, 10]), boxed(1, [0, 1, 10, 11])];
    const column = [boxed(0, [0, 0, 10, 10]), boxed(1, [0, 0, 11, 10])];
    expect([indexes(orderGlyphs(row, 'rows')), indexes(orderGlyphs(column, 'columns-rtl'))]).toStrictEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it('takes glyphs that share a right edge into columns in content order, whatever order they are given in', () => {
    // Narrow glyph 2 shares wide glyph 1's right edge and overlaps glyph 0 by exactly half its own width, so it joins whichever of the two is grouped first; content order groups glyph 1 first, and glyph 2 tops that column.
    const [right, wide, narrow] = [boxed(0, [19, 0, 24, 10]), boxed(1, [0, 20, 20, 30]), boxed(2, [18, 40, 20, 50])];
    expect([indexes(orderGlyphs([right, wide, narrow], 'columns-rtl')), indexes(orderGlyphs([right, narrow, wide], 'columns-rtl'))]).toStrictEqual([
      [0, 2, 1],
      [0, 2, 1],
    ]);
  });

  it.each([
    // Glyph 0 lies left of glyph 1 and glyph 1's top is higher: tops closer than 0.01 count as one, so the left glyph comes first.
    ['0.009 apart share a top and read left to right', 100.009, [0, 1]],
    ['0.011 apart read top to bottom', 100.011, [1, 0]],
  ] as const)('reads glyphs in a column whose tops are %s', (_, top, expected) => {
    expect(indexes(orderGlyphs([boxed(0, [0, 90, 10, 100]), boxed(1, [2, 90, 12, top])], 'columns-rtl'))).toStrictEqual(expected);
  });
});

// Integer boxes, so that tops are equal or at least a point apart and comparing them is transitive; crowded boxes often share edges and tops.
const boxIn = (extent: number, size: number): fc.Arbitrary<readonly [number, number, number, number]> =>
  fc
    .tuple(fc.integer({ min: 0, max: extent }), fc.integer({ min: 0, max: extent }), fc.integer({ min: 1, max: size }), fc.integer({ min: 1, max: size }))
    .map(([left, bottom, width, height]) => [left, bottom, left + width, bottom + height] as const);

describe('properties', () => {
  const shuffled = fc
    .oneof(fc.array(boxIn(60, 12), { maxLength: 24 }), fc.array(boxIn(4, 3), { maxLength: 24 }))
    .map(boxes => boxes.map((rectangle, index) => boxed(index, rectangle)))
    .chain(placed => fc.tuple(fc.constant(placed), fc.shuffledSubarray(placed, { minLength: placed.length, maxLength: placed.length })));
  const layout = fc.constantFrom(...LAYOUTS);

  it('orders every glyph once, whatever order they are given in', () => {
    fc.assert(
      fc.property(shuffled, layout, ([placed, permuted], chosen) => {
        const ordered = indexes(orderGlyphs(placed, chosen));
        expect([ordered.toSorted((a, b) => a - b), indexes(orderGlyphs(permuted, chosen))]).toStrictEqual([indexes(placed), ordered]);
      }),
    );
  });
});

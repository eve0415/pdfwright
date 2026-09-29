import type { PageGlyph } from './extractText.ts';

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

const glyphs = (content: string): readonly PageGlyph[] =>
  extractText(loadDocument(textPdfBytes({ pages: [{ content, resources: '/Font<</F1 101 0 R/H 102 0 R>>' }], objects: OBJECTS })), 0).glyphs;

const indexes = (ordered: readonly PageGlyph[]): number[] => ordered.map(glyph => glyph.index);

describe('glyph order', () => {
  it('keeps content order', () => {
    const shown = glyphs('BT /F1 10 Tf 100 100 Td (AB) Tj ET BT /F1 10 Tf 100 200 Td (BA) Tj ET');
    expect(indexes(orderGlyphs(shown, 'content'))).toStrictEqual([0, 1, 2, 3]);
  });

  it('orders rows top to bottom and each row left to right', () => {
    const shown = glyphs('BT /F1 10 Tf 100 100 Td (AB) Tj ET BT /F1 10 Tf 200 200 Td (A) Tj -100 0 Td (B) Tj ET');
    expect(indexes(orderGlyphs(shown, 'rows'))).toStrictEqual([3, 2, 0, 1]);
  });

  it('orders columns right to left, each top to bottom, with glyphs that share a top left to right', () => {
    // Two columns of full-width glyphs, the right one ending in a pair of half-width glyphs side by side, drawn right first, as tate-chu-yoko is.
    const shown = glyphs(
      'BT /H 10 Tf 100 300 Td <0041> Tj 0 -10 Td <0041> Tj ET BT /H 10 Tf 120 300 Td <0041> Tj 0 -10 Td <0041> Tj 5 -10 Td <0020> Tj -5 0 Td <0020> Tj ET',
    );
    expect(indexes(orderGlyphs(shown, 'columns-rtl'))).toStrictEqual([2, 3, 5, 4, 0, 1]);
  });

  it('puts a narrower column that overlaps another by less than half its width in a column of its own', () => {
    // Ruby set beside its base: half-width glyphs whose column overlaps the base column by a quarter of their width.
    const shown = glyphs('BT /H 10 Tf 100 300 Td <0041> Tj 0 -10 Td <0041> Tj ET BT /H 10 Tf 108.75 300 Td <0020> Tj ET');
    expect(indexes(orderGlyphs(shown, 'columns-rtl'))).toStrictEqual([2, 0, 1]);
  });
});

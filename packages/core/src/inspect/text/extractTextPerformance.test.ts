import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { extractText } from './extractText.ts';

// Generous bounds: they catch work that grows out of proportion, not a slow machine.
const TIME_LIMIT_MS = 30_000;

// An Identity-H font whose every glyph is 1000 thousandths wide, with descent −120 and ascent 880.
const OBJECTS = [
  { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[106 0 R]>>' },
  {
    number: 106,
    body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000/FontDescriptor 111 0 R>>',
  },
  {
    number: 111,
    body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontBBox[0 -120 1000 880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>',
  },
];

const elapsed = (work: () => void): number => {
  const start = performance.now();
  work();
  return performance.now() - start;
};

// Shows `count` one-point glyphs in a line from (10, 700), then paints `after`.
const extractLine = (count: number, after: string): readonly boolean[] => {
  const content = [`BT /T 1 Tf 10 700 Td <${'0001'.repeat(count)}> Tj ET`, after];
  const bytes = textPdfBytes({ pages: [{ content, resources: '/Font<</T 105 0 R>>' }], objects: OBJECTS });
  return extractText(loadDocument(bytes), 0).glyphs.map(glyph => glyph.covered);
};

describe('text extraction cost', () => {
  it('tests 40,000 glyphs against 40,000 later rectangles in time close to that of the glyphs alone', async ({ annotate }) => {
    const count = 40_000;
    const unfilled = Array.from({ length: count }, (_, index) => `${String(10 + index)} 699 1 2 re n`).join('\n');
    const filled = Array.from({ length: count }, (_, index) => `${String(10 + index)} 699 1 2 re f`).join('\n');
    const apart = '500 10 1 1 re f\n'.repeat(count);
    let results: (readonly boolean[])[] = [];
    const base = elapsed(() => {
      results.push(extractLine(count, unfilled));
    });
    const time = elapsed(() => {
      results = [...results, extractLine(count, `1 g ${filled}`), extractLine(count, `1 g ${apart}`)];
    });
    await annotate(`40,000 glyphs alone in ${base.toFixed(0)} ms, twice with 40,000 fills in ${time.toFixed(0)} ms`);
    expect([results.map(covered => [covered.length, covered.filter(Boolean).length]), time < 10 * base + 1000, time < TIME_LIMIT_MS]).toStrictEqual([
      [
        [count, 0],
        [count, count],
        [count, 0],
      ],
      true,
      true,
    ]);
  });
});

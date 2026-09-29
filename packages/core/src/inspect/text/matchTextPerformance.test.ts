import type { PageText } from './extractText.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { streamBody } from '../../testing/pdfBuilder.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { extractText } from './extractText.ts';
import { matchText } from './matchText.ts';

// Generous bounds: they catch work that grows out of proportion, not a slow machine.
const TIME_LIMIT_MS = 30_000;

// An Identity-H font whose code 1 is 山, every glyph 1000 thousandths wide.
const OBJECTS = [
  { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[106 0 R]/ToUnicode 107 0 R>>' },
  {
    number: 106,
    body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000/FontDescriptor 111 0 R>>',
  },
  { number: 107, body: streamBody('', 'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0001> <5C71> endbfchar endcmap') },
  {
    number: 111,
    body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontBBox[0 -120 1000 880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>',
  },
];

const pageOf = (content: string): PageText =>
  extractText(loadDocument(textPdfBytes({ pages: [{ content, resources: '/Font<</T 105 0 R>>' }], objects: OBJECTS })), 0);

const elapsed = (work: () => void): number => {
  const start = performance.now();
  work();
  return performance.now() - start;
};

describe('text matching cost', () => {
  it(
    'compares 200,000 glyphs in one ActualText span in time close to that of the glyphs alone',
    async ({ annotate }) => {
      const count = 200_000;
      const shown = `<${'0001'.repeat(count)}> Tj`;
      const plain = pageOf(`BT /T 0.001 Tf 100 700 Td ${shown} ET`);
      const spanned = pageOf(`BT /T 0.001 Tf 100 700 Td /Span <</ActualText <FEFF0078>>> BDC ${shown} EMC ET`);
      const intended = '山'.repeat(count);
      const results: string[] = [];
      const base = elapsed(() => {
        results.push(matchText(plain, intended, { select: () => true }).status);
      });
      const time = elapsed(() => {
        results.push(matchText(spanned, intended, { select: () => true }).status);
      });
      await annotate(`200,000 glyphs in ${base.toFixed(0)} ms, in one span in ${time.toFixed(0)} ms`);
      expect([results, time < 10 * base + 1000, time < TIME_LIMIT_MS]).toStrictEqual([['match', 'unverified'], true, true]);
    },
    TIME_LIMIT_MS,
  );
});

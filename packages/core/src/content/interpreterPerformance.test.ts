import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { streamBody } from '../testing/pdfBuilder.ts';
import { textPdf } from '../testing/textPdf.ts';

import { interpretPage } from './interpreter.ts';

// Generous bounds: they catch work that grows out of proportion, not a slow machine.
const TIME_LIMIT_MS = 30_000;

const HELVETICA = { number: 100, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>' };

const elapsed = (work: () => void): number => {
  const start = performance.now();
  work();
  return performance.now() - start;
};

describe('content interpretation cost', () => {
  it('shows 100,000 glyphs in 1,000 text objects', async ({ annotate }) => {
    const line = 'A'.repeat(100);
    const blocks = Array.from({ length: 1000 }, (_, index) => `BT /F1 1 Tf 10 ${String(index % 800)} Td (${line}) Tj ET`).join('\n');
    const document = textPdf({ pages: [{ content: blocks, resources: '/Font<</F1 100 0 R>>' }], objects: [HELVETICA] });
    let glyphs = 0;
    const time = elapsed(() => {
      interpretPage(document, 0, {
        text: event => {
          glyphs += event.glyphs.length;
        },
      });
    });
    await annotate(`100,000 glyphs in ${time.toFixed(0)} ms`);
    expect([glyphs, time < TIME_LIMIT_MS]).toStrictEqual([100_000, true]);
  });

  it('draws a form 10,000 times, counting its operations each time against maxOperations', async ({ annotate }) => {
    const document = textPdf({
      pages: [{ content: '/Fm1 Do\n'.repeat(10_000), resources: '/XObject<</Fm1 101 0 R>>' }],
      objects: [{ number: 101, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '0 g 0 0 1 1 re f') }],
    });
    let operations = 0;
    const time = elapsed(() => {
      ({ operations } = interpretPage(document, 0));
    });
    await annotate(`10,000 form executions, ${String(operations)} operations, in ${time.toFixed(0)} ms`);
    expect([operations, time < TIME_LIMIT_MS]).toStrictEqual([40_000, true]);
    expect(() => interpretPage(document, 0, { maxOperations: 39_999 })).toThrow(ResourceLimitError);
  });
});

import type { ContentBuilder, GraphicsStateOptions } from './contentBuilder.ts';
import type { PdfDocument } from './pdfDocument.ts';

import { describe, expect, it } from 'vitest';

import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';
import { pdfDictionary, pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { cmyk } from './color.ts';
import { loadDocument } from './loadDocument.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';
import { graphicsStateDictionary } from './resourceRecord.ts';

interface DrawnPage {
  /** The names in each resource category of the page, sorted. */
  readonly names: ReadonlyMap<string, Array<string>>;
  /** The content streams, in Contents order. */
  readonly content: Array<string>;
}

type Draw = (content: ContentBuilder) => void;

// Draws one page in separate content streams, saves and reloads it, and reads back its resource names and its content streams.
const drawPage = (document: PdfDocument, draws: ReadonlyArray<Draw>): DrawnPage => {
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
  for (const draw of draws) {
    page.draw(draw);
  }
  const loaded = loadDocument(document.save().toBytes());
  const names = new Map<string, Array<string>>();
  for (const [key, value] of loaded.page(0).resources().entries()) {
    names.set(latin1Text(key), value.kind === 'dictionary' ? [...value.entries.entries()].map(([name]) => latin1Text(name)).toSorted() : []);
  }
  const pageObject = loaded.get(loaded.page(0).reference);
  const contents = pageObject.kind === 'dictionary' ? pageObject.entries.get(pdfName('Contents').bytes) : undefined;
  const content = (contents?.kind === 'array' ? contents.items : [contents]).map(reference => {
    const stream = reference?.kind === 'reference' ? loaded.get(reference) : undefined;
    return stream?.kind === 'stream' ? latin1Text(inflateZlib(stream.data).data) : '';
  });
  return { names, content };
};

describe('content resources', () => {
  // ISO 32000-1:2008, 8.4.5, Table 58: CA and ca are the stroke and fill alpha, BM the blend mode, OP and op the stroke and fill overprint, OPM the overprint mode, and SMask /None no soft mask.
  it.each([
    {
      options: 'every option',
      state: { strokeAlpha: 0.25, fillAlpha: 0.75, blendMode: 'Multiply', overprintStroke: true, overprintFill: false, overprintMode: 1, softMask: 'None' },
      written: '<</CA 0.25/ca 0.75/BM/Multiply/OP true/op false/OPM 1/SMask/None>>',
    },
    { options: 'stroke overprint alone', state: { overprintStroke: true }, written: '<</OP true>>' },
    { options: 'fill overprint alone', state: { overprintFill: true }, written: '<</op true>>' },
    { options: 'stroke alpha alone', state: { strokeAlpha: 0.5 }, written: '<</CA 0.5>>' },
    { options: 'fill alpha alone', state: { fillAlpha: 0.5 }, written: '<</ca 0.5>>' },
  ] as const satisfies Array<{ options: string; state: GraphicsStateOptions; written: string }>)(
    'writes the ExtGState keys for $options',
    ({ state, written }) => {
      expect(latin1Text(serializeObject(pdfDictionary(graphicsStateDictionary(state)), { fractionDigits: 5 }))).toBe(written);
    },
  );

  // Each draw builds its own content stream, so the names a page shares across streams come from the page's resource record.
  it('names equal graphics states once across the content streams of a page and different ones apart', () => {
    const page = drawPage(createDocument(), [
      content => {
        content.graphicsState({ fillAlpha: 0.5 });
      },
      content => {
        content.graphicsState({ fillAlpha: 0.5 });
        content.graphicsState({ fillAlpha: 0.5, strokeAlpha: 0.5 });
      },
    ]);
    expect([page.names.get('ExtGState'), page.content.map(stream => stream.match(/\/GS\d+ gs/gu))]).toStrictEqual([
      ['GS1', 'GS2'],
      [['/GS1 gs'], ['/GS1 gs', '/GS2 gs']],
    ]);
  });

  it('names a separation once across the content streams of a page, for fill and stroke', () => {
    const document = createDocument();
    const spot = document.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 1) });
    const other = document.separation({ name: 'Other', alternate: cmyk(0, 0, 0, 1) });
    const page = drawPage(document, [
      content => {
        content.fillColor(spot, 1);
      },
      content => {
        content.strokeColor(spot, 1);
        content.strokeColor(other, 1);
      },
    ]);
    expect([page.names.get('ColorSpace'), page.content.map(stream => stream.match(/\/CS\d+ (?:cs|CS)/gu))]).toStrictEqual([
      ['CS1', 'CS2'],
      [['/CS1 cs'], ['/CS1 CS', '/CS2 CS']],
    ]);
  });
});

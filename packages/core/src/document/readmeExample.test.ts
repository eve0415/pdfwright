import type { PdfObject } from '../object/pdfObject.ts';
import type { LoadedDocument } from './loadDocument.ts';

import { describe, expect, it } from 'vitest';

import { inflateZlib } from '../flate/inflate.ts';
import { listColorants } from '../inspect/colorants/listColorants.ts';
import { formatLength, mm } from '../length/length.ts';
import { pdfName } from '../object/pdfObject.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';
import { writePrintPage } from './readmeExample.ts';

const corners = (values: ReadonlyArray<number>): Array<number> => values.map(value => Number(formatLength(mm(value), 5)));

const pageContent = (document: LoadedDocument): string => {
  const page = document.get(document.page(0).reference);
  const contents = page.kind === 'dictionary' ? page.entries.get(pdfName('Contents').bytes) : undefined;
  const stream = contents?.kind === 'reference' ? document.get(contents) : undefined;
  if (stream?.kind !== 'stream') {
    throw new Error('expected one content stream');
  }
  return latin1Text(inflateZlib(stream.data).data);
};

// The colorant of the Separation colour space a page resource name stands for (ISO 32000-1:2008, 8.6.6.4).
const colorantOf = (document: LoadedDocument, name: string | undefined): string | undefined => {
  const spaces: PdfObject | undefined = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  const space = spaces?.kind === 'dictionary' && name !== undefined ? spaces.entries.get(pdfName(name).bytes) : undefined;
  const colorant = space?.kind === 'array' ? space.items[1] : undefined;
  return colorant?.kind === 'name' ? latin1Text(colorant.bytes) : undefined;
};

describe('readme print page', () => {
  it('writes a spot fill, cut path, and print boxes', () => {
    const document = loadDocument(writePrintPage().toBytes());
    expect(document.page(0).boxes()).toMatchObject({
      MediaBox: { rect: corners([0, 0, 100, 60]), explicit: true },
      BleedBox: { rect: corners([2, 2, 98, 58]), explicit: true },
      TrimBox: { rect: corners([5, 5, 95, 55]), explicit: true },
    });
    expect(listColorants(document).map(page => page.colorants.map(colorant => [latin1Text(colorant.name), colorant.painted]))).toStrictEqual([
      [
        ['Cut', ['stroke']],
        ['White', ['fill']],
      ],
    ]);
    const content = pageContent(document);
    // ISO 32000-1:2008, 8.6.8, Table 74 sets the fill colour space with cs and the stroke one with CS; 8.5.3.1, Table 60 fills with f and strokes with S; 8.4.3.2 makes a 0 line width the thinnest line a device can render.
    const fill = /\/(\w+) cs\n1 scn\n[^\n]+ re\nf\n/u.exec(content);
    const stroke = /\/(\w+) CS\n1 SCN\n0 w\n[^\n]+ re\nS\n/u.exec(content);
    expect([colorantOf(document, fill?.[1]), colorantOf(document, stroke?.[1])]).toStrictEqual(['White', 'Cut']);
  });
});

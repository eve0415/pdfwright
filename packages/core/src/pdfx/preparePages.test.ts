import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';
import { pdfName } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { preparePdfX4Pages } from './preparePages.ts';

const source = () =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>/Contents 5 0 R>>' },
        {
          number: 4,
          body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</ExtGState<</GS1 7 0 R>>>>/Contents 6 0 R>>',
        },
        { number: 5, body: streamBody('', '0 0 0 1 k') },
        { number: 6, body: streamBody('', '/GS1 gs 0 0 10 10 re f') },
        { number: 7, body: '<</Type/ExtGState/ca 0.5>>' },
      ],
      trailer: '/Root 1 0 R',
    },
  ]);

const pageGroup = (document: ReturnType<typeof loadDocument>, index: number) => {
  const page = document.get(document.page(index).reference);
  if (page.kind !== 'dictionary') throw new Error('page is not a dictionary');
  const group = page.entries.get(pdfName('Group').bytes);
  if (group?.kind !== 'dictionary') throw new Error('group is not a dictionary');
  return group.entries;
};

const hasGroup = (document: ReturnType<typeof loadDocument>, index: number): boolean => {
  const page = document.get(document.page(index).reference);
  return page.kind === 'dictionary' && page.entries.has(pdfName('Group').bytes);
};

describe('pdfx page preparation', () => {
  it('adds MediaBox-sized TrimBoxes and an isolated CMYK group only to the transparent page', () => {
    const document = loadDocument(source().bytes);
    const result = preparePdfX4Pages(document);
    expect(result.addedTrimBoxes).toStrictEqual([0, 1]);
    expect(result.addedPageGroups).toStrictEqual([1]);
    expect(document.page(0).boxes().TrimBox.rect).toStrictEqual([0, 0, 100, 100]);
    expect(document.page(1).boxes().TrimBox.rect).toStrictEqual([0, 0, 200, 100]);
    expect([document.page(0).boxes().TrimBox.explicit]).toStrictEqual([true]);
  });

  it('writes the group dictionary and leaves a second preparation unchanged', () => {
    const document = loadDocument(source().bytes);
    preparePdfX4Pages(document);
    const group = pageGroup(document, 1);
    expect([hasGroup(document, 0)]).toStrictEqual([false]);
    expect(group.get(pdfName('CS').bytes)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(group.get(pdfName('I').bytes)).toStrictEqual({ kind: 'boolean', value: true });
    expect(preparePdfX4Pages(document)).toStrictEqual({ addedTrimBoxes: [], addedPageGroups: [] });
  });

  it('offers a refusal policy for pages without either print-area box', () => {
    const document = loadDocument(source().bytes);
    expect(() => preparePdfX4Pages(document, { pageBoxes: 'refuse' })).toThrow(expect.objectContaining({ constructor: ValidationError }));
    expect([document.page(0).boxes().TrimBox.explicit]).toStrictEqual([false]);
  });

  it('preserves an ArtBox without adding a competing TrimBox', () => {
    const document = loadDocument(source().bytes);
    document.page(0).setBox('ArtBox', [pt(0), pt(0), pt(90), pt(90)]);
    expect(preparePdfX4Pages(document).addedTrimBoxes).toStrictEqual([1]);
    expect([document.page(0).boxes().TrimBox.explicit]).toStrictEqual([false]);
  });
});

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { pdfReference } from '../object/pdfObject.ts';

import { latin1Text } from './pdfBuilder.ts';
import { textPdf, textPdfBytes } from './textPdf.ts';

describe('text PDFs', () => {
  it('numbers the catalog 1, the page tree 2, and each page before its content streams', () => {
    const text = latin1Text(textPdfBytes({ pages: [{ content: ['BT ET', 'q Q'] }, { content: 'n' }, {}], objects: [{ number: 100, body: '(extra)' }] }));
    const headers = [...text.matchAll(/^(\d+) 0 obj\n(.*)$/gmu)].map(match => [Number(match[1]), match[2]]);
    expect(headers.toSorted(([left], [right]) => Number(left) - Number(right))).toStrictEqual([
      [1, '<</Type/Catalog/Pages 2 0 R>>'],
      [2, '<</Type/Pages/Kids[3 0 R 6 0 R 8 0 R]/Count 3>>'],
      [3, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]/Contents[4 0 R 5 0 R]>>'],
      [4, '<</Length 5>>'],
      [5, '<</Length 3>>'],
      [6, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]/Contents[7 0 R]>>'],
      [7, '<</Length 1>>'],
      [8, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]>>'],
      [100, '(extra)'],
    ]);
  });

  it('writes the page, root and catalog entries it is given and loads intact', () => {
    const bytes = textPdfBytes({ pages: [{ content: 'n', resources: '/Font<<>>', entries: '/Rotate 90' }], root: '/Resources<<>>', catalog: '/Lang(en)' });
    const text = latin1Text(bytes);
    expect([
      text.includes('/Contents[4 0 R]/Resources<</Font<<>>>>/Rotate 90>>'),
      text.includes('/Count 1/Resources<<>>>>'),
      text.includes('/Pages 2 0 R/Lang(en)>>'),
    ]).toStrictEqual([true, true, true]);
    const document = loadDocument(bytes);
    expect([document.structure.status, document.pageCount, document.get(pdfReference(3, 0)).kind]).toStrictEqual(['intact', 1, 'dictionary']);
    expect(textPdf({ pages: [{}, {}] }).pages).toHaveLength(2);
  });

  it.each([
    ['the catalog', 1],
    ['the page tree', 2],
    ['the first page', 3],
    ['a content stream', 5],
    ['the last page', 6],
  ])('refuses an object numbered like %s', (_, number) => {
    expect(() => textPdfBytes({ pages: [{ content: ['a', 'b'] }, {}], objects: [{ number, body: 'null' }] })).toThrow(RangeError);
  });

  it('accepts the first free number and refuses one object number given twice', () => {
    expect(latin1Text(textPdfBytes({ pages: [{ content: ['a', 'b'] }, {}], objects: [{ number: 7, body: '(seven)' }] }))).toContain('7 0 obj\n(seven)\nendobj');
    expect(() =>
      textPdfBytes({
        pages: [{}],
        objects: [
          { number: 100, body: '(a)' },
          { number: 100, body: '(b)' },
        ],
      }),
    ).toThrow(RangeError);
  });
});

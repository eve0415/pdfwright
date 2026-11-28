import { describe, expect, it } from 'vitest';

import { buildPdf, latin1Bytes } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';
import { versionNumber } from './readStructure.ts';

const pdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

describe('cross-reference structure', () => {
  it.each([
    { file: 'ends with %%EOF', bytes: pdf.bytes, status: 'intact', warnings: [] },
    { file: 'has no %%EOF after startxref', bytes: latin1Bytes(pdf.text.replace(/%%EOF\n$/u, '')), status: 'tolerated', warnings: ['missing-eof'] },
  ])('reads a file that $file', ({ bytes, status, warnings }) => {
    // ISO 32000-1:2008, 7.5.5: the last line of the file shall contain only the end-of-file marker, %%EOF.
    const document = loadDocument(bytes);
    expect([document.structure.status, document.warnings.map(warning => warning.code)]).toStrictEqual([status, warnings]);
  });

  it.each([
    { text: '1.7', number: 17 },
    { text: '2.0', number: 20 },
    { text: 'abc', number: 0 },
    { text: '1.', number: 0 },
    { text: '1.7.1', number: 0 },
  ])('reads version $text as $number', ({ text, number }) => {
    expect(versionNumber(text)).toBe(number);
  });
});

import { describe, expect, it, vi } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB2014.icc?icc-bytes';
import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { convertToCmyk } from './convertToCmyk.ts';
import { convertImageRow } from './imageRows.ts';

vi.mock(import('./imageRows.ts'), { spy: true });

// A page with a form and a three-row RGB inline image.
const page = (): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      trailer: '/Root 1 0 R',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</XObject<</Fm 5 0 R>>>>/Contents 4 0 R>>' },
        { number: 4, body: streamBody('', `BI /W 1 /H 3 /BPC 8 /CS /RGB ID ${String.fromCodePoint(255, 0, 0, 0, 255, 0, 0, 0, 255)} EI /Fm Do`) },
        { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0 0 10 10 re f') },
      ],
    },
  ]).bytes;

describe('form discovery', () => {
  it('converts each row of an inline image on a page with forms once', () => {
    const document = loadDocument(page());
    vi.mocked(convertImageRow).mockClear();
    convertToCmyk(document, { sourceRgbProfile: srgbBytes, outputProfile: fograBytes, outputIntent: { outputConditionIdentifier: 'FOGRA28' } });
    expect(vi.mocked(convertImageRow)).toHaveBeenCalledTimes(3);
  });
});

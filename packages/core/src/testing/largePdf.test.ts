import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';

import { largeFile } from './largePdf.ts';
import { latin1Text } from './pdfBuilder.ts';

describe('large print-like files', () => {
  it('writes one page per requested page, each placing an image of the requested size, and loads intact', () => {
    const bytes = largeFile(3, 1000);
    const document = loadDocument(bytes);
    expect([document.structure.status, document.warnings, document.pageCount]).toStrictEqual(['intact', [], 3]);
    const text = latin1Text(bytes);
    expect(
      [...text.matchAll(/\/Width 1000\/Height 1\/ColorSpace\/DeviceGray\/BitsPerComponent 8\/Length 1000>>\nstream\n(\u0080+)\nendstream/gu)].map(
        match => match[1]?.length,
      ),
    ).toStrictEqual([1000, 1000, 1000]);
  });
});

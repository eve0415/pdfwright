import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';

import { writeDocument } from './writeDocument.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const sample = (fileIdentifier?: [Uint8Array, Uint8Array]): Uint8Array => {
  const catalog = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('Catalog')],
    [pdfName('Pages').bytes, pdfReference(2, 0)],
  ]);
  const pages = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('Pages')],
    [pdfName('Count').bytes, pdfInteger(0)],
    [pdfName('Kids').bytes, pdfArray([])],
  ]);
  const trailer = new PdfDictionaryEntries([[pdfName('Root').bytes, pdfReference(1, 0)]]);
  return writeDocument(
    [
      { objectNumber: 1, generation: 0, value: pdfDictionary(catalog) },
      { objectNumber: 2, generation: 0, value: pdfDictionary(pages) },
    ],
    trailer,
    { fractionDigits: 5, version: '1.7', fileIdentifier },
  );
};

describe('classic PDF writer', () => {
  it('points each twenty-byte xref entry at its indirect object', () => {
    const bytes = sample();
    const text = ascii(bytes);
    const xrefOffset = Number(/startxref\n(\d+)/u.exec(text)?.[1]);
    expect(text.slice(xrefOffset, xrefOffset + 9)).toBe('xref\n0 3\n');
    const xref = text.slice(xrefOffset).split('\n');
    for (let index = 2; index <= 4; index++) expect(xref[index]).toHaveLength(19);
    expect(`${xref[2]}\n`).toBe('0000000000 65535 f \n');
    for (let objectNumber = 1; objectNumber <= 2; objectNumber++) {
      const offset = Number(xref[objectNumber + 2]?.slice(0, 10));
      expect(text.slice(offset)).toMatch(new RegExp(`^${objectNumber} 0 obj`, 'u'));
    }
  });

  it('writes the binary marker and uses caller-supplied file IDs verbatim', () => {
    const first = new Uint8Array(16).fill(0x11);
    const second = new Uint8Array(16).fill(0x22);
    const bytes = sample([first, second]);
    expect(bytes.subarray(0, 9)).toStrictEqual(new TextEncoder().encode('%PDF-1.7\n'));
    expect([[...bytes.subarray(10, 14)].every(byte => byte >= 0x80)]).toStrictEqual([true]);
    expect(ascii(bytes)).toContain(`/ID[<${'11'.repeat(16)}> <${'22'.repeat(16)}>]`);
  });

  it('rejects gaps in a first xref section', () => {
    const trailer = new PdfDictionaryEntries([[pdfName('Root').bytes, pdfReference(2, 0)]]);
    const object = { objectNumber: 2, generation: 0, value: pdfDictionary() };
    expect(() => writeDocument([object], trailer, { fractionDigits: 5, version: '1.7' })).toThrow(InvalidArgumentError);
  });
});

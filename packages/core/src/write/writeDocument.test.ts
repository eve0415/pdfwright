import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { md5 } from '../hash/md5.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference, pdfString } from '../object/pdfObject.ts';

import { writeDocument } from './writeDocument.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);
const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
const HEADER = '%PDF-1.7\n%\u00E2\u00E3\u00CF\u00D3\n';

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
    { fractionDigits: 5, fileIdentifier },
  ).toBytes();
};

describe('classic PDF writer', () => {
  it('exposes ordered chunks to a stream without joining them', async () => {
    const trailer = new PdfDictionaryEntries([[pdfName('Root').bytes, pdfReference(1, 0)]]);
    const saved = writeDocument([{ objectNumber: 1, generation: 0, value: pdfDictionary() }], trailer, { fractionDigits: 5 });
    expect(saved.chunks.length).toBe(3);
    expect(saved.byteLength).toBe(saved.toBytes().length);
    const chunks: Array<Uint8Array> = [];
    for await (const chunk of saved.toStream()) {
      chunks.push(chunk);
    }
    expect(chunks).toStrictEqual(saved.chunks);
    expect(chunks[0]).toBe(saved.chunks[0]);
  });

  it('points each twenty-byte xref entry at its indirect object', () => {
    const bytes = sample();
    const text = ascii(bytes);
    const xrefOffset = Number(/startxref\n(\d+)/u.exec(text)?.[1]);
    expect(text.slice(xrefOffset, xrefOffset + 9)).toBe('xref\n0 3\n');
    const xref = text.slice(xrefOffset).split('\n');
    for (let index = 2; index <= 4; index++) {
      expect(xref[index]).toHaveLength(19);
    }
    expect(xref[2]).toBe('0000000000 65535 f ');
    for (let objectNumber = 1; objectNumber <= 2; objectNumber++) {
      const offset = Number(xref[objectNumber + 2]?.slice(0, 10));
      expect(text.slice(offset)).toMatch(new RegExp(`^${String(objectNumber)} 0 obj`, 'u'));
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
    expect(() => writeDocument([object], trailer, { fractionDigits: 5 })).toThrow(InvalidArgumentError);
  });

  // ISO 32000-1:2008, 7.5.4: each xref entry is a 10-digit offset, a 5-digit generation and n or f, in 20 bytes; 7.5.5 gives the trailer and startxref.
  it('writes objects in number order with their generations, offsets and trailer', () => {
    const first = new Uint8Array(16).fill(0x11);
    const second = new Uint8Array(16).fill(0x22);
    const saved = writeDocument(
      [
        { objectNumber: 2, generation: 0, value: { kind: 'null' } },
        { objectNumber: 1, generation: 3, value: pdfInteger(7) },
      ],
      new PdfDictionaryEntries(),
      { fractionDigits: 5, fileIdentifier: [first, second] },
    );
    expect([saved.chunks.length, ascii(saved.toBytes())]).toStrictEqual([
      4,
      `${HEADER}1 3 obj\n7\nendobj\n2 0 obj\nnull\nendobj\nxref\n0 3\n0000000000 65535 f \n0000000015 00003 n \n0000000032 00000 n \ntrailer\n<</Size 3/ID[<${'11'.repeat(16)}> <${'22'.repeat(16)}>]>>\nstartxref\n52\n%%EOF\n`,
    ]);
  });

  it('writes an empty document with only the free entry', () => {
    const saved = writeDocument([], new PdfDictionaryEntries(), { fractionDigits: 5, fileIdentifier: [new Uint8Array(1), new Uint8Array(1)] });
    expect([saved.chunks.length, ascii(saved.toBytes())]).toStrictEqual([
      2,
      `${HEADER}xref\n0 1\n0000000000 65535 f \ntrailer\n<</Size 1/ID[<00> <00>]>>\nstartxref\n15\n%%EOF\n`,
    ]);
  });

  // ISO 32000-1:2008, 14.4 leaves the identifier calculation to the writer; this one hashes the body through the last endobj and the trailer without /ID.
  it('derives a default file identifier from the body and the trailer it writes, replacing a caller /ID and /Size', () => {
    const trailer = new PdfDictionaryEntries([
      [pdfName('Root').bytes, pdfReference(1, 0)],
      [pdfName('ID').bytes, pdfArray([pdfString(new Uint8Array(16).fill(0x33), 'hex'), pdfString(new Uint8Array(16).fill(0x33), 'hex')])],
      [pdfName('Size').bytes, pdfInteger(99)],
    ]);
    const text = ascii(writeDocument([{ objectNumber: 1, generation: 0, value: pdfDictionary() }], trailer, { fractionDigits: 5 }).toBytes());
    const body = text.slice(0, text.lastIndexOf('endobj\n') + 'endobj\n'.length);
    const identifier = hex(md5(latin1Bytes(`${body}<</Root 1 0 R/Size 2>>`)));
    expect(text.slice(body.length)).toBe(
      `xref\n0 2\n0000000000 65535 f \n0000000015 00000 n \ntrailer\n<</Root 1 0 R/Size 2/ID[<${identifier}> <${identifier}>]>>\nstartxref\n${String(body.length)}\n%%EOF\n`,
    );
  });

  // ISO 32000-1:2008, 7.5.4 gives generation numbers five digits, so the largest is 65535.
  it('accepts the largest generation', () => {
    const saved = writeDocument([{ objectNumber: 1, generation: 65_535, value: pdfInteger(1) }], new PdfDictionaryEntries(), { fractionDigits: 5 });
    expect(ascii(saved.toBytes())).toContain('0000000015 65535 n \n');
  });

  it.each([
    ['generation 65536', [{ objectNumber: 1, generation: 65_536 }]],
    ['generation -1', [{ objectNumber: 1, generation: -1 }]],
    ['generation 1.5', [{ objectNumber: 1, generation: 1.5 }]],
    [
      'a duplicate object number',
      [
        { objectNumber: 1, generation: 0 },
        { objectNumber: 1, generation: 0 },
      ],
    ],
    ['object number 0', [{ objectNumber: 0, generation: 0 }]],
  ])('rejects %s', (_, objects) => {
    const indirect = objects.map(object => ({ ...object, value: pdfInteger(1) }));
    expect(() => writeDocument(indirect, new PdfDictionaryEntries(), { fractionDigits: 5 })).toThrow(InvalidArgumentError);
  });
});

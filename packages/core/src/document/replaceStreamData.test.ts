import type { PdfObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';

const source = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
      { number: 3, body: streamBody('/Custom (kept)/Filter/ASCIIHexDecode/DecodeParms<</Columns 2>>', 'old') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const streamValue = (value: PdfObject): Extract<PdfObject, { kind: 'stream' }> => {
  if (value.kind !== 'stream') throw new Error('expected a stream object');
  return value;
};

describe('replacing decoded stream data', () => {
  it('keeps the object identity and unrelated dictionary entries through a save', () => {
    const document = loadDocument(source.bytes);
    const reference = pdfReference(3, 0);
    document.replaceStreamData(reference, latin1Bytes('new decoded content'), { filter: 'FlateDecode' });
    const changed = streamValue(document.get(reference));
    expect(changed.dictionary.get(pdfName('Custom').bytes)).toStrictEqual({ kind: 'string', bytes: latin1Bytes('kept'), encoding: 'literal' });
    expect(changed.dictionary.get(pdfName('Filter').bytes)).toStrictEqual(pdfName('FlateDecode'));
    expect(changed.dictionary.get(pdfName('DecodeParms').bytes)).toBeUndefined();
    expect(inflateZlib(changed.data).data).toStrictEqual(latin1Bytes('new decoded content'));
    const saved = loadDocument(document.save({ mode: 'full' }).toBytes()).get(reference);
    expect(saved).toStrictEqual(changed);
  });

  it('rejects a reference to a non-stream object', () => {
    const document = loadDocument(source.bytes);
    expect(() => {
      document.replaceStreamData(pdfReference(2, 0), latin1Bytes('data'), { filter: 'FlateDecode' });
    }).toThrow(InvalidArgumentError);
  });

  it('rejects decoded data above the document limit without changing the object', () => {
    const document = loadDocument(source.bytes, { maxDecodedBytes: 3 });
    const reference = pdfReference(3, 0);
    const before = document.get(reference);
    expect(() => {
      document.replaceStreamData(reference, latin1Bytes('four'), { filter: 'FlateDecode' });
    }).toThrow(ResourceLimitError);
    expect(document.get(reference)).toStrictEqual(before);
  });
});

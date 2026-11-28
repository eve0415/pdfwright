import type { PdfObject } from '../object/pdfObject.ts';

import fc from 'fast-check';
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
  if (value.kind !== 'stream') {
    throw new Error('expected a stream object');
  }
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

  it('accepts decoded data exactly at the document limit', () => {
    const document = loadDocument(source.bytes, { maxDecodedBytes: 3 });
    const reference = pdfReference(3, 0);
    document.replaceStreamData(reference, latin1Bytes('abc'), { filter: 'FlateDecode' });
    expect(inflateZlib(streamValue(document.get(reference)).data).data).toStrictEqual(latin1Bytes('abc'));
  });
});

// A limit, and data at it, one byte past it, or of any length up to one byte past it.
const limitAndData = fc.integer({ min: 1, max: 64 }).chain(limit =>
  fc.tuple(
    fc.constant(limit),
    fc
      .oneof(fc.constant(limit), fc.constant(limit + 1), fc.integer({ min: 0, max: limit + 1 }))
      .chain(length => fc.uint8Array({ minLength: length, maxLength: length })),
  ),
);

describe('properties', () => {
  it('saves and reloads any data up to the limit and refuses one byte more without changing the object', () => {
    fc.assert(
      fc.property(limitAndData, ([maxDecodedBytes, data]) => {
        const document = loadDocument(source.bytes, { maxDecodedBytes });
        const reference = pdfReference(3, 0);
        const before = document.get(reference);
        const replace = (): void => {
          document.replaceStreamData(reference, data, { filter: 'FlateDecode' });
        };
        const outcome = (): Uint8Array | 'refused' => {
          try {
            replace();
          } catch (error: unknown) {
            if (error instanceof ResourceLimitError) {
              return 'refused';
            }
            throw error;
          }
          return inflateZlib(streamValue(loadDocument(document.save({ mode: 'full' }).toBytes()).get(reference)).data).data;
        };
        const result = outcome();
        expect(result).toStrictEqual(data.length <= maxDecodedBytes ? data : 'refused');
        expect(result === 'refused' ? document.get(reference) : before).toStrictEqual(before);
      }),
    );
  });
});

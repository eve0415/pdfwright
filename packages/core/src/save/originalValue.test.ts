import type { ObjectStore } from '../document/objectStore.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { originalValue } from './originalValue.ts';

// Object 1 and stream 4 are top-level, 2 and 3 are members 0 and 1 of object stream 6, and 5 is free.
const source = (): string =>
  buildPdf([
    {
      xref: 'stream',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 4, body: streamBody('/Filter/None', 'data') },
      ],
      free: [{ number: 5, generation: 1 }],
      objectStreams: [
        {
          number: 6,
          members: [
            { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
            { number: 3, body: '[1  2.50]' },
          ],
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).text;

const storeOf = (text: string): ObjectStore => {
  const objects = internalsOf(loadDocument(latin1Bytes(text)))?.objects;
  if (objects === undefined) {
    throw new Error('missing document internals');
  }
  return objects.store;
};

// The bytes an original holds and the span its parsed value covers in them, which a merge copies from.
const spelled = (store: ObjectStore, objectNumber: number): readonly [string, string] | undefined => {
  const original = originalValue(store, objectNumber, 256);
  return original === undefined ? undefined : [latin1Text(original.bytes), latin1Text(original.bytes.subarray(original.node.start, original.node.end))];
};

describe('original values', () => {
  it('gives the source spelling of a top-level value, of a stream dictionary and of an object-stream member, and nothing for free or absent numbers', () => {
    const store = storeOf(source());
    expect([1, 4, 2, 3, 5, 99].map(objectNumber => spelled(store, objectNumber))).toStrictEqual([
      ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Catalog/Pages 2 0 R>>'],
      ['<</Filter/None/Length 4>>', '<</Filter/None/Length 4>>'],
      ['<</Type/Pages/Kids[]/Count 0>>', '<</Type/Pages/Kids[]/Count 0>>'],
      ['[1  2.50]', '[1  2.50]'],
      undefined,
      undefined,
    ]);
  });

  it('gives nothing for a compressed entry whose index lies beyond the members of its object stream', () => {
    // ISO 32000-1:2008, 7.5.8.3, Table 18: the third field of a type 2 entry is the index within the object stream; rows are W[1 4 2] for Index[0 8], so object 3 is the fourth row.
    const text = source();
    const rows = text.lastIndexOf('>>\nstream\n') + '>>\nstream\n'.length;
    const index = rows + 3 * 7 + 6;
    const patched = `${text.slice(0, index)}\u0005${text.slice(index + 1)}`;
    expect([text.codePointAt(index), spelled(storeOf(text), 3), spelled(storeOf(patched), 3)]).toStrictEqual([1, ['[1  2.50]', '[1  2.50]'], undefined]);
  });
});

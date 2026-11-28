import type { PdfDirectObject, PdfObject } from './pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cloneDirect, cloneObject, copyObject } from './cloneObject.ts';
import { deepEqual } from './deepEqual.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference, pdfString } from './pdfObject.ts';

// Every array, byte array and entry collection reachable from a value; a stream's data is left out, because cloneObject shares it by design.
const containers = (value: PdfObject): Array<object> => {
  if (value.kind === 'array') {
    return [value.items, ...value.items.flatMap(item => containers(item))];
  }
  if (value.kind === 'dictionary' || value.kind === 'stream') {
    const entries = value.kind === 'dictionary' ? value.entries : value.dictionary;
    return [entries, ...[...entries.entries()].flatMap(([, item]) => containers(item))];
  }
  if (value.kind === 'name' || value.kind === 'string' || value.kind === 'invalid') {
    return [value.bytes];
  }
  return [];
};

const shared = (left: PdfObject, right: PdfObject): Array<object> => {
  const seen = new Set(containers(left));
  return containers(right).filter(container => seen.has(container));
};

const nested = (): PdfDirectObject =>
  pdfArray([
    pdfName('N'),
    pdfString(Uint8Array.of(0x73)),
    pdfDictionary(
      new PdfDictionaryEntries([
        [pdfName('K').bytes, pdfArray([pdfInteger(1), { kind: 'invalid', bytes: Uint8Array.of(0x2d), reason: 'malformed-number' }])],
        [pdfName('L').bytes, pdfString(Uint8Array.of(0x0a), 'hex')],
      ]),
    ),
    pdfReference(1, 0),
  ]);

const streamOf = (data: Uint8Array): PdfObject => ({
  kind: 'stream',
  dictionary: new PdfDictionaryEntries([[pdfName('F').bytes, pdfArray([pdfInteger(1)])]]),
  data,
});

// Changes every array, byte array and entry collection in a value, so that a shared one shows up in the original.
const scribble = (value: PdfObject): void => {
  if (value.kind === 'array') {
    for (const item of value.items) {
      scribble(item);
    }
    value.items.push({ kind: 'null' });
  } else if (value.kind === 'dictionary' || value.kind === 'stream') {
    const entries = value.kind === 'dictionary' ? value.entries : value.dictionary;
    for (const [, item] of entries.entries()) {
      scribble(item);
    }
    entries.set(pdfName('Added').bytes, pdfInteger(9));
  } else if (value.kind === 'name' || value.kind === 'string' || value.kind === 'invalid') {
    value.bytes.fill(0x5a);
  }
};

describe('object copies', () => {
  it('clones a direct value equal to it and sharing nothing with it', () => {
    const original = nested();
    const clone = cloneDirect(original);
    expect([deepEqual(clone, original, 'strict'), shared(original, clone)]).toStrictEqual([true, []]);
    scribble(clone);
    expect(deepEqual(original, nested(), 'strict')).toBe(true);
  });

  it('shares stream data in cloneObject and copies it in copyObject', () => {
    const data = Uint8Array.of(1, 2, 3);
    const original = streamOf(data);
    const clone = cloneObject(original);
    const copy = copyObject(original);
    expect([deepEqual(clone, original, 'strict'), deepEqual(copy, original, 'strict'), shared(original, clone), shared(original, copy)]).toStrictEqual([
      true,
      true,
      [],
      [],
    ]);
    expect([clone.kind === 'stream' && clone.data === data, copy.kind === 'stream' && copy.data !== data]).toStrictEqual([true, true]);
    scribble(clone);
    expect(deepEqual(original, streamOf(Uint8Array.of(1, 2, 3)), 'strict')).toBe(true);
  });

  it('copies a value that is not a stream as cloneObject does', () => {
    const original = nested();
    const copy = copyObject(original);
    expect([copy, shared(original, copy)]).toStrictEqual([cloneObject(original), []]);
  });
});

describe('properties', () => {
  // ISO 32000-1:2008, 7.3.5: a name holds any bytes but null.
  const name = fc.uint8Array({ min: 1, minLength: 1, maxLength: 4 }).map(bytes => ({ kind: 'name', bytes }) as const);
  const { value } = fc.letrec<{ value: PdfDirectObject }>(tie => ({
    value: fc.oneof(
      { depthSize: 'small' },
      fc.constantFrom<PdfDirectObject>({ kind: 'null' }, { kind: 'boolean', value: true }, pdfReference(3, 1)),
      fc.integer({ min: -2_147_483_647, max: 2_147_483_647 }).map(number => pdfInteger(number)),
      fc.double({ noNaN: true, noDefaultInfinity: true }).map(number => ({ kind: 'real', value: number }) as const),
      name,
      fc.tuple(fc.uint8Array({ maxLength: 4 }), fc.constantFrom('literal' as const, 'hex' as const)).map(([bytes, encoding]) => pdfString(bytes, encoding)),
      fc.constant({ kind: 'invalid', bytes: Uint8Array.of(0x2d, 0x2d), reason: 'malformed-number' } as const),
      fc.array(tie('value'), { maxLength: 3 }).map(items => pdfArray(items)),
      fc
        .array(fc.tuple(name, tie('value')), { maxLength: 3 })
        .map(entries => pdfDictionary(new PdfDictionaryEntries(entries.map(([key, item]) => [key.bytes, item])))),
    ),
  }));
  const object = fc.oneof(
    value,
    fc
      .tuple(value, fc.uint8Array({ maxLength: 4 }))
      .map(([item, data]): PdfObject => ({ kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('K').bytes, item]]), data })),
  );

  it('clones a value strictly equal to it that shares no array with it', () => {
    fc.assert(
      fc.property(object, original => {
        const clone = cloneObject(original);
        expect([deepEqual(clone, original, 'strict'), shared(original, clone)]).toStrictEqual([true, []]);
      }),
    );
  });
});

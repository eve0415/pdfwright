import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { SaveHook } from './editedObjects.ts';
import type { LoadedDocument } from './loadDocument.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';
import { ObjectIndex } from '../xref/objectIndex.ts';

import { internalsOf } from './documentInternals.ts';
import { EditedObjects } from './editedObjects.ts';
import { keys } from './inspectSaved.ts';
import { loadDocument } from './loadDocument.ts';
import { ObjectStore } from './objectStore.ts';

const load = (): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<<>>>>' },
          { number: 5, generation: 2, body: '(five)' },
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

const dataOf = (value: PdfObject): Uint8Array => (value.kind === 'stream' ? value.data : new Uint8Array());

const entriesOf = (value: PdfObject): PdfDictionaryEntries => {
  if (value.kind !== 'dictionary') {
    throw new TypeError(`expected a dictionary, not a ${value.kind}`);
  }
  return value.entries;
};

const itemsOf = (value: PdfObject | undefined): Array<PdfDirectObject> => {
  if (value?.kind !== 'array') {
    throw new TypeError(`expected an array, not ${value === undefined ? 'nothing' : `a ${value.kind}`}`);
  }
  return value.items;
};

const editsOf = (document: LoadedDocument): EditedObjects => {
  const objects = internalsOf(document)?.objects;
  if (objects === undefined) {
    throw new TypeError('the document was not loaded by this library');
  }
  return objects;
};

const withObjectStream = (): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'stream',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }],
        objectStreams: [{ number: 5, members: [{ number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }] }],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

const name = (text: string): Uint8Array => pdfName(text).bytes;

const ref = (number: number, generation = 0): PdfReference => pdfReference(number, generation);

describe('object changes', () => {
  it('keeps a replaced object apart from the caller value, and shows it to page views and to every read as a separate copy', () => {
    const document = load();
    const reference = pdfReference(3, 0);
    const box = pdfArray([0, 0, 20, 30].map(value => pdfInteger(value)));
    const page = pdfDictionary(
      new PdfDictionaryEntries([
        [pdfName('Type').bytes, pdfName('Page')],
        [pdfName('MediaBox').bytes, box],
      ]),
    );
    document.set(reference, page);
    box.items[2] = pdfInteger(99);
    page.entries.delete(pdfName('MediaBox').bytes);
    const read = entriesOf(document.get(reference));
    itemsOf(read.get(pdfName('MediaBox').bytes))[3] = pdfInteger(99);
    read.delete(pdfName('MediaBox').bytes);
    expect([document.page(0).boxes().MediaBox.rect, keys(document.get(reference))]).toStrictEqual([
      [0, 0, 20, 30],
      ['Type', 'MediaBox'],
    ]);
  });

  it('reports the warnings of a source object once however often it is read', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
            { number: 3, body: '<</A 1/A 2>>' },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    document.get(pdfReference(3, 0));
    document.get(pdfReference(3, 0));
    expect(document.warnings.map(warning => warning.code)).toStrictEqual(['duplicate-key']);
  });

  it('refuses to delete or replace an object stream that holds objects', () => {
    const packed = loadDocument(
      buildPdf([
        {
          xref: 'stream',
          objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }],
          objectStreams: [{ number: 5, members: [{ number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }] }],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect(() => {
      packed.delete(pdfReference(5, 0));
    }).toThrow(InvalidArgumentError);
    expect(() => {
      packed.set(pdfReference(5, 0), pdfInteger(1));
    }).toThrow(InvalidArgumentError);
  });

  it('numbers new objects above the listed objects, not above a larger trailer Size', () => {
    const sized = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
          ],
          trailer: '/Root 1 0 R/Size 1000000',
        },
      ]).bytes,
    );
    expect(sized.object(pdfInteger(1))).toStrictEqual(pdfReference(3, 0));
  });

  it('hands out copies of the structure and of stream data', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
            { number: 3, body: '<</Length 3>>\nstream\nabc\nendstream' },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    document.structure.trailer.set(pdfName('Root').bytes, pdfInteger(42));
    dataOf(document.get(pdfReference(3, 0))).fill(0x78);
    expect([document.structure.trailer.get(pdfName('Root').bytes), document.get(pdfReference(3, 0))]).toMatchObject([
      pdfReference(1, 0),
      { data: new TextEncoder().encode('abc') },
    ]);
  });

  it('deletes objects and numbers new objects above every number in use', () => {
    const document = load();
    document.delete(pdfReference(5, 2));
    expect(document.get(pdfReference(5, 2))).toStrictEqual({ kind: 'null' });
    expect([document.object(pdfInteger(1)), document.object(pdfInteger(2))]).toStrictEqual([pdfReference(6, 0), pdfReference(7, 0)]);
    expect(document.get(pdfReference(7, 0))).toStrictEqual(pdfInteger(2));
  });

  it('refuses to change objects that are not in use or under another generation', () => {
    const document = load();
    expect(() => {
      document.set(pdfReference(4, 0), pdfInteger(1));
    }).toThrow(InvalidArgumentError);
    expect(() => {
      document.set(pdfReference(5, 0), pdfInteger(1));
    }).toThrow(InvalidArgumentError);
    document.delete(pdfReference(5, 2));
    expect(() => {
      document.delete(pdfReference(5, 2));
    }).toThrow(InvalidArgumentError);
  });

  it('reads a changed object only under its own generation', () => {
    const objects = editsOf(load());
    objects.set(ref(5, 2), pdfInteger(7));
    expect([objects.resolve(5, 2), objects.resolve(5, 0)]).toStrictEqual([pdfInteger(7), { kind: 'null' }]);
  });

  it('reports the generation of file objects, compressed members and deleted objects', () => {
    const plain = editsOf(load());
    const compressed = editsOf(withObjectStream());
    const before = [plain.generationOf(5), plain.generationOf(4), compressed.generationOf(2), compressed.generationOf(5)];
    compressed.delete(ref(2));
    expect([...before, compressed.generationOf(2)]).toStrictEqual([2, undefined, 0, 0, undefined]);
  });

  it('numbers the first new object 1 when the source lists no objects', () => {
    const context = {
      warn: (): void => undefined,
      names: new Map<string, Uint8Array>(),
      maxNesting: 256,
      maxDecodedBytes: 1024,
      maxObjectStreamMembers: 1000,
      generationMismatch: 'error',
      parsedObjectCacheBytes: 1024,
    } as const;
    const objects = new EditedObjects(new ObjectStore(new ByteSource(new Uint8Array()), ObjectIndex.fromEntries([]), context));
    expect([objects.add(pdfInteger(1)), objects.size]).toStrictEqual([ref(1), 2]);
  });
});

describe('trailer changes', () => {
  it.each(['Size', 'Prev', 'XRefStm', 'ID'])('refuses to set the trailer %s entry, which the save writes', key => {
    expect(() => {
      editsOf(load()).setTrailerEntry(name(key), pdfInteger(1));
    }).toThrow(InvalidArgumentError);
  });

  it('records copies in the order entries were last set, with undefined as a removal', () => {
    const objects = editsOf(load());
    const info = pdfDictionary(new PdfDictionaryEntries([[name('Title'), pdfInteger(1)]]));
    const key = name('Info');
    objects.setTrailerEntry(key, pdfInteger(0));
    objects.setTrailerEntry(name('Custom'), undefined);
    objects.setTrailerEntry(key, info);
    info.entries.set(name('Title'), pdfInteger(2));
    key.fill(0x58);
    expect(objects.trailerChanges).toStrictEqual([
      { key: name('Custom'), value: undefined },
      { key: name('Info'), value: pdfDictionary(new PdfDictionaryEntries([[name('Title'), pdfInteger(1)]])) },
    ]);
  });
});

describe('save requirements', () => {
  it('keeps the first reason a full rewrite is required', () => {
    const objects = editsOf(load());
    objects.requireFullRewrite('metadata-history');
    objects.requireFullRewrite('color-conversion');
    expect(objects.fullRewriteReason).toBe('metadata-history');
  });
});

const hook: SaveHook = () => undefined;

// Every kind of edit, made to the edits given.
const editAll = (objects: EditedObjects): void => {
  objects.set(ref(5, 2), pdfInteger(9));
  objects.delete(ref(3));
  objects.add(pdfInteger(10));
  objects.setProduced(ref(2), new PdfDictionaryEntries(), function* produce() {
    yield Uint8Array.of(1);
  });
  objects.setTrailerEntry(name('Info'), pdfInteger(1));
  objects.requireFullRewrite('metadata-history');
  objects.requireIncrementalSave();
  objects.setSaveHook(hook);
};

const snapshot = (objects: EditedObjects): Array<unknown> => [
  [...objects.changes],
  [...objects.producedStreams.keys()],
  objects.size,
  objects.trailerChanges,
  objects.fullRewriteReason,
  objects.needsIncrementalSave,
  objects.saveHook,
];

describe('forks', () => {
  it('leaves the original untouched by edits to a fork until it adopts them', () => {
    const original = editsOf(load());
    const untouched = snapshot(original);
    const fork = original.fork();
    editAll(fork);
    expect(snapshot(original)).toStrictEqual(untouched);
    original.adopt(fork);
    expect([snapshot(original), original.saveHook === hook]).toStrictEqual([snapshot(fork), true]);
  });
});

describe('produced streams', () => {
  it('reads a produced stream by running its producer on every read, until a later set or delete drops it', () => {
    let calls = 0;
    const produce = function* produce(): Generator<Uint8Array> {
      calls++;
      yield Uint8Array.of(1, 2);
      yield Uint8Array.of(3);
    };
    const objects = editsOf(load());
    const dictionary = new PdfDictionaryEntries([[name('Type'), pdfName('XObject')]]);
    objects.setProduced(ref(5, 2), dictionary, produce);
    const reads = [objects.get(ref(5, 2)), objects.get(ref(5, 2))];
    const producers = [objects.producerFor(objects.resolve(5, 2)), objects.producerFor(reads[0] ?? { kind: 'null' })];
    expect([reads, calls, producers]).toStrictEqual([
      [
        { kind: 'stream', dictionary, data: Uint8Array.of(1, 2, 3) },
        { kind: 'stream', dictionary, data: Uint8Array.of(1, 2, 3) },
      ],
      2,
      [produce, undefined],
    ]);
    objects.set(ref(5, 2), pdfInteger(1));
    const added = objects.addProduced(dictionary, produce);
    objects.delete(added);
    expect([objects.get(ref(5, 2)), objects.get(added), [...objects.producedStreams.keys()], calls]).toStrictEqual([pdfInteger(1), { kind: 'null' }, [], 2]);
  });
});

type Operation =
  | { readonly kind: 'set'; readonly number: number; readonly value: number }
  | { readonly kind: 'delete'; readonly number: number }
  | { readonly kind: 'add'; readonly value: number }
  | { readonly kind: 'get'; readonly number: number }
  | { readonly kind: 'trailer'; readonly key: 'Info' | 'Custom'; readonly value: number | undefined };

// A dictionary holding an array, so that a copy that shares its array with the store is visible.
const valueOf = (value: number): PdfObject => pdfDictionary(new PdfDictionaryEntries([[name('V'), pdfArray([pdfInteger(value)])]]));

// Applies one operation, returning what a get read or the class of the error, and the reference an add returned.
const apply = (objects: EditedObjects, generations: ReadonlyMap<number, number>, operation: Operation): PdfObject | string => {
  try {
    switch (operation.kind) {
      case 'set': {
        objects.set(ref(operation.number, generations.get(operation.number) ?? 0), valueOf(operation.value));
        return 'set';
      }
      case 'delete': {
        objects.delete(ref(operation.number, generations.get(operation.number) ?? 0));
        return 'deleted';
      }
      case 'add': {
        return objects.add(valueOf(operation.value));
      }
      case 'get': {
        return objects.get(ref(operation.number, generations.get(operation.number) ?? 0));
      }
      case 'trailer': {
        objects.setTrailerEntry(name(operation.key), operation.value === undefined ? undefined : pdfInteger(operation.value));
        return 'trailer';
      }
    }
  } catch (error: unknown) {
    if (error instanceof InvalidArgumentError) {
      return 'InvalidArgumentError';
    }
    throw error;
  }
};

describe('properties', () => {
  const number = fc.integer({ min: 1, max: 12 });
  const value = fc.integer({ min: -3, max: 3 });
  const operation: fc.Arbitrary<Operation> = fc.oneof(
    fc.record({ kind: fc.constant('set'), number, value }),
    fc.record({ kind: fc.constant('delete'), number }),
    fc.record({ kind: fc.constant('add'), value }),
    fc.record({ kind: fc.constant('get'), number }),
    fc.record({ kind: fc.constant('trailer'), key: fc.constantFrom('Info', 'Custom'), value: fc.option(value, { nil: undefined }) }),
  );

  it('behaves as a map of numbered objects that never reuses a number and hands out copies', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 30 }), operations => {
        const objects = editsOf(load());
        const generations = new Map([
          [1, 0],
          [2, 0],
          [3, 0],
          [5, 2],
        ]);
        const model = new Map([...generations].map(([objectNumber, generation]) => [objectNumber, objects.get(ref(objectNumber, generation))]));
        let next = 6;
        for (const step of operations) {
          const inUse = 'number' in step && model.has(step.number);
          let expected: PdfObject | string;
          if (step.kind === 'add') {
            expected = ref(next);
            model.set(next, valueOf(step.value));
            generations.set(next, 0);
            next++;
          } else if (step.kind === 'trailer') {
            expected = 'trailer';
          } else if (!inUse && step.kind !== 'get') {
            expected = 'InvalidArgumentError';
          } else if (step.kind === 'set') {
            expected = 'set';
            model.set(step.number, valueOf(step.value));
          } else if (step.kind === 'delete') {
            expected = 'deleted';
            model.delete(step.number);
          } else {
            expected = model.get(step.number) ?? { kind: 'null' };
          }
          const result = apply(objects, generations, step);
          expect(result).toStrictEqual(expected);
          // A read is a copy: changing it must not show in any later read.
          if (typeof result !== 'string' && result.kind === 'dictionary') {
            const inner = result.entries.get(name('V'));
            if (inner?.kind === 'array') {
              inner.items[0] = pdfInteger(-1);
            }
            result.entries.set(name('V'), pdfInteger(-1));
          }
        }
        expect(objects.size).toBe(next);
      }),
    );
  });

  it('gives a document that adopts a fork the same edits as one edited directly', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 30 }), operations => {
        const generations = new Map([[5, 2]]);
        const direct = editsOf(load());
        const adopting = editsOf(load());
        const fork = adopting.fork();
        for (const step of operations) {
          apply(direct, generations, step);
          apply(fork, generations, step);
        }
        const untouched = [[...adopting.changes], adopting.size, adopting.trailerChanges];
        adopting.adopt(fork);
        expect([untouched, [...adopting.changes], adopting.size, adopting.trailerChanges]).toStrictEqual([
          [[], 6, []],
          [...direct.changes],
          direct.size,
          direct.trailerChanges,
        ]);
      }),
    );
  });
});

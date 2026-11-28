import type { IndexEntry } from './objectIndex.ts';
import type { XrefEntry, XrefSection } from './xrefSection.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PdfDictionaryEntries } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes } from '../testing/pdfBuilder.ts';

import { ABSENT, COMPRESSED, FREE, IN_FILE, ObjectIndex, validateHeaders } from './objectIndex.ts';

const entry = (objectNumber: number, type: XrefEntry['type'], [location, generation] = [0, 0]): XrefEntry => ({ objectNumber, type, location, generation });

interface Validation {
  mismatch: ReturnType<typeof validateHeaders>;
  freed: Array<number>;
}

const offsetOf = (offsets: ReadonlyMap<number, number>, objectNumber: number): number => offsets.get(objectNumber) ?? 0;

const validate = (text: string, index: ObjectIndex): Validation => {
  const freed: Array<number> = [];
  const mismatch = validateHeaders(new ByteSource(latin1Bytes(text)), index, {
    skip: new Map([[99, 7]]),
    offsetZero: number => {
      freed.push(number);
    },
  });
  return { mismatch, freed };
};

const mismatchOf = (text: string, entries: Array<XrefEntry>): ReturnType<typeof validateHeaders> => validate(text, ObjectIndex.fromEntries(entries)).mismatch;

const section = (entries: ReadonlyArray<XrefEntry>): XrefSection => ({
  kind: 'classic',
  offset: 0,
  entries,
  trailer: new PdfDictionaryEntries([]),
  trailerStart: 0,
  trailerEnd: 0,
});

const views = (index: ObjectIndex): Array<IndexEntry> => [index.get(1), index.get(2), index.get(3)];

describe('object index', () => {
  it('keeps the first entry for each object number, free entries included', () => {
    const index = ObjectIndex.fromEntries(
      [entry(1, 'file', [10, 0]), entry(3, 'free'), entry(1, 'file', [99, 0]), entry(3, 'file', [50, 0]), entry(4, 'compressed', [7, 2])],
      5,
    );
    expect([index.get(1), index.get(3), index.get(4), index.get(2), index.get(99)]).toStrictEqual([
      { type: IN_FILE, location: 15, generation: 0 },
      { type: FREE, location: 0, generation: 0 },
      { type: COMPRESSED, location: 7, generation: 2 },
      { type: ABSENT, location: 0, generation: 0 },
      { type: ABSENT, location: 0, generation: 0 },
    ]);
    expect([index.size, index.dense, [...index.inUse()]]).toStrictEqual([5, true, [1, 4]]);
  });

  it('uses sorted arrays for sparse numbering', () => {
    const entries = [
      entry(50_000_000, 'file', [100, 0]),
      ...Array.from({ length: 10 }, (_, number) => entry(number + 1, 'file', [number * 10 + 20, 0])),
      entry(50_000_000, 'free'),
    ];
    const index = ObjectIndex.fromEntries(entries);
    expect([index.dense, index.size, index.get(50_000_000).location, index.get(7).location, index.get(11).type]).toStrictEqual([
      false,
      50_000_001,
      100,
      80,
      ABSENT,
    ]);
    expect([...index.inUse()]).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50_000_000]);
  });

  it('accepts offsets on white space before a header and frees entries with offset 0', () => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<<>>' },
          { number: 2, body: '5' },
        ],
      },
    ]);
    const offset = offsetOf(pdf.offsets, 2);
    const index = ObjectIndex.fromEntries([entry(1, 'file', [0, 0]), entry(2, 'file', [offset - 1, 0])]);
    expect(validate(pdf.text, index)).toStrictEqual({ mismatch: undefined, freed: [1] });
    expect(index.get(1).type).toBe(FREE);
  });

  it('reports the first entry that does not point at its header', () => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<<>>' },
          { number: 2, body: '5' },
        ],
      },
    ]);
    const offset = offsetOf(pdf.offsets, 2);
    expect(mismatchOf(pdf.text, [entry(2, 'file', [offset + 1, 0])])).toStrictEqual({ objectNumber: 2, offset: offset + 1 });
    expect(mismatchOf(pdf.text, [entry(2, 'file', [offset, 1])])).toStrictEqual({ objectNumber: 2, offset });
    expect(mismatchOf(pdf.text, [entry(1, 'file', [offset, 0])])).toStrictEqual({ objectNumber: 1, offset });
    expect(mismatchOf(pdf.text, [entry(1, 'file', [1_000_000, 0])])).toStrictEqual({ objectNumber: 1, offset: 1_000_000 });
    const first = offsetOf(pdf.offsets, 1);
    expect(mismatchOf(pdf.text, [entry(2, 'file', [offset + 1, 0]), entry(1, 'file', [first + 1, 0])])).toStrictEqual({ objectNumber: 1, offset: first + 1 });
  });

  it('checks neither compressed entries nor in-file entries at or past the end of the file as headers', () => {
    const pdf = buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<<>>' }] }]);
    expect(mismatchOf(pdf.text, [entry(1, 'compressed', [3, 0])])).toBeUndefined();
    expect(mismatchOf(pdf.text, [entry(1, 'file', [pdf.text.length, 0])])).toStrictEqual({ objectNumber: 1, offset: pdf.text.length });
  });

  it('drops an entry for a cross-reference stream number that points at another object', () => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<<>>' },
          { number: 2, body: '5' },
        ],
      },
    ]);
    // The skip map gives offset 7 for object 99: an entry there is the stream's own and stays in use unchecked.
    const own = ObjectIndex.fromEntries([entry(99, 'file', [7, 0])]);
    const stream = ObjectIndex.fromEntries([entry(99, 'file', [offsetOf(pdf.offsets, 2), 0])]);
    const zero = ObjectIndex.fromEntries([entry(99, 'file', [0, 0])]);
    expect([validate(pdf.text, own), own.get(99)]).toStrictEqual([
      { mismatch: undefined, freed: [] },
      { type: IN_FILE, location: 7, generation: 0 },
    ]);
    expect([validate(pdf.text, stream), stream.get(99).type]).toStrictEqual([{ mismatch: undefined, freed: [] }, FREE]);
    // An entry with offset 0 for a cross-reference stream's number is dropped as pointing elsewhere, not reported as an offset of 0.
    expect([validate(pdf.text, zero), zero.get(99).type]).toStrictEqual([{ mismatch: undefined, freed: [] }, FREE]);
  });

  it('lets an entry from an earlier section win and shifts in-file entries only', () => {
    const newest = section([entry(1, 'file', [10, 0]), entry(2, 'compressed', [9, 1])]);
    const oldest = section([entry(1, 'file', [20, 0]), entry(3, 'free', [5, 2]), entry(2, 'file', [30, 0])]);
    const expected = [
      { type: IN_FILE, location: 14, generation: 0 },
      { type: COMPRESSED, location: 9, generation: 1 },
      { type: FREE, location: 5, generation: 2 },
    ];
    expect(views(ObjectIndex.fromSections([newest, oldest], 4))).toStrictEqual(expected);
    // An object numbered 5,000 makes the numbering sparse.
    const sparse = ObjectIndex.fromSections([newest, section([...oldest.entries, entry(5000, 'file', [40, 0])])], 4);
    expect([sparse.dense, views(sparse), sparse.get(5000)]).toStrictEqual([false, expected, { type: IN_FILE, location: 44, generation: 0 }]);
  });

  it('switches to sparse numbering above four slots per entry plus 1,024', () => {
    const at = ObjectIndex.fromEntries([entry(1027, 'file', [50, 0])]);
    const past = ObjectIndex.fromEntries([entry(1028, 'file', [50, 0])]);
    expect([at.dense, at.size, at.get(1027), at.get(1026).type]).toStrictEqual([true, 1028, { type: IN_FILE, location: 50, generation: 0 }, ABSENT]);
    expect([past.dense, past.size, past.get(1028), past.get(1027).type]).toStrictEqual([false, 1029, { type: IN_FILE, location: 50, generation: 0 }, ABSENT]);
  });

  it.each([
    ['dense', 10],
    ['sparse', 50_000],
  ])('lists free entries in ascending order and frees no number it does not hold, %s', (_, high) => {
    const index = ObjectIndex.fromEntries([entry(high, 'free'), entry(4, 'file', [9, 0]), entry(2, 'free'), entry(7, 'free'), entry(3, 'file', [8, 0])]);
    index.free(-1);
    index.free(high + 1);
    // 5 lies below the highest number but has no entry, so it stays absent in either layout.
    index.free(5);
    index.free(4);
    expect([[...index.freeEntries()], [...index.inUse()], index.get(-1), index.get(5).type]).toStrictEqual([
      [2, 4, 7, high],
      [3],
      { type: ABSENT, location: 0, generation: 0 },
      ABSENT,
    ]);
  });
});

describe('properties', () => {
  const entryOf = fc.record({
    objectNumber: fc.integer({ min: 0, max: 3000 }),
    type: fc.constantFrom<XrefEntry['type']>('free', 'file', 'compressed'),
    location: fc.integer({ min: 0, max: 1_000_000 }),
    generation: fc.integer({ min: 0, max: 65_535 }),
  });

  // Up to 20 entries numbered up to 3,000 fall on both sides of the dense limit of 4 slots per entry plus 1,024.
  it('agrees with a first-wins map on every number, in both the dense and the sparse layout', () => {
    fc.assert(
      fc.property(fc.array(entryOf, { maxLength: 20 }), fc.integer({ min: 0, max: 5000 }), (entries, shift) => {
        const model = new Map<number, XrefEntry>();
        for (const item of entries) {
          if (!model.has(item.objectNumber)) {
            model.set(item.objectNumber, item);
          }
        }
        const index = ObjectIndex.fromEntries(entries, shift);
        const types = { free: FREE, file: IN_FILE, compressed: COMPRESSED } as const;
        const expected = (objectNumber: number): IndexEntry => {
          const item = model.get(objectNumber);
          if (item === undefined) {
            return { type: ABSENT, location: 0, generation: 0 };
          }
          return { type: types[item.type], location: item.type === 'file' ? item.location + shift : item.location, generation: item.generation };
        };
        const numbers = Array.from({ length: index.size + 2 }, (_, position) => position - 1);
        const sorted = [...model.values()].toSorted((left, right) => left.objectNumber - right.objectNumber);
        expect([numbers.map(objectNumber => index.get(objectNumber)), [...index.inUse()], [...index.freeEntries()]]).toStrictEqual([
          numbers.map(objectNumber => expected(objectNumber)),
          sorted.flatMap(item => (item.type === 'free' ? [] : [item.objectNumber])),
          sorted.flatMap(item => (item.type === 'free' ? [item.objectNumber] : [])),
        ]);
      }),
    );
  });
});

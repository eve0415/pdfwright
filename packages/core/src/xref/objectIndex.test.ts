import type { XrefEntry } from './xrefSection.ts';

import { describe, expect, it } from 'vitest';

import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes } from '../testing/pdfBuilder.ts';

import { ABSENT, COMPRESSED, FREE, IN_FILE, ObjectIndex, validateHeaders } from './objectIndex.ts';

const entry = (objectNumber: number, type: XrefEntry['type'], [location, generation] = [0, 0]): XrefEntry => ({ objectNumber, type, location, generation });

interface Validation {
  mismatch: ReturnType<typeof validateHeaders>;
  freed: number[];
}

const offsetOf = (offsets: ReadonlyMap<number, number>, objectNumber: number): number => offsets.get(objectNumber) ?? 0;

const validate = (text: string, index: ObjectIndex): Validation => {
  const freed: number[] = [];
  const mismatch = validateHeaders(new ByteSource(latin1Bytes(text)), index, {
    skip: new Map([[99, 7]]),
    offsetZero: number => {
      freed.push(number);
    },
  });
  return { mismatch, freed };
};

const mismatchOf = (text: string, entries: XrefEntry[]): ReturnType<typeof validateHeaders> => validate(text, ObjectIndex.fromEntries(entries)).mismatch;

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
    expect([mismatchOf(pdf.text, [entry(99, 'file', [7, 0])]), mismatchOf(pdf.text, [entry(99, 'file', [offset, 0])])]).toStrictEqual([
      undefined,
      { objectNumber: 99, offset },
    ]);
  });
});

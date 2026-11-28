import type { CMapCode } from './mappingTable.ts';
import type { CodeRange } from './parseCMap.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MappingTable } from './mappingTable.ts';

type Tagged = CodeRange & { readonly id: string };

const range = (id: string, low: number, high: number, length = 1): Tagged => ({ id, length, low, high });

describe('mapping tables', () => {
  it.each([
    { label: 'a later range ends before the code', ranges: [range('wide', 0, 100), range('inner', 10, 20)], found: 'wide' },
    { label: 'a later range holds the code', ranges: [range('wide', 0, 100), range('inner', 40, 60)], found: 'inner' },
    { label: 'the ranges are given highest first', ranges: [range('inner', 40, 60), range('wide', 0, 100)], found: 'inner' },
    { label: 'no range holds the code', ranges: [range('low', 0, 10), range('high', 60, 100)], found: undefined },
    { label: 'only a range of another length holds the code', ranges: [range('two-byte', 0, 100, 2)], found: undefined },
  ])('finds code 50 when $label', ({ ranges, found }) => {
    expect(new MappingTable(ranges).find({ value: 50, length: 1 })?.id).toBe(found);
  });

  it('prefers the last single-code mapping of a code to any range that holds it', () => {
    const table = new MappingTable([range('first', 50, 50), range('range', 0, 100), range('second', 50, 50)]);
    expect([table.find({ value: 50, length: 1 })?.id, table.find({ value: 51, length: 1 })?.id]).toStrictEqual(['second', 'range']);
  });
});

// The mapping a linear scan finds: the last single-code mapping with the code's length and value, else the range of that length holding the code with the highest low bound.
const reference = (mappings: ReadonlyArray<Tagged>, code: CMapCode): string | undefined => {
  const single = mappings.findLast(mapping => mapping.low === mapping.high && mapping.length === code.length && mapping.low === code.value);
  if (single !== undefined) {
    return single.id;
  }
  const holding = mappings.filter(
    mapping => mapping.low !== mapping.high && mapping.length === code.length && mapping.low <= code.value && code.value <= mapping.high,
  );
  return holding.toSorted((left, right) => right.low - left.low)[0]?.id;
};

describe('properties', () => {
  const length = fc.integer({ min: 1, max: 4 });
  const value = fc.integer({ min: 0, max: 48 });
  const single = fc.record({ length, low: value }).map(({ length: size, low }) => ({ length: size, low, high: low }));
  const spanning = fc
    .record({ length, low: value, span: fc.integer({ min: 1, max: 32 }) })
    .map(({ length: size, low, span }) => ({ length: size, low, high: low + span }));
  // Ranges of one length have distinct low bounds, because the order of ranges that share one is not part of the contract.
  const mappings = fc
    .tuple(
      fc.array(single, { maxLength: 12 }),
      fc.uniqueArray(spanning, { maxLength: 12, selector: mapping => `${String(mapping.length)}:${String(mapping.low)}` }),
    )
    .chain(([singles, ranges]) => fc.shuffledSubarray([...singles, ...ranges], { minLength: singles.length + ranges.length }))
    .map(items => items.map((item, index): Tagged => ({ ...item, id: String(index) })));

  it('finds what a linear scan finds', () => {
    fc.assert(
      fc.property(mappings, fc.array(fc.record({ length, value: fc.integer({ min: 0, max: 84 }) }), { minLength: 1, maxLength: 20 }), (items, codes) => {
        const table = new MappingTable(items);
        expect(codes.map(code => table.find(code)?.id)).toStrictEqual(codes.map(code => reference(items, code)));
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';

import { LITERAL_BASE, LITERAL_BITS, LITERAL_DISTRIBUTION, MATCH_BASE, MATCH_BITS, MATCH_DISTRIBUTION } from './predefinedTables.ts';

// RFC 8878, 3.1.1.3.2.1.1, Tables 16 and 17: literal length codes 0-35 cover 0 to 131,071 and match length codes 0-52 cover 3 to 131,074.
const TABLES = [
  { name: 'literal length', bases: LITERAL_BASE, bits: LITERAL_BITS, distribution: LITERAL_DISTRIBUTION, codes: 36, first: 0, last: 131_071 },
  { name: 'match length', bases: MATCH_BASE, bits: MATCH_BITS, distribution: MATCH_DISTRIBUTION, codes: 53, first: 3, last: 131_074 },
];

describe('predefined length codes', () => {
  it.each(TABLES)('gives each $name code a base, an extra-bit count and a probability', ({ bases, bits, distribution, codes }) => {
    expect([bases.length, bits.length, distribution.length]).toStrictEqual([codes, codes, codes]);
  });

  it.each(TABLES)('covers every $name in its range with exactly one code', ({ bases, bits, first, last }) => {
    const covering = (length: number): number => bases.filter((base, code) => length >= base && length < base + 2 ** (bits[code] ?? 0)).length;
    const counts = new Map<number, number>();
    for (let length = first - 1; length <= last + 1; length++) {
      const count = covering(length);
      counts.set(count, (counts.get(count) ?? 0) + 1);
    }
    expect(covering(first - 1)).toBe(0);
    expect(covering(last + 1)).toBe(0);
    expect(counts).toStrictEqual(
      new Map([
        [0, 2],
        [1, last - first + 1],
      ]),
    );
  });
});

import type { CodeRange } from './parseCMap.ts';

/** A character code: its bytes read as a big-endian number, and how many bytes it has (1 to 4). */
export interface CMapCode {
  readonly value: number;
  readonly length: number;
}

// Codes of different lengths are different codes (9.7.6.2: "looked up in the character code mappings for codes of that length"), so the key carries the length above the 32-bit value.
const keyOf = (length: number, value: number): number => length * 0x100000000 + value;

/**
 * Mappings of one kind, looked up by code: single-code mappings by key, the rest by binary search over ranges sorted by their low bound.
 * A later single-code mapping replaces an earlier one; of overlapping ranges, which a well-formed CMap does not have, the one with the highest low bound that contains the code wins.
 */
export class MappingTable<T extends CodeRange> {
  private readonly singles = new Map<number, T>();
  private readonly ranges: T[];
  private readonly reach: number[];

  constructor(mappings: readonly T[]) {
    const ranges: T[] = [];
    for (const mapping of mappings) {
      if (mapping.low === mapping.high) this.singles.set(keyOf(mapping.length, mapping.low), mapping);
      else ranges.push(mapping);
    }
    ranges.sort((left, right) => keyOf(left.length, left.low) - keyOf(right.length, right.low));
    this.ranges = ranges;
    // reach[i] is the highest code any range up to i covers, so the search can stop once no earlier range reaches the code.
    let reach = 0;
    this.reach = ranges.map(range => {
      reach = Math.max(reach, keyOf(range.length, range.high));
      return reach;
    });
  }

  find(code: CMapCode): T | undefined {
    const key = keyOf(code.length, code.value);
    const single = this.singles.get(key);
    if (single !== undefined) return single;
    let low = 0;
    let high = this.ranges.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const range = this.ranges[middle];
      if (range !== undefined && keyOf(range.length, range.low) <= key) low = middle + 1;
      else high = middle - 1;
    }
    for (let index = high; index >= 0 && (this.reach[index] ?? 0) >= key; index--) {
      const range = this.ranges[index];
      if (range !== undefined && range.length === code.length && range.low <= code.value && code.value <= range.high) return range;
    }
    return undefined;
  }
}

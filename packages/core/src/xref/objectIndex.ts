import type { ByteSource } from '../parse/byteSource.ts';
import type { LexContext } from '../parse/lexer.ts';
import type { XrefEntry, XrefSection } from './xrefSection.ts';

import { Lexer } from '../parse/lexer.ts';

export const ABSENT = 0;
export const FREE = 1;
export const IN_FILE = 2;
export const COMPRESSED = 3;

export type IndexType = typeof ABSENT | typeof FREE | typeof IN_FILE | typeof COMPRESSED;

export interface IndexEntry {
  readonly type: IndexType;
  /** File offset for IN_FILE, object stream number for COMPRESSED. */
  readonly location: number;
  /** Generation for IN_FILE and FREE, index within the object stream for COMPRESSED. */
  readonly generation: number;
}

const TYPES: Readonly<Record<XrefEntry['type'], IndexType>> = { free: FREE, file: IN_FILE, compressed: COMPRESSED };

const ABSENT_ENTRY: IndexEntry = { type: ABSENT, location: 0, generation: 0 };

/**
 * The merged cross-reference information, one entry per object number, in typed arrays.
 * Numbering that is dense enough is indexed directly by object number; sparse numbering keeps sorted arrays searched by binary search, so one object numbered 50,000,000 does not allocate for every number below it.
 */
export class ObjectIndex {
  /** One above the highest object number with an entry. */
  readonly size: number;
  private readonly numbers: Uint32Array | undefined;
  private readonly types: Uint8Array;
  private readonly locations: Float64Array;
  private readonly generations: Uint32Array;

  private constructor(size: number, numbers: Uint32Array | undefined, count: number) {
    this.size = size;
    this.numbers = numbers;
    this.types = new Uint8Array(count);
    this.locations = new Float64Array(count);
    this.generations = new Uint32Array(count);
  }

  /** Builds the index from entries in precedence order: the first entry for an object number wins. */
  static fromEntries(entries: readonly XrefEntry[], shift = 0): ObjectIndex {
    let highest = -1;
    for (const entry of entries) highest = Math.max(highest, entry.objectNumber);
    const size = highest + 1;
    if (size <= 4 * entries.length + 1024) {
      const index = new ObjectIndex(size, undefined, size);
      for (const entry of entries) index.fill(entry.objectNumber, entry, shift);
      return index;
    }
    const order = entries
      .map((entry, position) => ({ entry, position }))
      .toSorted((left, right) => left.entry.objectNumber - right.entry.objectNumber || left.position - right.position);
    const unique = order.filter((item, position) => position === 0 || order[position - 1]?.entry.objectNumber !== item.entry.objectNumber);
    const index = new ObjectIndex(
      size,
      Uint32Array.from(unique, item => item.entry.objectNumber),
      unique.length,
    );
    for (const [slot, item] of unique.entries()) index.fill(slot, item.entry, shift);
    return index;
  }

  /** Builds the index from cross-reference sections in search order. */
  static fromSections(sections: readonly XrefSection[], shift = 0): ObjectIndex {
    return ObjectIndex.fromEntries(
      sections.flatMap(section => section.entries),
      shift,
    );
  }

  get dense(): boolean {
    return this.numbers === undefined;
  }

  private fill(slot: number, entry: XrefEntry, shift: number): void {
    if (this.types[slot] !== ABSENT) return;
    const type = TYPES[entry.type];
    this.types[slot] = type;
    this.locations[slot] = type === IN_FILE ? entry.location + shift : entry.location;
    this.generations[slot] = entry.generation;
  }

  private slot(objectNumber: number): number {
    const { numbers } = this;
    if (numbers === undefined) return objectNumber >= 0 && objectNumber < this.size ? objectNumber : -1;
    let low = 0;
    let high = numbers.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const value = numbers[middle] ?? 0;
      if (value === objectNumber) return middle;
      if (value < objectNumber) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  get(objectNumber: number): IndexEntry {
    const slot = this.slot(objectNumber);
    if (slot < 0) return ABSENT_ENTRY;
    const type = this.types[slot] ?? ABSENT;
    if (type === ABSENT) return ABSENT_ENTRY;
    return {
      type: type === FREE || type === IN_FILE || type === COMPRESSED ? type : ABSENT,
      location: this.locations[slot] ?? 0,
      generation: this.generations[slot] ?? 0,
    };
  }

  /** Marks an in-use entry as free, as for an in-file entry whose offset is 0. */
  free(objectNumber: number): void {
    const slot = this.slot(objectNumber);
    if (slot >= 0) this.types[slot] = FREE;
  }

  /** Object numbers with an in-use entry, ascending. */
  *inUse(): Generator<number> {
    for (let slot = 0; slot < this.types.length; slot++) {
      const type = this.types[slot];
      if (type === IN_FILE || type === COMPRESSED) yield this.numbers === undefined ? slot : (this.numbers[slot] ?? 0);
    }
  }
}

export interface HeaderMismatch {
  readonly objectNumber: number;
  readonly offset: number;
}

// A context per use, so that interned names do not outlive it.
const quiet = (): LexContext => ({
  warn: (): void => {
    // Only the header's presence is checked here; parsing the object later reports what it finds.
  },
  names: new Map(),
});

const headerMatches = (source: ByteSource, offset: number, expected: { objectNumber: number; generation: number }): boolean =>
  source.parseAt(offset, quiet(), (window, local, context) => {
    const lexer = new Lexer(window, local, context);
    const number = lexer.next();
    const generation = lexer.next();
    const keyword = lexer.next();
    return (
      number.kind === 'integer' &&
      number.value === expected.objectNumber &&
      generation.kind === 'integer' &&
      generation.value === expected.generation &&
      keyword.kind === 'keyword' &&
      keyword.keyword === 'obj'
    );
  });

/**
 * Checks that every in-file entry points at its object's "n g obj" header, allowing white space before it.
 * In-use entries with offset 0 are freed and reported through `offsetZero`; the first other mismatch is returned.
 */
export const validateHeaders = (source: ByteSource, index: ObjectIndex, offsetZero: (objectNumber: number) => void): HeaderMismatch | undefined => {
  for (const objectNumber of index.inUse()) {
    const entry = index.get(objectNumber);
    if (entry.type !== IN_FILE) continue;
    if (entry.location === 0) {
      index.free(objectNumber);
      offsetZero(objectNumber);
      continue;
    }
    if (entry.location >= source.length || !headerMatches(source, entry.location, { objectNumber, generation: entry.generation })) {
      return { objectNumber, offset: entry.location };
    }
  }
  return undefined;
};

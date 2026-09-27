import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { ByteSource } from '../parse/byteSource.ts';
import type { FileSource } from '../parse/indirectObject.ts';
import type { ObjectIndex } from '../xref/objectIndex.ts';
import type { XrefContext } from '../xref/xrefStream.ts';

import { ParseError } from '../error/parseError.ts';
import { parseIndirectObject } from '../parse/indirectObject.ts';
import { COMPRESSED, IN_FILE } from '../xref/objectIndex.ts';

export interface StoreContext extends XrefContext {
  readonly generationMismatch: 'error' | 'null';
  /** Approximate budget for parsed objects kept in memory, in bytes. */
  readonly parsedObjectCacheBytes: number;
}

export type IndirectSource = FileSource;

export interface StoredObject {
  readonly objectNumber: number;
  readonly generation: number;
  readonly value: PdfObject;
  readonly source: IndirectSource;
}

// Heap bytes per source byte of a parsed dictionary, rounded up from the 10-entry page dictionary measured at 5,619 bytes of heap for about 150 source bytes.
const HEAP_PER_SOURCE_BYTE = 40;

const cost = (object: StoredObject): number => {
  const { source } = object;
  const end = source.stream?.dictionaryEnd ?? source.valueEnd;
  return HEAP_PER_SOURCE_BYTE * (end - source.valueStart) + 128;
};

/** The objects of a source file: resolved lazily from their byte spans and kept in a bounded cache. */
export class ObjectStore {
  readonly source: ByteSource;
  readonly index: ObjectIndex;
  private readonly context: StoreContext;
  private readonly cache = new Map<number, StoredObject>();
  private cached = 0;
  private readonly resolving = new Set<number>();

  constructor(source: ByteSource, index: ObjectIndex, context: StoreContext) {
    this.source = source;
    this.index = index;
    this.context = context;
  }

  private remember(object: StoredObject): void {
    this.cache.set(object.objectNumber, object);
    this.cached += cost(object);
    for (const [number, oldest] of this.cache) {
      if (this.cached <= this.context.parsedObjectCacheBytes || number === object.objectNumber) break;
      this.cache.delete(number);
      this.cached -= cost(oldest);
    }
  }

  // ISO 32000-1:2008, 7.3.10, EXAMPLE 3: a stream's Length may be an indirect object, even one that follows the stream. A Length whose resolution is already in progress cannot be used.
  private resolveLength(objectNumber: number, generation: number): number | undefined {
    if (this.resolving.has(objectNumber)) return undefined;
    const entry = this.index.get(objectNumber);
    if ((entry.type !== IN_FILE && entry.type !== COMPRESSED) || (entry.type === IN_FILE && entry.generation !== generation)) return undefined;
    const value = this.load(objectNumber)?.value;
    return value?.kind === 'integer' && value.value >= 0 ? value.value : undefined;
  }

  /** Parses an object from its span, bypassing the cache; undefined for free and absent object numbers. */
  parse(objectNumber: number): StoredObject | undefined {
    const entry = this.index.get(objectNumber);
    if (entry.type !== IN_FILE) return undefined;
    this.resolving.add(objectNumber);
    try {
      const parsed = this.source.parseAt(entry.location, this.context, (window, local, lexContext) =>
        parseIndirectObject(window, local, {
          ...lexContext,
          maxNesting: this.context.maxNesting,
          resolveLength: (number, generation) => this.resolveLength(number, generation),
        }),
      );
      if (parsed.objectNumber !== objectNumber || parsed.generation !== entry.generation) {
        throw new ParseError(`object ${String(objectNumber)} ${String(entry.generation)} is not at its cross-reference offset`, entry.location);
      }
      return parsed;
    } finally {
      this.resolving.delete(objectNumber);
    }
  }

  /** The parsed object, from the cache when present. */
  load(objectNumber: number): StoredObject | undefined {
    const hit = this.cache.get(objectNumber);
    if (hit !== undefined) {
      this.cache.delete(objectNumber);
      this.cache.set(objectNumber, hit);
      return hit;
    }
    const object = this.parse(objectNumber);
    if (object !== undefined) this.remember(object);
    return object;
  }

  /**
   * Resolves `objectNumber generation R`. ISO 32000-1:2008, 7.3.10: "An indirect reference to an undefined object shall not be considered an error by a conforming reader; it shall be treated as a reference to the null object."
   * A reference whose generation differs from the in-use entry's throws ParseError unless generationMismatch is 'null', because readers disagree about it.
   */
  resolve(objectNumber: number, generation: number): PdfObject {
    const entry = this.index.get(objectNumber);
    if (entry.type !== IN_FILE && entry.type !== COMPRESSED) return { kind: 'null' };
    const expected = entry.type === IN_FILE ? entry.generation : 0;
    if (generation !== expected) {
      const detail = `reference ${String(objectNumber)} ${String(generation)} R names generation ${String(generation)}, but the in-use entry has generation ${String(expected)}`;
      if (this.context.generationMismatch === 'error') throw new ParseError(detail, entry.type === IN_FILE ? entry.location : 0);
      this.context.warn({ code: 'generation-mismatch', detail, objectNumber });
      return { kind: 'null' };
    }
    return this.load(objectNumber)?.value ?? { kind: 'null' };
  }

  /** Follows a reference to its object; other values are returned unchanged. */
  deref(value: PdfDirectObject | undefined): PdfObject | undefined {
    if (value?.kind !== 'reference') return value;
    return this.resolve(value.objectNumber, value.generation);
  }
}

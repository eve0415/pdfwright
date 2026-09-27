import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { ByteSource } from '../parse/byteSource.ts';
import type { FileSource } from '../parse/indirectObject.ts';
import type { ObjectIndex } from '../xref/objectIndex.ts';
import type { DecodedObjectStream, ObjectStreamContext } from '../xref/objectStream.ts';

import { GenerationMismatchError } from '../error/generationMismatchError.ts';
import { ParseError } from '../error/parseError.ts';
import { parseIndirectObject } from '../parse/indirectObject.ts';
import { COMPRESSED, IN_FILE } from '../xref/objectIndex.ts';
import { decodeObjectStream, parseMember } from '../xref/objectStream.ts';

export interface StoreContext extends ObjectStreamContext {
  readonly generationMismatch: 'error' | 'null';
  /** Approximate budget for parsed objects kept in memory, in bytes. */
  readonly parsedObjectCacheBytes: number;
}

/** Where a compressed object's value is: its span in the decoded object stream. */
export interface CompressedSource {
  readonly kind: 'compressed';
  readonly streamNumber: number;
  readonly index: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly clean: boolean;
}

export type IndirectSource = FileSource | CompressedSource;

export interface StoredObject {
  readonly objectNumber: number;
  readonly generation: number;
  readonly value: PdfObject;
  readonly source: IndirectSource;
}

// Heap bytes per source byte of a parsed dictionary, rounded up from the 10-entry page dictionary measured at 5,619 bytes of heap for about 150 source bytes.
const HEAP_PER_SOURCE_BYTE = 40;

// Stream data is free while it is a view of the source; data copied out of a window counts in full.
const cost = (object: StoredObject, source: ByteSource): number => {
  const span = object.source;
  const end = span.kind === 'file' ? (span.stream?.dictionaryEnd ?? span.valueEnd) : span.valueEnd;
  const { value } = object;
  const data = value.kind === 'stream' && !source.segments.some(segment => segment.buffer === value.data.buffer) ? value.data.byteLength : 0;
  return HEAP_PER_SOURCE_BYTE * (end - span.valueStart) + 128 + data;
};

// Decoded object streams kept at once; each is decoded again on demand after eviction.
const DECODED_STREAMS = 4;

/** The objects of a source file: resolved lazily from their byte spans and kept in a bounded cache. */
export class ObjectStore {
  readonly source: ByteSource;
  readonly index: ObjectIndex;
  private readonly context: StoreContext;
  private readonly cache = new Map<number, StoredObject>();
  private cached = 0;
  private readonly resolving = new Set<number>();
  private readonly decoded = new Map<number, DecodedObjectStream>();

  constructor(source: ByteSource, index: ObjectIndex, context: StoreContext) {
    this.source = source;
    this.index = index;
    this.context = context;
  }

  private remember(object: StoredObject): void {
    this.cache.set(object.objectNumber, object);
    this.cached += cost(object, this.source);
    for (const [number, oldest] of this.cache) {
      if (this.cached <= this.context.parsedObjectCacheBytes || number === object.objectNumber) break;
      this.cache.delete(number);
      this.cached -= cost(oldest, this.source);
    }
  }

  // ISO 32000-1:2008, 7.3.10, EXAMPLE 3: a stream's Length may be an indirect object, even one that follows the stream. A Length whose resolution is already in progress cannot be used.
  private resolveLength(objectNumber: number, generation: number): number | undefined {
    const entry = this.index.get(objectNumber);
    // ISO 32000-1:2008, 7.5.7 forbids storing "An object representing the value of the Length entry in an object stream dictionary" in an object stream; such a Length is read as unresolvable.
    if (this.resolving.has(objectNumber) || (entry.type === COMPRESSED && this.resolving.has(entry.location))) return undefined;
    if ((entry.type !== IN_FILE && entry.type !== COMPRESSED) || (entry.type === IN_FILE && entry.generation !== generation)) return undefined;
    const value = this.load(objectNumber)?.value;
    return value?.kind === 'integer' && value.value >= 0 ? value.value : undefined;
  }

  /** The decoded object stream `objectNumber`, from a small cache of recently decoded streams. */
  objectStream(objectNumber: number): DecodedObjectStream {
    const hit = this.decoded.get(objectNumber);
    if (hit !== undefined) {
      this.decoded.delete(objectNumber);
      this.decoded.set(objectNumber, hit);
      return hit;
    }
    const entry = this.index.get(objectNumber);
    // Table 18, type 2: "The generation number of the object stream shall be implicitly 0."
    if (entry.type !== IN_FILE || entry.generation !== 0) {
      throw new ParseError(`object stream ${String(objectNumber)} has no in-file entry with generation 0`, 0);
    }
    this.resolving.add(objectNumber);
    try {
      const object = this.load(objectNumber);
      const stream = decodeObjectStream(objectNumber, object?.value ?? { kind: 'null' }, { ...this.context, deref: value => this.deref(value) });
      this.decoded.set(objectNumber, stream);
      for (const number of this.decoded.keys()) {
        if (this.decoded.size <= DECODED_STREAMS) break;
        this.decoded.delete(number);
      }
      return stream;
    } finally {
      this.resolving.delete(objectNumber);
    }
  }

  private parseCompressed(objectNumber: number, streamNumber: number, index: number): StoredObject {
    const stream = this.objectStream(streamNumber);
    let clean = true;
    const value = parseMember(
      stream,
      { objectNumber, index },
      {
        ...this.context,
        warn: warning => {
          clean = false;
          this.context.warn(warning);
        },
      },
    );
    const member = stream.members[index];
    const source: CompressedSource = { kind: 'compressed', streamNumber, index, valueStart: member?.start ?? 0, valueEnd: member?.end ?? 0, clean };
    return { objectNumber, generation: 0, value, source };
  }

  /** Parses an object from its span, bypassing the cache; undefined for free and absent object numbers. */
  parse(objectNumber: number): StoredObject | undefined {
    const entry = this.index.get(objectNumber);
    if (entry.type === COMPRESSED) return this.parseCompressed(objectNumber, entry.location, entry.generation);
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
      if (this.context.generationMismatch === 'error') throw new GenerationMismatchError(detail, entry.type === IN_FILE ? entry.location : 0);
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

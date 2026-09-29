import type { ObjectStore } from '../document/objectStore.ts';
import type { LexContext } from '../parse/lexer.ts';
import type { SourceNode } from '../parse/parseObject.ts';

import { Lexer } from '../parse/lexer.ts';
import { parseAnnotated } from '../parse/parseObject.ts';
import { COMPRESSED, IN_FILE } from '../xref/objectIndex.ts';

/** An object's value as parsed from the source, with the spans of its parts in `bytes`; for a stream, its dictionary. */
export interface OriginalValue {
  readonly node: SourceNode;
  readonly bytes: Uint8Array;
}

// A context per parse, so that interned names do not outlive it.
const quiet = (): LexContext => ({
  warn: (): void => {
    // The object was parsed, with warnings, when it was loaded.
  },
  names: new Map(),
});

const annotate = (bytes: Uint8Array, maxNesting: number): OriginalValue => ({
  node: parseAnnotated(new Lexer({ bytes, base: 0, final: true }, 0, quiet()), maxNesting),
  bytes,
});

/** The annotated original of a source object, or undefined for an object the source does not hold. */
export const originalValue = (store: ObjectStore, objectNumber: number, maxNesting: number): OriginalValue | undefined => {
  const entry = store.index.get(objectNumber);
  if (entry.type === COMPRESSED) {
    const stream = store.objectStream(entry.location);
    const member = stream.members[entry.generation];
    return member === undefined ? undefined : annotate(stream.data.subarray(member.start, member.end), maxNesting);
  }
  if (entry.type !== IN_FILE) return undefined;
  const source = store.load(objectNumber)?.source;
  if (source?.kind !== 'file') return undefined;
  return annotate(store.source.copy(source.valueStart, source.stream?.dictionaryEnd ?? source.valueEnd).bytes, maxNesting);
};

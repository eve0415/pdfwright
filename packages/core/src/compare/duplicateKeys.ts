import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LexContext } from '../parse/lexer.ts';
import type { SourceNode } from '../parse/parseObject.ts';
import type { PdfDifference, ValuePath } from './pdfDifference.ts';

import { ParseError } from '../error/parseError.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseAnnotated } from '../parse/parseObject.ts';
import { originalValue } from '../save/originalValue.ts';

/** A key that a dictionary holds more than once, and where that dictionary is within its object. */
export interface DuplicateKey {
  readonly where: ValuePath;
  readonly key: Uint8Array;
}

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

// The duplicate keys of every dictionary within a parsed value, by place relative to it.
const duplicatesIn = (root: SourceNode): Map<string, DuplicateKey> => {
  const found = new Map<string, DuplicateKey>();
  const pending: { readonly node: SourceNode; readonly where: ValuePath }[] = [{ node: root, where: [] }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, where } = next;
    const seen = new Set<string>();
    for (const entry of node.entries ?? []) {
      const name = latin1(entry.key);
      if (seen.has(name)) found.set(JSON.stringify([where, name]), { where, key: entry.key });
      seen.add(name);
      pending.push({ node: entry.node, where: [...where, name] });
    }
    for (const [index, item] of (node.items ?? []).entries()) pending.push({ node: item, where: [...where, index] });
  }
  return found;
};

// Whether the object, parsed now if it was not yet, holds a key more than once; an object that cannot be parsed is reported where its value is compared.
const parsedWithDuplicates = (document: DocumentInternals, objectNumber: number): boolean => {
  try {
    document.objects.store.load(objectNumber);
  } catch (error: unknown) {
    if (error instanceof ParseError) return false;
    throw error;
  }
  return document.objects.store.hasDuplicateKeys(objectNumber);
};

/**
 * The keys that dictionaries anywhere in a source object hold more than once, by place; none for an object that was changed, as a changed object holds each key once.
 * ISO 32000-1:2008, 7.3.7: "Multiple entries in the same dictionary shall not have the same key."
 */
export const duplicateKeys = (document: DocumentInternals, objectNumber: number): Map<string, DuplicateKey> => {
  const { store } = document.objects;
  if (document.objects.changes.has(objectNumber) || !parsedWithDuplicates(document, objectNumber)) return new Map<string, DuplicateKey>();
  const original = originalValue(store, objectNumber, document.maxNesting);
  return original === undefined ? new Map<string, DuplicateKey>() : duplicatesIn(original.node);
};

const quiet = (): LexContext => ({
  warn: (): void => {
    // The trailer was parsed, with warnings, when the document was loaded.
  },
  names: new Map(),
});

/** The keys that the newest trailer, or the dictionary of the newest cross-reference stream, holds more than once. */
export const trailerDuplicateKeys = (document: DocumentInternals): Map<string, DuplicateKey> => {
  const { base } = document;
  if (base === undefined) return new Map<string, DuplicateKey>();
  const { bytes } = document.objects.store.source.copy(base.trailerStart, base.trailerEnd);
  const lexer = new Lexer({ bytes, base: 0, final: true }, 0, quiet());
  return duplicatesIn(parseAnnotated(lexer, document.maxNesting));
};

/** The duplicate keys of a place's dictionary that lie within one of its entries, or are that entry's key. */
export const withinEntry = (duplicates: ReadonlyMap<string, DuplicateKey>, key: string): Map<string, DuplicateKey> => {
  const found = new Map<string, DuplicateKey>();
  for (const [place, duplicate] of duplicates) {
    if (duplicate.where[0] === key || (duplicate.where.length === 0 && latin1(duplicate.key) === key)) found.set(place, duplicate);
  }
  return found;
};

/** The duplicate keys of the object a value refers to; none for a direct value, whose container's own check covers it. */
export const duplicatesOf = (document: DocumentInternals, value: PdfDirectObject | undefined): Map<string, DuplicateKey> =>
  value?.kind === 'reference' ? duplicateKeys(document, value.objectNumber) : new Map<string, DuplicateKey>();

/** Reports each duplicate key that one document holds at a place and the other does not, under `where`. */
export const reportDuplicates = (
  where: ValuePath,
  [left, right]: readonly [ReadonlyMap<string, DuplicateKey>, ReadonlyMap<string, DuplicateKey>],
  differences: PdfDifference[],
): void => {
  for (const [place, duplicate] of left) {
    if (!right.has(place)) differences.push({ kind: 'ambiguous-duplicate-key', where: [...where, ...duplicate.where], key: duplicate.key, document: 'a' });
  }
  for (const [place, duplicate] of right) {
    if (!left.has(place)) differences.push({ kind: 'ambiguous-duplicate-key', where: [...where, ...duplicate.where], key: duplicate.key, document: 'b' });
  }
};

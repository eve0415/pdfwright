import type { DocumentInternals } from '../document/documentInternals.ts';
import type { SourceNode } from '../parse/parseObject.ts';
import type { ValuePath } from './pdfDifference.ts';

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

/**
 * The keys that dictionaries anywhere in a source object hold more than once, by place; none for an object that was changed, as a changed object holds each key once.
 * ISO 32000-1:2008, 7.3.7: "Multiple entries in the same dictionary shall not have the same key."
 */
export const duplicateKeys = (document: DocumentInternals, objectNumber: number): Map<string, DuplicateKey> => {
  const found = new Map<string, DuplicateKey>();
  if (document.objects.changes.has(objectNumber) || !document.objects.store.hasDuplicateKeys(objectNumber)) return found;
  const original = originalValue(document.objects.store, objectNumber, document.maxNesting);
  const pending: { readonly node: SourceNode; readonly where: ValuePath }[] = original === undefined ? [] : [{ node: original.node, where: [] }];
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

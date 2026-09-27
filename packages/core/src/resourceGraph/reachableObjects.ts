import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';

export interface ReachableObjects {
  /** The generation of every in-use object reachable from the trailer, by object number, in the order the walk found them. */
  readonly objects: ReadonlyMap<number, number>;
  /** Reachable objects that could not be parsed, so that what they reference is unknown. */
  readonly unreadable: readonly { readonly reference: PdfReference; readonly reason: string }[];
}

// Pushed one by one: spreading a large array into push can exceed the engine's argument limit.
const pushChildren = (work: PdfDirectObject[], value: PdfObject): void => {
  if (value.kind === 'array') {
    for (const item of value.items) work.push(item);
    return;
  }
  if (value.kind === 'dictionary') {
    for (const [, item] of value.entries.entries()) work.push(item);
    return;
  }
  // A stream's data is a sequence of bytes, not objects (ISO 32000-1:2008, 7.3.8.1); only its dictionary references other objects.
  if (value.kind === 'stream') for (const [, item] of value.dictionary.entries()) work.push(item);
};

/**
 * Lists the objects reachable from the trailer through indirect references (ISO 32000-1:2008, 7.3.10), over the document as edited: objects set, added or deleted since loading count as they are now.
 * A reference counts only when it names an in-use object with its current generation; a reference to a free or missing object reaches nothing, since 7.3.10 says it "shall be treated as a reference to the null object".
 * The walk uses a work list rather than recursion and resolves each object once, so its work is linear in the size of the reachable objects.
 */
export const reachableObjects = (document: DocumentInternals): ReachableObjects => {
  const { objects: edited, structure } = document;
  const objects = new Map<number, number>();
  const unreadable: { reference: PdfReference; reason: string }[] = [];
  const work: PdfDirectObject[] = [];
  pushChildren(work, { kind: 'dictionary', entries: structure.trailer });
  for (let value = work.pop(); value !== undefined; value = work.pop()) {
    if (value.kind !== 'reference') {
      pushChildren(work, value);
      continue;
    }
    const { objectNumber, generation } = value;
    if (objects.has(objectNumber) || edited.generationOf(objectNumber) !== generation) continue;
    objects.set(objectNumber, generation);
    try {
      pushChildren(work, edited.resolve(objectNumber, generation));
    } catch (error: unknown) {
      if (!(error instanceof ParseError)) throw error;
      unreadable.push({ reference: value, reason: error.message });
    }
  }
  return { objects, unreadable };
};

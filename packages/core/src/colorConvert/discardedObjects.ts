import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfReference } from '../object/pdfObject.ts';

import { reachableObjects } from '../resourceGraph/reachableObjects.ts';

/** Deletes replaced objects only after all new references are installed. */
export const deleteDiscarded = (document: LoadedDocument, internals: DocumentInternals, discarded: readonly PdfReference[]): void => {
  const remaining = reachableObjects(internals).objects;
  const seen = new Set<number>();
  for (const reference of discarded) {
    const number = reference.objectNumber;
    if (seen.has(number) || remaining.has(number)) continue;
    seen.add(number);
    if (internals.objects.generationOf(number) === reference.generation) document.delete(reference);
  }
};

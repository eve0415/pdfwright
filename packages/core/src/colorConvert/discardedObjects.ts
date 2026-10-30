import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';

import { pdfFunctionReferences } from '../function/pdfFunction.ts';
import { reachableObjects } from '../resourceGraph/reachableObjects.ts';

/** The indirect objects of a function graph that conversion replaces, including the children of an indirect Functions array; deleteDiscarded keeps any still in use. */
export const discardedFunctionObjects = (internals: DocumentInternals, functionValue: PdfDirectObject): PdfReference[] =>
  pdfFunctionReferences(functionValue, value => internals.objects.deref(value) ?? { kind: 'null' });

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

import type { EditedObjects } from './editedObjects.ts';
import type { LoadedDocument } from './loadDocument.ts';
import type { PageEntry } from './pageTree.ts';
import type { DocumentStructure } from './readStructure.ts';

/** What other parts of the library read from a loaded document; the public interface does not expose it. */
export interface DocumentInternals {
  readonly objects: EditedObjects;
  readonly pages: readonly PageEntry[];
  readonly structure: DocumentStructure;
  readonly maxDecodedBytes: number;
  readonly maxNesting: number;
}

const internals = new WeakMap<LoadedDocument, DocumentInternals>();

export const registerInternals = (document: LoadedDocument, parts: DocumentInternals): void => {
  internals.set(document, parts);
};

/** The internals of a document this library loaded, or undefined for any other value. */
export const internalsOf = (document: LoadedDocument): DocumentInternals | undefined => internals.get(document);

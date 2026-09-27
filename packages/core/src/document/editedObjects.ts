import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ObjectResolver } from './loadedPage.ts';
import type { ObjectStore } from './objectStore.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { cloneObject } from '../object/cloneObject.ts';
import { COMPRESSED, IN_FILE } from '../xref/objectIndex.ts';

export type ObjectChange = { readonly generation: number; readonly value: PdfObject } | { readonly generation: number; readonly deleted: true };

const label = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)} R`;

/** The source file's objects with the changes made to them: set, deleted and new objects, which are kept until the document is saved. */
export class EditedObjects implements ObjectResolver {
  readonly store: ObjectStore;
  readonly changes = new Map<number, ObjectChange>();
  private next: number;

  constructor(store: ObjectStore, trailerSize: PdfDirectObject | undefined) {
    this.store = store;
    // New object numbers start above both the trailer Size and every indexed number and are never taken from the free list.
    // ISO 32000-1:2008, 7.5.7 requires this for object streams and compressed objects ("they shall always be assigned new object numbers, not old ones taken from the free list"); pdfwright does it for every new object.
    const size = trailerSize?.kind === 'integer' ? trailerSize.value : 0;
    this.next = Math.max(size, store.index.size, 1);
  }

  /** One above the highest object number in use or ever assigned. */
  get size(): number {
    return this.next;
  }

  /** The generation of the in-use object `objectNumber`, or undefined when it is free or absent. */
  generationOf(objectNumber: number): number | undefined {
    const change = this.changes.get(objectNumber);
    if (change !== undefined) return 'deleted' in change ? undefined : change.generation;
    const entry = this.store.index.get(objectNumber);
    if (entry.type === IN_FILE) return entry.generation;
    return entry.type === COMPRESSED ? 0 : undefined;
  }

  resolve(objectNumber: number, generation: number): PdfObject {
    const change = this.changes.get(objectNumber);
    if (change === undefined) return this.store.resolve(objectNumber, generation);
    if ('deleted' in change || change.generation !== generation) return { kind: 'null' };
    return change.value;
  }

  deref(value: PdfDirectObject | undefined): PdfObject | undefined {
    if (value?.kind !== 'reference') return value;
    return this.resolve(value.objectNumber, value.generation);
  }

  /** A copy of the object that shares nothing with the document; the source object is parsed once and cached, so its warnings are reported once. */
  get(reference: PdfReference): PdfObject {
    return cloneObject(this.resolve(reference.objectNumber, reference.generation));
  }

  private current(reference: PdfReference): void {
    const generation = this.generationOf(reference.objectNumber);
    if (generation === undefined) throw new InvalidArgumentError(`object ${label(reference)} is not in use; create objects with object()`);
    if (generation !== reference.generation) {
      throw new InvalidArgumentError(`object ${String(reference.objectNumber)} has generation ${String(generation)}, not ${String(reference.generation)}`);
    }
  }

  // ISO 32000-1:2008, 7.5.6, EXAMPLE: a changed object "retains the same object number and generation number as before".
  set(reference: PdfReference, value: PdfObject): void {
    this.current(reference);
    this.changes.set(reference.objectNumber, { generation: reference.generation, value: cloneObject(value) });
  }

  delete(reference: PdfReference): void {
    this.current(reference);
    this.changes.set(reference.objectNumber, { generation: reference.generation, deleted: true });
  }

  add(value: PdfObject): PdfReference {
    const objectNumber = this.next++;
    this.changes.set(objectNumber, { generation: 0, value: cloneObject(value) });
    return { kind: 'reference', objectNumber, generation: 0 };
  }
}

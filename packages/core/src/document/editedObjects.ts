import type { InvalidArgumentReason } from '../error/invalidArgumentError.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ObjectResolver } from './loadedPage.ts';
import type { ObjectStore } from './objectStore.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { cloneDirect, cloneObject, copyObject } from '../object/cloneObject.ts';
import { withTrailerChanges } from '../save/trailerCopy.ts';
import { COMPRESSED, IN_FILE } from '../xref/objectIndex.ts';

/** A trailer entry a save sets, or removes when the value is undefined. */
export interface TrailerChange {
  readonly key: Uint8Array;
  readonly value: PdfDirectObject | undefined;
}

/** Why an edit needs the whole file written again: an incremental update would keep superseded content readable in earlier revisions. */
export type FullRewriteReason = InvalidArgumentReason;

/** What a save hook needs to know about the save that runs it. */
export interface SaveHookContext {
  /** The fraction digits the save writes reals with. */
  readonly fractionDigits: number;
}

/**
 * Rewrites the changes a save writes, after every edit and before either writer runs, for objects whose content depends on everything else the save writes.
 * It works on the save's own copy of the changes, sets only objects that are already in use or already changed, and must give the same result for the same changes.
 */
export type SaveHook = (changes: Map<number, ObjectChange>, context: SaveHookContext) => void;

export type ObjectChange = { readonly generation: number; readonly value: PdfObject } | { readonly generation: number; readonly deleted: true };

const WRITER_KEYS = new Set(['Size', 'Prev', 'XRefStm', 'ID']);

const label = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)} R`;

/** The source file's objects with the changes made to them: set, deleted and new objects, which are kept until the document is saved. */
export class EditedObjects implements ObjectResolver {
  readonly store: ObjectStore;
  readonly changes: Map<number, ObjectChange> = new Map<number, ObjectChange>();
  private next: number;

  private objectStreams: ReadonlySet<number> | undefined = undefined;
  private readonly trailerEdits = new Map<string, TrailerChange>();
  private rewriteReason: FullRewriteReason | undefined = undefined;
  private incrementalRequired = false;
  private hook: SaveHook | undefined = undefined;

  constructor(store: ObjectStore) {
    this.store = store;
    // New object numbers start above every number a cross-reference section lists and are never taken from the free list; a trailer Size far above them would only stretch a rewrite's table.
    // ISO 32000-1:2008, 7.5.7 requires this for object streams and compressed objects ("they shall always be assigned new object numbers, not old ones taken from the free list"); pdfwright does it for every new object.
    this.next = Math.max(store.index.size, 1);
  }

  // Object streams that hold objects in use: replacing or deleting one would leave its members' entries pointing at nothing.
  private holdsObjects(objectNumber: number): boolean {
    if (this.objectStreams === undefined) {
      const streams = new Set<number>();
      for (const number of this.store.index.inUse()) {
        const entry = this.store.index.get(number);
        if (entry.type === COMPRESSED) streams.add(entry.location);
      }
      this.objectStreams = streams;
    }
    return this.objectStreams.has(objectNumber);
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

  /** A copy of the object that shares nothing with the document, stream data included; the source object is parsed once and cached, so its warnings are reported once. */
  get(reference: PdfReference): PdfObject {
    return copyObject(this.resolve(reference.objectNumber, reference.generation));
  }

  private current(reference: PdfReference): void {
    const generation = this.generationOf(reference.objectNumber);
    if (generation === undefined) throw new InvalidArgumentError(`object ${label(reference)} is not in use; create objects with object()`);
    if (generation !== reference.generation) {
      throw new InvalidArgumentError(`object ${String(reference.objectNumber)} has generation ${String(generation)}, not ${String(reference.generation)}`);
    }
    if (this.holdsObjects(reference.objectNumber)) throw new InvalidArgumentError(`object ${label(reference)} is an object stream that holds objects in use`);
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

  /**
   * Sets a trailer entry the next save writes, or removes it when the value is undefined.
   * Size, Prev, XRefStm and ID describe the saved file and are the writers' own.
   */
  setTrailerEntry(key: Uint8Array, value: PdfDirectObject | undefined): void {
    const name = new TextDecoder('latin1').decode(key);
    if (WRITER_KEYS.has(name)) throw new InvalidArgumentError(`the trailer ${name} entry is written by the save`);
    this.trailerEdits.delete(name);
    this.trailerEdits.set(name, { key: Uint8Array.from(key), value: value === undefined ? undefined : cloneDirect(value) });
  }

  /** Marks the edits as needing a full rewrite: a save in auto mode then rewrites, and an incremental save throws InvalidArgumentError with this reason. */
  requireFullRewrite(reason: FullRewriteReason): void {
    this.rewriteReason ??= reason;
  }

  /** Why the edits need a full rewrite, or undefined when an incremental update may carry them. */
  get fullRewriteReason(): FullRewriteReason | undefined {
    return this.rewriteReason;
  }

  requireIncrementalSave(): void {
    this.incrementalRequired = true;
  }

  get needsIncrementalSave(): boolean {
    return this.incrementalRequired;
  }

  /** Sets the hook every later save runs, replacing any earlier one. */
  setSaveHook(hook: SaveHook | undefined): void {
    this.hook = hook;
  }

  get saveHook(): SaveHook | undefined {
    return this.hook;
  }

  /** The trailer entry changes, in the order they were last made. */
  get trailerChanges(): readonly TrailerChange[] {
    return [...this.trailerEdits.values()];
  }

  /** The trailer as the next save writes its document entries: `base` with the changes applied. */
  trailer(base: PdfDictionaryEntries): PdfDictionaryEntries {
    return withTrailerChanges(base, this.trailerChanges);
  }

  /** A copy of these edits that shares the source: edits made to it change nothing here until they are adopted. */
  fork(): EditedObjects {
    const fork = new EditedObjects(this.store);
    fork.adopt(this);
    return fork;
  }

  /** Takes every edit of `other`, a fork of these edits, in place of these; nothing in it can fail, so a caller can make every edit that may fail on a fork first. */
  adopt(other: EditedObjects): void {
    this.changes.clear();
    for (const [objectNumber, change] of other.changes) this.changes.set(objectNumber, change);
    this.next = other.next;
    this.objectStreams = other.objectStreams;
    this.trailerEdits.clear();
    for (const [name, change] of other.trailerEdits) this.trailerEdits.set(name, change);
    this.rewriteReason = other.rewriteReason;
    this.incrementalRequired = other.incrementalRequired;
    this.hook = other.hook;
  }

  add(value: PdfObject): PdfReference {
    const objectNumber = this.next++;
    this.changes.set(objectNumber, { generation: 0, value: cloneObject(value) });
    return { kind: 'reference', objectNumber, generation: 0 };
  }
}

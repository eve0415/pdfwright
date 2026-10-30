import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ObjectChange } from './editedObjects.ts';
import type { BoxName, InheritedCache, ObjectResolver } from './loadedPage.ts';
import type { ObjectStore } from './objectStore.ts';
import type { PageEntry } from './pageTree.ts';

import { deepEqual } from '../object/deepEqual.ts';
import { pdfName } from '../object/pdfObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';
import { changedObjectBytes } from '../save/mergeSerialize.ts';

import { checkPageBox, createInheritedCache, inherited, readPageRectangle } from './loadedPage.ts';

interface SavedBoxContext {
  readonly changes: ReadonlyMap<number, ObjectChange>;
  readonly fractionDigits: number;
  readonly maxNesting: number;
}

const editedResolver = (store: ObjectStore, changes: ReadonlyMap<number, ObjectChange>): ObjectResolver => {
  const resolve = (objectNumber: number, generation: number): PdfObject => {
    const change = changes.get(objectNumber);
    if (change === undefined) return store.resolve(objectNumber, generation);
    return 'deleted' in change || change.generation !== generation ? { kind: 'null' } : change.value;
  };
  return { resolve, deref: value => (value?.kind === 'reference' ? resolve(value.objectNumber, value.generation) : value) };
};

const savedResolver = (store: ObjectStore, context: SavedBoxContext): ObjectResolver => {
  const cache = new Map<number, PdfObject>();
  const resolve = (objectNumber: number, generation: number): PdfObject => {
    const change = context.changes.get(objectNumber);
    if (change === undefined) return store.resolve(objectNumber, generation);
    if ('deleted' in change || change.generation !== generation) return { kind: 'null' };
    const cached = cache.get(objectNumber);
    if (cached !== undefined) return cached;
    if (change.value.kind === 'stream') return change.value;
    // Both save modes preserve unchanged coordinates, so validation must read the same merged bytes rather than round every coordinate anew.
    const bytes = changedObjectBytes(objectNumber, change.value, { store, fractionDigits: context.fractionDigits, maxNesting: context.maxNesting });
    const lexer = new Lexer({ bytes, base: 0, final: true }, 0, {
      names: new Map(),
      warn: (): void => {
        // Loading and saving report the source's warnings.
      },
    });
    const value = parseObject(lexer, context.maxNesting);
    cache.set(objectNumber, value);
    return value;
  };
  return { resolve, deref: value => (value?.kind === 'reference' ? resolve(value.objectNumber, value.generation) : value) };
};

interface BoxEntry {
  readonly value: PdfDirectObject;
  readonly owner: PdfReference;
  readonly name: BoxName;
}

const ownBox = (resolver: ObjectResolver, reference: PdfReference, name: BoxName): PdfDirectObject | undefined => {
  const page = resolver.resolve(reference.objectNumber, reference.generation);
  return page.kind === 'dictionary' ? page.entries.get(pdfName(name).bytes) : undefined;
};

const boxEntry = (resolver: ObjectResolver, page: PageEntry, { name, cache }: { name: BoxName; cache: InheritedCache }): BoxEntry | undefined => {
  // ISO 32000-1:2008, 7.7.3.3–7.7.3.4, Table 30: only MediaBox and CropBox are inheritable; default boxes have no coordinates to write.
  if (name === 'MediaBox' || name === 'CropBox') {
    const found = inherited(resolver, page, { key: pdfName(name).bytes, cache });
    return found === undefined ? undefined : { value: found.value, owner: found.from ?? page.reference, name };
  }
  const value = ownBox(resolver, page.reference, name);
  return value === undefined || resolver.deref(value)?.kind === 'null' ? undefined : { value, owner: page.reference, name };
};

const sameValue = (left: PdfObject | undefined, right: PdfObject | undefined): boolean =>
  left === undefined || right === undefined ? left === right : deepEqual(left, right, 'strict');

const unchangedBox = (store: ObjectStore, edited: ObjectResolver, entry: BoxEntry): boolean => {
  const original = store.deref(ownBox(store, entry.owner, entry.name));
  const current = edited.deref(entry.value);
  if (original?.kind !== 'array' || current?.kind !== 'array') return sameValue(original, current);
  return (
    original.items.length === current.items.length && original.items.every((item, index) => sameValue(store.deref(item), edited.deref(current.items[index])))
  );
};

/** Validates changed page boundaries against their written coordinates, preserving unchanged input boxes. */
export const validateSavedPageBoxes = (store: ObjectStore, pages: readonly PageEntry[], context: SavedBoxContext): void => {
  const edited = editedResolver(store, context.changes);
  const resolver = savedResolver(store, context);
  const cache = createInheritedCache();
  const editedCache = createInheritedCache();
  for (const page of pages) {
    for (const name of ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'] as const) {
      const entry = boxEntry(edited, page, { name, cache: editedCache });
      if (entry === undefined || unchangedBox(store, edited, entry)) continue;
      const written = boxEntry(resolver, page, { name, cache });
      if (written === undefined) continue;
      const media = boxEntry(resolver, page, { name: 'MediaBox', cache });
      checkPageBox(
        name,
        readPageRectangle(resolver, written.value, `the ${name}`),
        readPageRectangle(resolver, media?.value ?? { kind: 'null' }, 'the MediaBox'),
      );
    }
  }
};

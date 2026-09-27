import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ObjectResolver } from './loadedPage.ts';
import type { PageEntry } from './pageTree.ts';

import { ParseError } from '../error/parseError.ts';
import { cloneDirect } from '../object/cloneObject.ts';
import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName } from '../object/pdfObject.ts';

import { ancestorsOf } from './pageTree.ts';

/** The resource dictionary categories of ISO 32000-1:2008, 7.8.3, Table 33 that map names to resources. */
export type ResourceCategory = 'ExtGState' | 'ColorSpace' | 'Pattern' | 'Shading' | 'XObject' | 'Font' | 'Properties';

export interface ResourceObjects extends ObjectResolver {
  get: (reference: PdfReference) => PdfObject;
  set: (reference: PdfReference, value: PdfObject) => void;
  add: (value: PdfObject) => PdfReference;
}

export interface ResourceContext {
  readonly objects: ResourceObjects;
  /** Every page of the document, for telling whether a resource object is shared. */
  readonly pages: readonly PageEntry[];
}

const RESOURCES = pdfName('Resources').bytes;

const DEFAULT_PREFIXES: Readonly<Record<ResourceCategory, string>> = {
  ExtGState: 'GS',
  ColorSpace: 'CS',
  Pattern: 'P',
  Shading: 'Sh',
  XObject: 'X',
  Font: 'F',
  Properties: 'Pr',
};

const label = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)} R`;

const dictionaryOf = (objects: ObjectResolver, reference: PdfReference): PdfDictionaryEntries => {
  const value = objects.resolve(reference.objectNumber, reference.generation);
  if (value.kind !== 'dictionary') throw new ParseError(`object ${label(reference)} is not a dictionary`, 0);
  return value.entries;
};

// The Resources value that applies to a page: its own, or the nearest ancestor's (7.7.3.4), with where it was found.
const resourcesEntry = (objects: ObjectResolver, entry: PageEntry): { value: PdfDirectObject; inherited: boolean } | undefined => {
  const own = dictionaryOf(objects, entry.reference).get(RESOURCES);
  if (own !== undefined) return { value: own, inherited: false };
  for (const ancestor of ancestorsOf(entry)) {
    const value = dictionaryOf(objects, ancestor).get(RESOURCES);
    if (value !== undefined) return { value, inherited: true };
  }
  return undefined;
};

const copyEntries = (entries: PdfDictionaryEntries): PdfDictionaryEntries =>
  parsedDictionaryEntries([...entries.entries()].map(([key, value]) => [key, cloneDirect(value)] as const));

const asDictionary = (objects: ObjectResolver, value: PdfDirectObject | undefined, what: string): PdfDictionaryEntries => {
  const resolved = objects.deref(value);
  if (resolved === undefined || resolved.kind === 'null') return parsedDictionaryEntries([]);
  if (resolved.kind !== 'dictionary') throw new ParseError(`${what} is not a dictionary`, 0);
  return copyEntries(resolved.entries);
};

const sameReference = (left: PdfDirectObject | undefined, right: PdfReference): boolean =>
  left?.kind === 'reference' && left.objectNumber === right.objectNumber && left.generation === right.generation;

// Whether a page other than `page` reaches `reference` as its Resources or as one category of them.
interface Sharing {
  readonly reference: PdfReference;
  /** The category key, when the question is about one category of the resources. */
  readonly category?: Uint8Array;
}

const sharedWithOtherPages = (context: ResourceContext, page: PageEntry, { reference, category }: Sharing): boolean =>
  context.pages.some(other => {
    if (other.reference.objectNumber === page.reference.objectNumber) return false;
    const found = resourcesEntry(context.objects, other);
    if (found === undefined) return false;
    if (category === undefined) return sameReference(found.value, reference);
    const resources = context.objects.deref(found.value);
    return resources?.kind === 'dictionary' && sameReference(resources.entries.get(category), reference);
  });

const freeName = (taken: PdfDictionaryEntries, prefix: string): Uint8Array => {
  for (let ordinal = 1; ; ordinal++) {
    const name = pdfName(`${prefix}${String(ordinal)}`).bytes;
    if (!taken.has(name)) return name;
  }
};

interface Target {
  /** The dictionary to change, as a copy. */
  readonly entries: PdfDictionaryEntries;
  /** Stores the changed copy. */
  readonly store: (entries: PdfDictionaryEntries) => void;
}

// ISO 32000-1:2008, 7.8.3: a page's resources are the dictionary its Resources entry names, own or inherited. An indirect dictionary that other pages share is copied before it changes, so that they keep what they had.
const pageResourcesTarget = (context: ResourceContext, page: PageEntry): Target => {
  const { objects } = context;
  const found = resourcesEntry(objects, page);
  const pageEntries = (): PdfDictionaryEntries => {
    const value = objects.get(page.reference);
    if (value.kind !== 'dictionary') throw new ParseError(`page ${label(page.reference)} is not a dictionary`, 0);
    return value.entries;
  };
  const setOnPage = (value: PdfDirectObject): void => {
    const entries = pageEntries();
    entries.set(RESOURCES, value);
    objects.set(page.reference, { kind: 'dictionary', entries });
  };
  const reference = found?.value.kind === 'reference' ? found.value : undefined;
  const entries = asDictionary(objects, found?.value, `the Resources of page ${label(page.reference)}`);
  const inline = (changed: PdfDictionaryEntries): void => {
    setOnPage({ kind: 'dictionary', entries: changed });
  };
  if (found === undefined || found.inherited || reference === undefined) return { entries, store: inline };
  if (sharedWithOtherPages(context, page, { reference })) {
    return {
      entries,
      store: changed => {
        setOnPage(objects.add({ kind: 'dictionary', entries: changed }));
      },
    };
  }
  return {
    entries,
    store: changed => {
      objects.set(reference, { kind: 'dictionary', entries: changed });
    },
  };
};

export interface ResourceAddition {
  readonly category: ResourceCategory;
  readonly name: Uint8Array;
  readonly value: PdfDirectObject;
}

/** Adds named resources to a page; only the page, its own resources, or copies of shared ones change. */
export const addPageResources = (context: ResourceContext, page: PageEntry, additions: readonly ResourceAddition[]): void => {
  if (additions.length === 0) return;
  const { objects } = context;
  const resources = pageResourcesTarget(context, page);
  let resourcesChanged = false;
  for (const category of new Set(additions.map(addition => addition.category))) {
    const categoryKey = pdfName(category).bytes;
    const current = resources.entries.get(categoryKey);
    const entries = asDictionary(objects, current, `the ${category} resources of page ${label(page.reference)}`);
    for (const addition of additions) if (addition.category === category) entries.set(addition.name, addition.value);
    const changed = { kind: 'dictionary', entries } as const;
    // A category object that no other page reaches changes in place, and the resources dictionary that names it stays as it is.
    if (current?.kind === 'reference' && !sharedWithOtherPages(context, page, { reference: current, category: categoryKey })) objects.set(current, changed);
    else {
      resources.entries.set(categoryKey, current?.kind === 'reference' ? objects.add(changed) : changed);
      resourcesChanged = true;
    }
  }
  if (resourcesChanged) resources.store(resources.entries);
};

/** Names already used in a category of the page's effective resources. */
export const takenNames = (context: ResourceContext, page: PageEntry, category: ResourceCategory): PdfDictionaryEntries => {
  const found = resourcesEntry(context.objects, page);
  const resources = context.objects.deref(found?.value);
  if (resources?.kind !== 'dictionary') return parsedDictionaryEntries([]);
  return asDictionary(context.objects, resources.entries.get(pdfName(category).bytes), `the ${category} resources of page ${label(page.reference)}`);
};

/** Adds a resource under a name unused in its category and returns the name's bytes. */
export const addPageResource = (
  context: ResourceContext,
  page: PageEntry,
  request: { category: ResourceCategory; value: PdfObject; prefix?: string },
): Uint8Array => {
  const name = freeName(takenNames(context, page, request.category), request.prefix ?? DEFAULT_PREFIXES[request.category]);
  // ISO 32000-1:2008, 7.3.8.1: "All streams shall be indirect objects".
  const value = request.value.kind === 'stream' ? context.objects.add(request.value) : request.value;
  addPageResources(context, page, [{ category: request.category, name, value }]);
  return name;
};

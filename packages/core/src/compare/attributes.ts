import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { PdfDifference, ValuePath, ValueSummary } from './pdfDifference.ts';
import type { Owner } from './pieceInfo.ts';

import { pdfName } from '../object/pdfObject.ts';
import { originalValue } from '../save/originalValue.ts';

import { ValueGraph } from './valueGraph.ts';

interface Sides {
  readonly a: DocumentInternals;
  readonly b: DocumentInternals;
}

const ROOT = pdfName('Root').bytes;
const INFO = pdfName('Info').bytes;
const XOBJECT = pdfName('XObject').bytes;
const RESOURCES = pdfName('Resources').bytes;
const SUBTYPE = pdfName('Subtype').bytes;

// Page entries compared elsewhere: the tree link, content, resources, boxes and page-piece data.
const PAGE_COMPARED_ELSEWHERE = new Set([
  'Parent',
  'Contents',
  'Resources',
  'MediaBox',
  'CropBox',
  'BleedBox',
  'TrimBox',
  'ArtBox',
  'Rotate',
  'UserUnit',
  'PieceInfo',
  'LastModified',
]);
const CATALOG_COMPARED_ELSEWHERE = new Set(['Pages', 'PieceInfo', 'LastModified']);

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const dictionaryOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

export const pageDictionary = (document: DocumentInternals, page: PageEntry): PdfDictionaryEntries | undefined =>
  dictionaryOf(document.objects.resolve(page.reference.objectNumber, page.reference.generation));

export const catalogReference = (document: DocumentInternals): PdfReference | undefined => {
  const root = document.structure.trailer.get(ROOT);
  return root?.kind === 'reference' ? root : undefined;
};

export const catalogDictionary = (document: DocumentInternals): PdfDictionaryEntries | undefined => {
  const root = catalogReference(document);
  return root === undefined ? undefined : dictionaryOf(document.objects.resolve(root.objectNumber, root.generation));
};

interface Summaries {
  readonly a: ValueSummary;
  readonly b: ValueSummary;
}

const graph = (sides: Sides, differences: PdfDifference[], push: (path: ValuePath, summaries: Summaries) => void): ValueGraph =>
  new ValueGraph(sides, {
    mismatch: ({ path, a, b }) => {
      push(path, { a, b });
    },
    undecodable: (where, document, reason) => {
      differences.push({ kind: 'undecodable', where, document, reason });
    },
  });

/** Compares the page entries no other area covers (ISO 32000-1:2008, 7.7.3.3, Table 30), such as Group, Annots, Metadata or SeparationInfo. */
export const comparePageAttributes = (
  sides: Sides,
  pages: { readonly page: number; readonly a: PageEntry; readonly b: PageEntry },
  differences: PdfDifference[],
): void => {
  const left = pageDictionary(sides.a, pages.a);
  const right = pageDictionary(sides.b, pages.b);
  if (left === undefined || right === undefined) return;
  graph(sides, differences, (path, { a, b }) => {
    differences.push({ kind: 'page-attribute', page: pages.page, path, a, b });
  }).entries({ left, right, path: [], skip: PAGE_COMPARED_ELSEWHERE });
};

/** Compares the catalog, apart from the page tree and page-piece data, and the document information dictionary (ISO 32000-1:2008, 7.7.2 and 14.3.3). */
export const compareDocumentAttributes = (sides: Sides, differences: PdfDifference[]): void => {
  const push = (path: ValuePath, { a, b }: Summaries): void => {
    differences.push({ kind: 'document-attribute', path, a, b });
  };
  const left = catalogDictionary(sides.a);
  const right = catalogDictionary(sides.b);
  const values = graph(sides, differences, push);
  if (left !== undefined && right !== undefined) values.entries({ left, right, path: ['Root'], skip: CATALOG_COMPARED_ELSEWHERE });
  values.compare(sides.a.structure.trailer.get(INFO), sides.b.structure.trailer.get(INFO), ['Info']);
};

const duplicateKeys = (document: DocumentInternals, reference: PdfReference | undefined): Map<string, Uint8Array> => {
  const duplicates = new Map<string, Uint8Array>();
  if (reference === undefined || document.objects.changes.has(reference.objectNumber)) return duplicates;
  const seen = new Set<string>();
  for (const entry of originalValue(document.objects.store, reference.objectNumber, document.maxNesting)?.node.entries ?? []) {
    const key = latin1(entry.key);
    if (seen.has(key)) duplicates.set(key, entry.key);
    seen.add(key);
  }
  return duplicates;
};

/**
 * Reports a key that one document's dictionary holds more than once and the other's does not: readers disagree about which value such a key has, so an edit that settled it changed what some readers show.
 * ISO 32000-1:2008, 7.3.7: "Multiple entries in the same dictionary shall not have the same key."
 */
export const compareDuplicateKeys = (
  sides: Sides,
  objects: { readonly where: ValuePath; readonly a: PdfReference | undefined; readonly b: PdfReference | undefined },
  differences: PdfDifference[],
): void => {
  const left = duplicateKeys(sides.a, objects.a);
  const right = duplicateKeys(sides.b, objects.b);
  for (const [name, key] of left) if (!right.has(name)) differences.push({ kind: 'ambiguous-duplicate-key', where: objects.where, key, document: 'a' });
  for (const [name, key] of right) if (!left.has(name)) differences.push({ kind: 'ambiguous-duplicate-key', where: objects.where, key, document: 'b' });
};

const isForm = (document: DocumentInternals, value: PdfDirectObject | undefined): PdfDictionaryEntries | undefined => {
  const resolved = document.objects.deref(value);
  const subtype = resolved?.kind === 'stream' ? resolved.dictionary.get(SUBTYPE) : undefined;
  return resolved?.kind === 'stream' && subtype?.kind === 'name' && latin1(subtype.bytes) === 'Form' ? resolved.dictionary : undefined;
};

const xObjects = (document: DocumentInternals, resources: PdfDirectObject | undefined): PdfDictionaryEntries | undefined => {
  const dictionary = dictionaryOf(document.objects.deref(resources));
  return dictionaryOf(document.objects.deref(dictionary?.get(XOBJECT)));
};

/** Form XObjects present under the same resource name in both documents, recursively through their own resources, as owners of page-piece data. */
export const formOwners = (
  sides: Sides,
  start: { readonly page: number; readonly a: PdfDirectObject | undefined; readonly b: PdfDirectObject | undefined },
): Owner[] => {
  const owners: Owner[] = [];
  const visited = new Set<string>();
  const walk = (resourcesA: PdfDirectObject | undefined, resourcesB: PdfDirectObject | undefined, path: ValuePath): void => {
    const formsA = xObjects(sides.a, resourcesA);
    const formsB = xObjects(sides.b, resourcesB);
    for (const [key, valueA] of formsA?.entries() ?? []) {
      const valueB = formsB?.get(key);
      const formA = isForm(sides.a, valueA);
      const formB = isForm(sides.b, valueB);
      const pair = `${JSON.stringify(valueA)}|${JSON.stringify(valueB)}`;
      if (formA === undefined || formB === undefined || visited.has(pair)) continue;
      visited.add(pair);
      const formPath = [...path, 'XObject', latin1(key)];
      owners.push({
        owner: { kind: 'form', page: start.page, path: formPath },
        a: formA,
        b: formB,
        referenceA: valueA.kind === 'reference' ? valueA : undefined,
        referenceB: valueB?.kind === 'reference' ? valueB : undefined,
      });
      walk(formA.get(RESOURCES), formB.get(RESOURCES), [...formPath, 'Resources']);
    }
  };
  walk(start.a, start.b, ['Resources']);
  return owners;
};

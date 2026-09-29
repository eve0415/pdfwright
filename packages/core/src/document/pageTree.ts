import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { ObjectStore } from './objectStore.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { pdfName } from '../object/pdfObject.ts';

/** A page tree node and the node above it; nodes are shared, so a deep tree costs one link per node. */
export interface TreeNode {
  readonly reference: PdfReference;
  readonly parent: TreeNode | undefined;
}

export interface PageEntry {
  readonly reference: PdfReference;
  /** The page tree node the page sits under. */
  readonly parent: TreeNode | undefined;
}

/** The page tree nodes above a page, nearest first. */
export const ancestorsOf = (entry: PageEntry): PdfReference[] => {
  const ancestors: PdfReference[] = [];
  for (let node = entry.parent; node !== undefined; node = node.parent) ancestors.push(node.reference);
  return ancestors;
};

export interface PageTreeOptions {
  readonly pageCountMismatch: 'error' | 'use-leaves';
  readonly maxPageTreeDepth: number;
  readonly warn: (warning: LoadWarning) => void;
}

const TYPE = pdfName('Type').bytes;
const KIDS = pdfName('Kids').bytes;
const COUNT = pdfName('Count').bytes;

const typeOf = (entries: PdfDictionaryEntries): string => {
  const type = entries.get(TYPE);
  if (type?.kind === 'name') {
    let text = '';
    for (const byte of type.bytes) text += String.fromCodePoint(byte);
    return text;
  }
  // A node without Type is read as a page tree node when it has Kids, and as a page otherwise.
  return entries.has(KIDS) ? 'Pages' : 'Page';
};

const label = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)} R`;

type PendingNode = PageEntry & { readonly depth: number };

const nodeOf = (store: ObjectStore, reference: PdfDirectObject | undefined, parent: string): PdfDictionaryEntries => {
  // ISO 32000-1:2008, 7.7.3.2, Table 29, Kids: "An array of indirect references to the immediate children of this node. The children shall only be page objects or other page tree nodes."
  if (reference?.kind !== 'reference') throw new ParseError(`page tree node ${parent} has a kid that is not an indirect reference`, 0);
  const value = store.resolve(reference.objectNumber, reference.generation);
  if (value.kind !== 'dictionary') {
    throw new ParseError(`page tree node ${parent} has kid ${label(reference)}, which is ${value.kind === 'null' ? 'missing' : `a ${value.kind}`}`, 0);
  }
  return value.entries;
};

// Table 29, Count: "The number of leaf nodes (page objects) that are descendants of this node". Readers disagree when it does not match, so the mismatch is an error unless the leaves are accepted.
const checkCount = (declared: PdfObject | undefined, leaves: number, options: PageTreeOptions): void => {
  if (declared?.kind === 'integer' && declared.value === leaves) return;
  const detail = `the page tree root declares Count ${declared?.kind === 'integer' ? String(declared.value) : 'without a valid value'} but has ${String(leaves)} pages`;
  if (options.pageCountMismatch === 'error') throw new ParseError(`${detail}; pass pageCountMismatch: 'use-leaves' to use the pages found`, 0);
  options.warn({ code: 'page-count-mismatch', detail });
};

/**
 * Lists the pages of the page tree rooted at `root`, in order, with each page's ancestors for attribute inheritance.
 * A kid that is missing or not a page or page tree node throws ParseError instead of being skipped, as does a cycle.
 * ISO 32000-1:2008, 7.7.3.1: "Conforming products shall be prepared to handle any form of tree structure built of such nodes."
 */
export const enumeratePages = (store: ObjectStore, root: PdfDirectObject | undefined, options: PageTreeOptions): PageEntry[] => {
  if (root?.kind !== 'reference') throw new ParseError('the document catalog has no Pages reference', 0);
  const rootNode = nodeOf(store, root, 'catalog');
  if (typeOf(rootNode) !== 'Pages') throw new ParseError(`the page tree root ${label(root)} is not a page tree node`, 0);
  const pages: PageEntry[] = [];
  const visited = new Set<number>();
  const stack: PendingNode[] = [{ reference: root, parent: undefined, depth: 1 }];
  while (stack.length > 0) {
    const { reference, parent, depth } = stack.pop() ?? { reference: root, parent: undefined, depth: 1 };
    if (depth > options.maxPageTreeDepth) throw new ResourceLimitError(`page tree exceeds maxPageTreeDepth (${String(options.maxPageTreeDepth)})`);
    if (visited.has(reference.objectNumber)) throw new ParseError(`the page tree reaches ${label(reference)} twice`, 0);
    visited.add(reference.objectNumber);
    const node = nodeOf(store, reference, parent === undefined ? 'catalog' : label(parent.reference));
    const type = typeOf(node);
    if (type === 'Page') {
      pages.push({ reference, parent });
      continue;
    }
    if (type !== 'Pages') throw new ParseError(`page tree node ${label(reference)} has Type ${type}, neither Page nor Pages`, 0);
    const kids = store.deref(node.get(KIDS));
    if (kids?.kind !== 'array') throw new ParseError(`page tree node ${label(reference)} has no Kids array`, 0);
    const below: TreeNode = { reference, parent };
    for (let index = kids.items.length - 1; index >= 0; index--) {
      const kid = kids.items[index];
      if (kid?.kind !== 'reference') throw new ParseError(`page tree node ${label(reference)} has a kid that is not an indirect reference`, 0);
      stack.push({ reference: kid, parent: below, depth: depth + 1 });
    }
  }
  checkCount(store.deref(rootNode.get(COUNT)), pages.length, options);
  return pages;
};

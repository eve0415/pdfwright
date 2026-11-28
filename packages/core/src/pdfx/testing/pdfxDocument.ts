// Edits the catalog and page dictionaries of a loaded document for PDF/X tests.

import type { LoadedDocument } from '../../document/loadDocument.ts';
import type { PdfDictionaryEntries } from '../../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject } from '../../object/pdfObject.ts';

import { pdfName } from '../../object/pdfObject.ts';

/** Sets one entry of the document catalog, which the trailer's Root names. */
export const setCatalogEntry = (document: LoadedDocument, name: string, value: PdfDirectObject): void => {
  const root = document.structure.trailer.get(pdfName('Root').bytes);
  if (root?.kind !== 'reference') {
    throw new Error('the trailer has no Root reference');
  }
  const catalog = document.get(root);
  if (catalog.kind !== 'dictionary') {
    throw new Error('the catalog is not a dictionary');
  }
  catalog.entries.set(pdfName(name).bytes, value);
  document.set(root, catalog);
};

/** The entries of page `index`'s own dictionary, without inherited attributes. */
export const pageDictionary = (document: LoadedDocument, index: number): PdfDictionaryEntries => {
  const page = document.get(document.page(index).reference);
  if (page.kind !== 'dictionary') {
    throw new Error('the page is not a dictionary');
  }
  return page.entries;
};

/** Sets one entry of page `index`'s own dictionary. */
export const setPageEntry = (document: LoadedDocument, index: number, name: string, value: PdfDirectObject): void => {
  const { reference } = document.page(index);
  const page = document.get(reference);
  if (page.kind !== 'dictionary') {
    throw new Error('the page is not a dictionary');
  }
  page.entries.set(pdfName(name).bytes, value);
  document.set(reference, page);
};

// Test support: reads a saved file back the way a reader of it would, one object at a time, so that a test can say which object an entry sits on.

import type { PdfObject } from '../object/pdfObject.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { LoadedDocument } from './loadDocument.ts';

import { inflateZlib } from '../flate/inflate.ts';
import { pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';

/** Loads the bytes a save wrote. */
export const reload = (saved: SavedPdf): LoadedDocument => loadDocument(saved.chunks);

/** The value itself, or the object a reference points at. */
export const resolved = (document: LoadedDocument, value: PdfObject | undefined): PdfObject => {
  if (value === undefined) {
    throw new Error('the entry is absent');
  }
  return value.kind === 'reference' ? document.get(value) : value;
};

/** An entry of a dictionary or stream dictionary, with a reference followed. */
export const entry = (document: LoadedDocument, value: PdfObject, key: string): PdfObject => {
  const entries = value.kind === 'stream' ? value.dictionary : value.kind === 'dictionary' ? value.entries : undefined;
  if (entries === undefined) {
    throw new Error(`a ${value.kind} has no ${key} entry`);
  }
  return resolved(document, entries.get(pdfName(key).bytes));
};

/** The keys of a dictionary or stream dictionary, in file order. */
export const keys = (value: PdfObject): Array<string> => {
  const entries = value.kind === 'stream' ? value.dictionary : value.kind === 'dictionary' ? value.entries : undefined;
  return [...(entries?.entries() ?? [])].map(([key]) => latin1Text(key));
};

/** The object written as PDF syntax, with a stream's dictionary only. */
export const objectText = (value: PdfObject): string =>
  latin1Text(serializeObject(value.kind === 'stream' ? { kind: 'dictionary', entries: value.dictionary } : value, { fractionDigits: 5 }));

/** A stream's data, inflated when its Filter is FlateDecode; any other Filter is refused rather than returned encoded. */
export const streamBytes = (value: PdfObject): Uint8Array => {
  if (value.kind !== 'stream') {
    throw new Error(`a ${value.kind} has no stream data`);
  }
  const filter = value.dictionary.get(pdfName('Filter').bytes);
  if (filter === undefined) {
    return value.data;
  }
  // ISO 32000-1:2008, 7.4.4: FlateDecode is the zlib/deflate filter.
  if (filter.kind === 'name' && latin1Text(filter.bytes) === 'FlateDecode') {
    return inflateZlib(value.data).data;
  }
  throw new Error(`a stream with Filter ${objectText(filter)} is not FlateDecode`);
};

/** The resource a page's content names, from the page's effective Resources. */
export const pageResource = (document: LoadedDocument, page: number, category: string, name: string): PdfObject => {
  const resources = document.page(page).resources();
  return entry(document, resolved(document, resources.get(pdfName(category).bytes)), name);
};

/** A page's Contents, its streams decoded and concatenated. */
export const pageContent = (document: LoadedDocument, page: number): string => {
  const contents = entry(document, document.get(document.page(page).reference), 'Contents');
  const streams = contents.kind === 'array' ? contents.items.map(item => resolved(document, item)) : [contents];
  return streams.map(stream => latin1Text(streamBytes(stream))).join('');
};

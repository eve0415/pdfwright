// Composes pages, content streams and resources on top of pdfBuilder.ts for content interpretation and text tests.

import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from './pdfBuilder.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';

import { buildPdf, streamBody } from './pdfBuilder.ts';

export interface TestPage {
  /** One content stream, or the streams of a Contents array; omitted, the page has no Contents entry of its own making. */
  readonly content?: string | readonly string[];
  /** The entries of the page's Resources dictionary, without the delimiters; omitted, the page has no Resources. */
  readonly resources?: string;
  /** Further page dictionary entries, such as "/Annots[20 0 R]". */
  readonly entries?: string;
}

export interface TextPdf {
  readonly pages: readonly TestPage[];
  /** Objects the pages refer to, numbered from 100 so that they do not collide with the pages and their contents. */
  readonly objects?: readonly TestObject[];
  /** Entries of the page tree root, such as inherited Resources. */
  readonly root?: string;
  /** Further entries of the document catalog, such as OCProperties. */
  readonly catalog?: string;
}

/** The bytes of a PDF whose pages are 600 by 800 points: the catalog is object 1, the page tree 2, and each page and its content streams follow from 3. */
export const textPdfBytes = ({ pages, objects = [], root = '', catalog = '' }: TextPdf): Uint8Array => {
  const built: TestObject[] = [];
  let next = 3;
  const kids: number[] = [];
  for (const page of pages) {
    const number = next++;
    kids.push(number);
    const streams = typeof page.content === 'string' ? [page.content] : page.content;
    const contents: string[] = [];
    for (const data of streams ?? []) {
      built.push({ number: next, body: streamBody('', data) });
      contents.push(`${String(next++)} 0 R`);
    }
    const contentsEntry = streams === undefined ? '' : `/Contents[${contents.join(' ')}]`;
    const resources = page.resources === undefined ? '' : `/Resources<<${page.resources}>>`;
    built.push({ number, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]${contentsEntry}${resources}${page.entries ?? ''}>>` });
  }
  const tree = `<</Type/Pages/Kids[${kids.map(kid => `${String(kid)} 0 R`).join(' ')}]/Count ${String(kids.length)}${root}>>`;
  return buildPdf([
    {
      xref: 'classic',
      objects: [{ number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` }, { number: 2, body: tree }, ...built, ...objects],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;
};

/** Loads a composed PDF and returns what the library reads from it. */
export const textPdf = (input: TextPdf): DocumentInternals => {
  const parts = internalsOf(loadDocument(textPdfBytes(input)));
  if (parts === undefined) throw new Error('the document has no internals');
  return parts;
};

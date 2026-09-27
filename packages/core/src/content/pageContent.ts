import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PageEntry } from '../document/pageTree.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { decodedData } from '../font/fontValues.ts';
import { pdfName } from '../object/pdfObject.ts';

const CONTENTS = pdfName('Contents').bytes;

/** A page's decoded content streams, and why any of them could not be read. */
export interface PageContent {
  readonly streams: readonly Uint8Array[];
  /** The index in the Contents array of each stream read. */
  readonly indexes: readonly number[];
  readonly problems: readonly string[];
}

const label = (index: number): string => `content stream ${String(index)}`;

/**
 * Decodes the streams of a page's Contents entry, a stream or an array of streams (ISO 32000-1:2008, 7.7.3.3, Table 30), in order.
 * A stream that cannot be decoded is left out and reported; together the streams are held under the document's maxDecodedBytes, past which ResourceLimitError is thrown.
 */
export const pageContent = (document: DocumentInternals, page: PageEntry): PageContent => {
  const problems: string[] = [];
  const streams: Uint8Array[] = [];
  const indexes: number[] = [];
  try {
    const dictionary = document.objects.resolve(page.reference.objectNumber, page.reference.generation);
    const contents = dictionary.kind === 'dictionary' ? document.objects.deref(dictionary.entries.get(CONTENTS)) : undefined;
    const items = contents?.kind === 'array' ? contents.items : [dictionary.kind === 'dictionary' ? dictionary.entries.get(CONTENTS) : undefined];
    let total = 0;
    for (const [index, item] of items.entries()) {
      const stream = document.objects.deref(item);
      // 7.3.10: a reference to a missing object is a reference to null, which contributes no content.
      if (stream === undefined || stream.kind === 'null') continue;
      const data = stream.kind === 'stream' ? decodedData(document, stream) : `${label(index)} is not a stream`;
      if (typeof data === 'string') {
        problems.push(`${label(index)} cannot be read: ${data}`);
        continue;
      }
      total += data.length;
      if (total > document.maxDecodedBytes) {
        throw new ResourceLimitError(`the content of a page decodes to more than maxDecodedBytes (${String(document.maxDecodedBytes)} bytes)`);
      }
      streams.push(data);
      indexes.push(index);
    }
  } catch (error: unknown) {
    if (!(error instanceof ParseError)) throw error;
    problems.push(`the page's Contents cannot be read: ${error.message}`);
  }
  return { streams, indexes, problems };
};

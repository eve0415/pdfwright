import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfName, pdfNameFromBytes } from '../object/pdfObject.ts';

/** Optional opaque `/Private` application value in a page-piece entry under ISO 32000-1:2008, 14.5, Table 319; the library keeps its bytes and structure unchanged. */
export interface PieceData {
  private?: PdfDirectObject;
}

/** Application names mapped to `PieceData`, as strings or raw PDF name bytes; names obey the 127-byte and no-null bounds of ISO 32000-1:2008, 7.3.5 and 14.5. */
export type PieceDataEntries = Record<string, PieceData> | ReadonlyMap<string | Uint8Array, PieceData>;

/** Page or form application data and its required caller-supplied LastModified date under ISO 32000-1:2008, 14.5, Tables 318–319. */
export interface PieceInfoInput {
  lastModified: PdfDate;
  data: PieceDataEntries;
}

/** Application data for document-level page-piece writing; its names and private values follow ISO 32000-1:2008, 14.5, Tables 318–319. */
export interface DocumentPieceInfoInput {
  data: PieceDataEntries;
}

export interface PieceInfoRecord {
  lastModified: PdfDate;
  value: PdfDirectObject;
}

const isDataMap = (data: PieceDataEntries): data is ReadonlyMap<string | Uint8Array, PieceData> => data instanceof Map;

const dataEntries = (data: PieceDataEntries): [string | Uint8Array, PieceData][] => (isDataMap(data) ? [...data.entries()] : Object.entries(data));

// ISO 32000-1:2008, 14.5, Tables 318 and 319 require a LastModified date in each application data dictionary.
export const pieceInfoRecord = (lastModified: PdfDate, data: PieceDataEntries): PieceInfoRecord => {
  const entries = new PdfDictionaryEntries();
  for (const [app, appData] of dataEntries(data)) {
    const name = pdfNameFromBytes(typeof app === 'string' ? new TextEncoder().encode(app) : app);
    const dictionary = new PdfDictionaryEntries([[pdfName('LastModified').bytes, pdfDateObject(lastModified)]]);
    if (appData.private !== undefined) dictionary.set(pdfName('Private').bytes, appData.private);
    entries.set(name.bytes, pdfDictionary(dictionary));
  }
  return { lastModified, value: pdfDictionary(entries) };
};

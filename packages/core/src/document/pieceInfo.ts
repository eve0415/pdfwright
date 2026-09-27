import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfName, pdfNameFromBytes } from '../object/pdfObject.ts';

export interface PieceData {
  private?: PdfDirectObject;
}

export type PieceDataEntries = Record<string, PieceData> | ReadonlyMap<string | Uint8Array, PieceData>;

export interface PieceInfoInput {
  lastModified: PdfDate;
  data: PieceDataEntries;
}

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

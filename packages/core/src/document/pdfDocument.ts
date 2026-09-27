import type { Length } from '../length/length.ts';
import type { IndirectObject } from '../write/writeDocument.ts';

import { formatLength } from '../length/length.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { writeDocument } from '../write/writeDocument.ts';

export interface DocumentOptions {
  fractionDigits?: number;
  fileIdentifier?: [Uint8Array, Uint8Array];
}

export interface PageOptions {
  mediaBox: [Length, Length, Length, Length];
}

export interface PdfDocument {
  addPage: (options: PageOptions) => void;
  save: () => Uint8Array;
}

const pointObject = (length: Length, fractionDigits: number): ReturnType<typeof pdfReal> => pdfReal(Number(formatLength(length, fractionDigits)));

export const createDocument = (options: DocumentOptions = {}): PdfDocument => {
  const pages: [Length, Length, Length, Length][] = [];
  const fractionDigits = options.fractionDigits ?? DEFAULT_FRACTION_DIGITS;

  return {
    addPage: (page: PageOptions): void => {
      pages.push([...page.mediaBox]);
    },
    save: (): Uint8Array => {
      const catalog = new PdfDictionaryEntries([
        [pdfName('Type').bytes, pdfName('Catalog')],
        [pdfName('Pages').bytes, pdfReference(2, 0)],
      ]);
      const kids = pages.map((_, index) => pdfReference(index + 3, 0));
      const pageTree = new PdfDictionaryEntries([
        [pdfName('Type').bytes, pdfName('Pages')],
        [pdfName('Kids').bytes, pdfArray(kids)],
        [pdfName('Count').bytes, pdfInteger(pages.length)],
        [pdfName('Resources').bytes, pdfDictionary()],
      ]);
      const objects: IndirectObject[] = [
        { objectNumber: 1, generation: 0, value: pdfDictionary(catalog) },
        { objectNumber: 2, generation: 0, value: pdfDictionary(pageTree) },
      ];
      for (let index = 0; index < pages.length; index++) {
        const mediaBox = pages[index];
        if (mediaBox === undefined) continue;
        // ISO 32000-1:2008, 7.7.3.3, Table 30 makes MediaBox required and Contents optional; an absent Contents means an empty page.
        const entries = new PdfDictionaryEntries([
          [pdfName('Type').bytes, pdfName('Page')],
          [pdfName('Parent').bytes, pdfReference(2, 0)],
          [pdfName('MediaBox').bytes, pdfArray(mediaBox.map(length => pointObject(length, fractionDigits)))],
        ]);
        objects.push({ objectNumber: index + 3, generation: 0, value: pdfDictionary(entries) });
      }
      const trailer = new PdfDictionaryEntries([[pdfName('Root').bytes, pdfReference(1, 0)]]);
      return writeDocument(objects, trailer, { fractionDigits, version: '1.7', fileIdentifier: options.fileIdentifier });
    },
  };
};

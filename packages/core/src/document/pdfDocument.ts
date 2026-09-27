import type { Length } from '../length/length.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { IndirectObject } from '../write/writeDocument.ts';
import type { PdfRect } from './rect.ts';

import { ValidationError } from '../error/validationError.ts';
import { formatLength } from '../length/length.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { writeDocument } from '../write/writeDocument.ts';

import { rect } from './rect.ts';

export interface DocumentOptions {
  fractionDigits?: number;
  fileIdentifier?: [Uint8Array, Uint8Array];
}

export interface PageOptions {
  mediaBox: PdfRect;
  cropBox?: PdfRect;
  bleedBox?: PdfRect;
  trimBox?: PdfRect;
  artBox?: PdfRect;
}

export interface PdfDocument {
  addPage: (options: PageOptions) => void;
  save: () => SavedPdf;
}

const pointObject = (length: Length, fractionDigits: number): ReturnType<typeof pdfReal> => pdfReal(Number(formatLength(length, fractionDigits)));

const normalize = (box: PdfRect): PdfRect => rect(...box);

const rounded = (box: PdfRect, fractionDigits: number): number[] => box.map(length => Number(formatLength(length, fractionDigits)));

const validateBox = (box: PdfRect, mediaBox: PdfRect, fractionDigits: number): void => {
  const [left, bottom, right, top] = rounded(box, fractionDigits);
  const [mediaLeft, mediaBottom, mediaRight, mediaTop] = rounded(mediaBox, fractionDigits);
  if (
    left === undefined ||
    bottom === undefined ||
    right === undefined ||
    top === undefined ||
    mediaLeft === undefined ||
    mediaBottom === undefined ||
    mediaRight === undefined ||
    mediaTop === undefined
  ) {
    throw new ValidationError('page box has missing coordinates');
  }
  if (left >= right || bottom >= top) throw new ValidationError('page box has zero area after rounding; writer policy requires non-zero area');
  if (left < mediaLeft || bottom < mediaBottom || right > mediaRight || top > mediaTop) {
    throw new ValidationError('page box extends beyond MediaBox; writer policy requires every effective box to fit inside it');
  }
};

export const createDocument = (options: DocumentOptions = {}): PdfDocument => {
  const pages: PageOptions[] = [];
  const fractionDigits = options.fractionDigits ?? DEFAULT_FRACTION_DIGITS;

  return {
    addPage: (page: PageOptions): void => {
      const normalized: PageOptions = { mediaBox: normalize(page.mediaBox) };
      if (page.cropBox !== undefined) normalized.cropBox = normalize(page.cropBox);
      if (page.bleedBox !== undefined) normalized.bleedBox = normalize(page.bleedBox);
      if (page.trimBox !== undefined) normalized.trimBox = normalize(page.trimBox);
      if (page.artBox !== undefined) normalized.artBox = normalize(page.artBox);
      const cropBox = normalized.cropBox ?? normalized.mediaBox;
      for (const box of [normalized.mediaBox, cropBox, normalized.bleedBox ?? cropBox, normalized.trimBox ?? cropBox, normalized.artBox ?? cropBox]) {
        validateBox(box, normalized.mediaBox, fractionDigits);
      }
      pages.push(normalized);
    },
    save: (): SavedPdf => {
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
        const page = pages[index];
        if (page === undefined) continue;
        // ISO 32000-1:2008, 7.7.3.3, Table 30 makes MediaBox required and Contents optional; an absent Contents means an empty page.
        const entries = new PdfDictionaryEntries([
          [pdfName('Type').bytes, pdfName('Page')],
          [pdfName('Parent').bytes, pdfReference(2, 0)],
          [pdfName('MediaBox').bytes, pdfArray(page.mediaBox.map(length => pointObject(length, fractionDigits)))],
        ]);
        for (const [key, box] of [
          ['CropBox', page.cropBox],
          ['BleedBox', page.bleedBox],
          ['TrimBox', page.trimBox],
          ['ArtBox', page.artBox],
        ] as const) {
          if (box !== undefined) entries.set(pdfName(key).bytes, pdfArray(box.map(length => pointObject(length, fractionDigits))));
        }
        objects.push({ objectNumber: index + 3, generation: 0, value: pdfDictionary(entries) });
      }
      const trailer = new PdfDictionaryEntries([[pdfName('Root').bytes, pdfReference(1, 0)]]);
      return writeDocument(objects, trailer, { fractionDigits, version: '1.7', fileIdentifier: options.fileIdentifier });
    },
  };
};

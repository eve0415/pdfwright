import type { Length } from '../length/length.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { IndirectObject } from '../write/writeDocument.ts';
import type { ContentBuilder, GraphicsStateOptions } from './contentBuilder.ts';
import type { PdfRect } from './rect.ts';
import type { Separation, SeparationOptions } from './separation.ts';

import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { formatLength } from '../length/length.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { writeDocument } from '../write/writeDocument.ts';

import { createContentBuilder } from './contentBuilder.ts';
import { rect } from './rect.ts';
import { colorantKey, createSeparation, separationObject } from './separation.ts';

export interface DocumentOptions {
  fractionDigits?: number;
  fileIdentifier?: [Uint8Array, Uint8Array];
  colorantPolicy?: { asciiOnly?: boolean };
}

export interface PageOptions {
  mediaBox: PdfRect;
  cropBox?: PdfRect;
  bleedBox?: PdfRect;
  trimBox?: PdfRect;
  artBox?: PdfRect;
  group?: { colorSpace: 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray' };
}

export interface PdfDocument {
  addPage: (options: PageOptions) => PdfPage;
  separation: (options: SeparationOptions) => Separation;
  save: () => SavedPdf;
}

export interface PdfPage {
  draw: (render: (content: ContentBuilder) => void) => void;
}

interface PageRecord {
  options: PageOptions;
  contents: Uint8Array[];
  graphicsStates: Map<string, { name: string; options: GraphicsStateOptions }>;
  separations: Map<string, { name: string; separation: Separation }>;
}

const graphicsStateDictionary = (options: GraphicsStateOptions): PdfDictionaryEntries => {
  // ISO 32000-1:2008, 8.4.5, Table 58 defines the ExtGState keys and says OP also sets op when op is absent.
  const entries = new PdfDictionaryEntries();
  if (options.strokeAlpha !== undefined) entries.set(pdfName('CA').bytes, pdfReal(options.strokeAlpha));
  if (options.fillAlpha !== undefined) entries.set(pdfName('ca').bytes, pdfReal(options.fillAlpha));
  if (options.blendMode !== undefined) entries.set(pdfName('BM').bytes, pdfName(options.blendMode));
  if (options.overprintStroke !== undefined) entries.set(pdfName('OP').bytes, { kind: 'boolean', value: options.overprintStroke });
  if (options.overprintFill !== undefined) entries.set(pdfName('op').bytes, { kind: 'boolean', value: options.overprintFill });
  if (options.overprintMode !== undefined) entries.set(pdfName('OPM').bytes, pdfInteger(options.overprintMode));
  if (options.softMask !== undefined) entries.set(pdfName('SMask').bytes, pdfName('None'));
  return entries;
};

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
  const pages: PageRecord[] = [];
  const documentSeparations = new Map<string, Separation>();
  const fractionDigits = options.fractionDigits ?? DEFAULT_FRACTION_DIGITS;

  return {
    separation: (separationOptions): Separation => {
      const separation = createSeparation(separationOptions, options.colorantPolicy?.asciiOnly === true);
      const key = colorantKey(separation.name);
      const existing = documentSeparations.get(key);
      if (existing !== undefined) {
        if (JSON.stringify(existing.alternate) !== JSON.stringify(separation.alternate)) {
          throw new ValidationError('the same colorant name cannot use conflicting alternate colours');
        }
        return existing;
      }
      documentSeparations.set(key, separation);
      return separation;
    },
    addPage: (page: PageOptions): PdfPage => {
      const normalized: PageOptions = { mediaBox: normalize(page.mediaBox) };
      if (page.cropBox !== undefined) normalized.cropBox = normalize(page.cropBox);
      if (page.bleedBox !== undefined) normalized.bleedBox = normalize(page.bleedBox);
      if (page.trimBox !== undefined) normalized.trimBox = normalize(page.trimBox);
      if (page.artBox !== undefined) normalized.artBox = normalize(page.artBox);
      if (page.group !== undefined) normalized.group = { ...page.group };
      const cropBox = normalized.cropBox ?? normalized.mediaBox;
      for (const box of [normalized.mediaBox, cropBox, normalized.bleedBox ?? cropBox, normalized.trimBox ?? cropBox, normalized.artBox ?? cropBox]) {
        validateBox(box, normalized.mediaBox, fractionDigits);
      }
      const record: PageRecord = { options: normalized, contents: [], graphicsStates: new Map(), separations: new Map() };
      pages.push(record);
      return {
        draw: (render): void => {
          const content = createContentBuilder(fractionDigits, {
            colorSpace: normalized.group?.colorSpace,
            registerGraphicsState: stateOptions => {
              const key = JSON.stringify([
                stateOptions.fillAlpha,
                stateOptions.strokeAlpha,
                stateOptions.blendMode,
                stateOptions.overprintStroke,
                stateOptions.overprintFill,
                stateOptions.overprintMode,
                stateOptions.softMask,
              ]);
              const existing = record.graphicsStates.get(key);
              if (existing !== undefined) return existing.name;
              const name = `GS${record.graphicsStates.size + 1}`;
              record.graphicsStates.set(key, { name, options: stateOptions });
              return name;
            },
            registerSeparation: separation => {
              const key = colorantKey(separation.name);
              const existing = record.separations.get(key);
              if (existing !== undefined) return existing.name;
              const name = `CS${record.separations.size + 1}`;
              record.separations.set(key, { name, separation });
              return name;
            },
          });
          render(content);
          record.contents.push(content.finish());
        },
      };
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
      let nextContentNumber = pages.length + 3;
      for (let index = 0; index < pages.length; index++) {
        const record = pages[index];
        if (record === undefined) continue;
        const page = record.options;
        // ISO 32000-1:2008, 7.7.3.3, Table 30 makes MediaBox required and Contents optional; an absent Contents means an empty page.
        const entries = new PdfDictionaryEntries([
          [pdfName('Type').bytes, pdfName('Page')],
          [pdfName('Parent').bytes, pdfReference(2, 0)],
          [pdfName('MediaBox').bytes, pdfArray(page.mediaBox.map(length => pointObject(length, fractionDigits)))],
        ]);
        if (page.group !== undefined) {
          // ISO 32000-1:2008, 11.4.7 recommends an explicit blending colour space for a page transparency group.
          const group = new PdfDictionaryEntries([
            [pdfName('S').bytes, pdfName('Transparency')],
            [pdfName('CS').bytes, pdfName(page.group.colorSpace)],
          ]);
          entries.set(pdfName('Group').bytes, pdfDictionary(group));
        }
        if (record.graphicsStates.size > 0 || record.separations.size > 0) {
          const resources = new PdfDictionaryEntries();
          if (record.separations.size > 0) {
            const colorSpaces = new PdfDictionaryEntries();
            for (const space of record.separations.values()) colorSpaces.set(pdfName(space.name).bytes, separationObject(space.separation));
            resources.set(pdfName('ColorSpace').bytes, pdfDictionary(colorSpaces));
          }
          if (record.graphicsStates.size > 0) {
            const gsEntries = new PdfDictionaryEntries();
            for (const state of record.graphicsStates.values()) gsEntries.set(pdfName(state.name).bytes, pdfDictionary(graphicsStateDictionary(state.options)));
            resources.set(pdfName('ExtGState').bytes, pdfDictionary(gsEntries));
          }
          entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
        }
        for (const [key, box] of [
          ['CropBox', page.cropBox],
          ['BleedBox', page.bleedBox],
          ['TrimBox', page.trimBox],
          ['ArtBox', page.artBox],
        ] as const) {
          if (box !== undefined) entries.set(pdfName(key).bytes, pdfArray(box.map(length => pointObject(length, fractionDigits))));
        }
        const contentStart = nextContentNumber;
        const contentReferences = record.contents.map((_, contentIndex) => pdfReference(contentStart + contentIndex, 0));
        nextContentNumber += contentReferences.length;
        if (contentReferences.length === 1) {
          const [contentReference] = contentReferences;
          if (contentReference !== undefined) entries.set(pdfName('Contents').bytes, contentReference);
        } else if (contentReferences.length > 1) entries.set(pdfName('Contents').bytes, pdfArray(contentReferences));
        objects.push({ objectNumber: index + 3, generation: 0, value: pdfDictionary(entries) });
      }
      for (const record of pages) {
        for (const data of record.contents) {
          // ISO 32000-1:2008, 7.4.4 identifies FlateDecode as the stream filter for zlib-compressed data.
          const dictionary = new PdfDictionaryEntries([[pdfName('Filter').bytes, pdfName('FlateDecode')]]);
          objects.push({ objectNumber: objects.length + 1, generation: 0, value: { kind: 'stream', dictionary, data: deflateZlib(data) } });
        }
      }
      const trailer = new PdfDictionaryEntries([[pdfName('Root').bytes, pdfReference(1, 0)]]);
      return writeDocument(objects, trailer, { fractionDigits, version: '1.7', fileIdentifier: options.fileIdentifier });
    },
  };
};

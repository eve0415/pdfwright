import type { CreatedMetadataOptions } from '../metadata/createdMetadata.ts';
import type { DocumentInfo } from '../metadata/documentInfo.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { BufferedSavedPdf } from '../write/savedPdf.ts';
import type { IndirectObject } from '../write/writeDocument.ts';
import type { ContentBuilder } from './contentBuilder.ts';
import type { GroupOptions, PdfGroup } from './group.ts';
import type { ImageOptions, ImageRecord, PdfImage } from './image.ts';
import type { DocumentPieceInfoInput, PieceInfoInput, PieceInfoRecord } from './pieceInfo.ts';
import type { PdfRect } from './rect.ts';
import type { GroupRecord, ImageObjectNumbers, ResourceNumbers, ResourceRecord } from './resourceRecord.ts';
import type { Separation, SeparationOptions } from './separation.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { formatLength } from '../length/length.ts';
import { createdPacket, validateCreatedMetadata } from '../metadata/createdMetadata.ts';
import { documentInfoDictionary } from '../metadata/documentInfo.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { writeDocument } from '../write/writeDocument.ts';

import { createContentBuilder } from './contentBuilder.ts';
import { createDocumentHandles } from './documentHandles.ts';
import { groupObject } from './group.ts';
import { imageObject, softMaskObject } from './image.ts';
import { pieceInfoRecord } from './pieceInfo.ts';
import { rect } from './rect.ts';
import { createContentHooks, createResourceRecord, resourceDictionary } from './resourceRecord.ts';

export interface DocumentOptions {
  /** Decimal places for newly written reals; defaults to five. */
  fractionDigits?: number;
  /** Two file identifier byte strings written to the trailer. */
  fileIdentifier?: [Uint8Array, Uint8Array];
  /** Whether new colorant names must use printable ASCII bytes. */
  colorantPolicy?: { asciiOnly?: boolean };
  /** Information dictionary values for the new PDF. */
  info?: DocumentInfo;
  /** Info writes an agreeing XMP packet by default; { xmp: false } opts out. An XMP packet requires info.modificationDate. */
  metadata?: CreatedMetadataOptions | { xmp: false };
}

export interface PageOptions {
  /** Required page boundary rectangle. */
  mediaBox: PdfRect;
  /** Optional visible page boundary. */
  cropBox?: PdfRect;
  /** Optional bleed boundary. */
  bleedBox?: PdfRect;
  /** Optional finished-page boundary. */
  trimBox?: PdfRect;
  /** Optional artwork boundary. */
  artBox?: PdfRect;
  /** Page transparency group and its compositing colour space. */
  group?: { colorSpace: 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray' };
}

export interface PdfDocument {
  addPage: (options: PageOptions) => PdfPage;
  separation: (options: SeparationOptions) => Separation;
  image: (options: ImageOptions) => PdfImage;
  group: (options: GroupOptions, render: (content: ContentBuilder) => void) => PdfGroup;
  object: (value: PdfObject) => PdfReference;
  pieceInfo: (input: DocumentPieceInfoInput) => void;
  save: () => BufferedSavedPdf;
}

export interface PdfPage {
  draw: (render: (content: ContentBuilder) => void) => void;
  pieceInfo: (input: PieceInfoInput) => void;
}

interface PageBuildContext {
  fractionDigits: number;
  contentStart: number;
  resourceNumbers: ResourceNumbers;
}

interface PageRecord extends ResourceRecord {
  options: PageOptions;
  contents: Uint8Array[];
  pieceInfo?: PieceInfoRecord;
}

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

export const isolateContent = (data: Uint8Array): Uint8Array => {
  // ISO 32000-1:2008, 8.4.2 defines q and Q as saving and restoring the entire graphics state.
  const isolated = new Uint8Array(data.length + 4);
  isolated.set([0x71, 0x0a], 0);
  isolated.set(data, 2);
  isolated.set([0x51, 0x0a], data.length + 2);
  return isolated;
};

const allocateImageNumbers = (images: readonly ImageRecord[], firstNumber: number): Map<ImageRecord, ImageObjectNumbers> => {
  let nextNumber = firstNumber;
  const numbersByImage = new Map<ImageRecord, ImageObjectNumbers>();
  for (const image of images) {
    const numbers: ImageObjectNumbers = { parent: nextNumber };
    if (image.softMask !== undefined) {
      numbers.mask = nextNumber++;
      numbers.parent = nextNumber;
    }
    nextNumber++;
    numbersByImage.set(image, numbers);
  }
  return numbersByImage;
};

const allocateGroupNumbers = (groups: readonly GroupRecord[], firstNumber: number): Map<GroupRecord, number> => {
  let nextNumber = firstNumber;
  const numbers = new Map<GroupRecord, number>();
  for (const group of groups) numbers.set(group, nextNumber++);
  return numbers;
};

const pageObject = (record: PageRecord, context: PageBuildContext): PdfDirectObject => {
  const page = record.options;
  // ISO 32000-1:2008, 7.7.3.3, Table 30 makes MediaBox required and Contents optional; an absent Contents means an empty page.
  const entries = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('Page')],
    [pdfName('Parent').bytes, pdfReference(2, 0)],
    [pdfName('MediaBox').bytes, pdfArray(page.mediaBox.map(length => pdfReal(length)))],
  ]);
  if (record.pieceInfo !== undefined) {
    // ISO 32000-1:2008, 7.7.3.3, Table 30 requires page LastModified when PieceInfo is present.
    entries.set(pdfName('LastModified').bytes, pdfDateObject(record.pieceInfo.lastModified));
    entries.set(pdfName('PieceInfo').bytes, record.pieceInfo.value);
  }
  if (page.group !== undefined) {
    // ISO 32000-1:2008, 11.4.7 recommends an explicit blending colour space for a page transparency group.
    const group = new PdfDictionaryEntries([
      [pdfName('S').bytes, pdfName('Transparency')],
      [pdfName('CS').bytes, pdfName(page.group.colorSpace)],
    ]);
    entries.set(pdfName('Group').bytes, pdfDictionary(group));
  }
  const resources = resourceDictionary(record, context.resourceNumbers);
  if (resources !== undefined) entries.set(pdfName('Resources').bytes, resources);
  for (const [key, box] of [
    ['CropBox', page.cropBox],
    ['BleedBox', page.bleedBox],
    ['TrimBox', page.trimBox],
    ['ArtBox', page.artBox],
  ] as const) {
    if (box !== undefined) entries.set(pdfName(key).bytes, pdfArray(box.map(length => pdfReal(length))));
  }
  const references = record.contents.map((_, index) => pdfReference(context.contentStart + index, 0));
  if (references.length === 1) {
    const [reference] = references;
    if (reference !== undefined) entries.set(pdfName('Contents').bytes, reference);
  } else if (references.length > 1) entries.set(pdfName('Contents').bytes, pdfArray(references));
  return pdfDictionary(entries);
};

/** Creates a new PDF document with pages and resources supplied by the caller. */
export const createDocument = (options: DocumentOptions = {}): PdfDocument => {
  const metadata = options.metadata ?? (options.info === undefined ? undefined : ({ xmp: true } as const));
  if (metadata?.xmp === true) validateCreatedMetadata(options.info, metadata);
  const pages: PageRecord[] = [];
  const callerObjects: PdfObject[] = [];
  let documentPieceInfo: PieceInfoRecord | undefined = undefined;
  const fractionDigits = options.fractionDigits ?? DEFAULT_FRACTION_DIGITS;
  const handles = createDocumentHandles({ fractionDigits, asciiOnlyColorants: options.colorantPolicy?.asciiOnly === true });
  const { records, images, groups } = handles;

  return {
    object: (value): PdfReference => {
      const reference = pdfReference(callerObjects.length + 3, 0);
      callerObjects.push(value);
      return reference;
    },
    pieceInfo: (input): void => {
      const modificationDate = options.info?.modificationDate;
      if (modificationDate === undefined) throw new ValidationError('document PieceInfo requires info.modificationDate');
      documentPieceInfo = pieceInfoRecord(modificationDate, input.data);
    },
    group: handles.group,
    image: handles.image,
    separation: handles.separation,
    addPage: (page: PageOptions): PdfPage => {
      const normalized: PageOptions = { mediaBox: normalize(page.mediaBox) };
      if (page.cropBox !== undefined) normalized.cropBox = normalize(page.cropBox);
      if (page.bleedBox !== undefined) normalized.bleedBox = normalize(page.bleedBox);
      if (page.trimBox !== undefined) normalized.trimBox = normalize(page.trimBox);
      if (page.artBox !== undefined) normalized.artBox = normalize(page.artBox);
      if (page.group !== undefined) normalized.group = { ...page.group };
      // ISO 32000-1:2008, 7.7.3.3, Table 30 defaults CropBox to MediaBox and the other production boxes to CropBox.
      const cropBox = normalized.cropBox ?? normalized.mediaBox;
      for (const box of [normalized.mediaBox, cropBox, normalized.bleedBox ?? cropBox, normalized.trimBox ?? cropBox, normalized.artBox ?? cropBox]) {
        validateBox(box, normalized.mediaBox, fractionDigits);
      }
      const record: PageRecord = { options: normalized, contents: [], ...createResourceRecord() };
      pages.push(record);
      return {
        draw: (render): void => {
          // Writer policy: without a page group the blending space is the device's own, and print devices are DeviceCMYK.
          const hooks = createContentHooks(record, records, { blendingSpace: normalized.group?.colorSpace ?? 'DeviceCMYK' });
          hooks.maxDepth = 27;
          const session = createContentBuilder(fractionDigits, hooks);
          render(session.content);
          record.contents.push(isolateContent(session.finish().data));
        },
        pieceInfo: (input): void => {
          record.pieceInfo = pieceInfoRecord(input.lastModified, input.data);
        },
      };
    },
    save: (): BufferedSavedPdf => {
      const catalog = new PdfDictionaryEntries([
        [pdfName('Type').bytes, pdfName('Catalog')],
        [pdfName('Pages').bytes, pdfReference(2, 0)],
      ]);
      if (documentPieceInfo !== undefined) catalog.set(pdfName('PieceInfo').bytes, documentPieceInfo.value);
      const pageStart = callerObjects.length + 3;
      const kids = pages.map((_, index) => pdfReference(index + pageStart, 0));
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
      for (let index = 0; index < callerObjects.length; index++) {
        const value = callerObjects[index];
        if (value !== undefined) objects.push({ objectNumber: index + 3, generation: 0, value });
      }
      const contentStart = pageStart + pages.length;
      const imageStart = contentStart + pages.reduce((sum, page) => sum + page.contents.length, 0);
      const imageNumbers = allocateImageNumbers(images, imageStart);
      const groupStart = imageStart + images.reduce((sum, image) => sum + (image.softMask === undefined ? 1 : 2), 0);
      const groupNumbers = allocateGroupNumbers(groups, groupStart);
      const resourceNumbers: ResourceNumbers = { imageNumbers, groupNumbers };
      let nextContentNumber = contentStart;
      for (let index = 0; index < pages.length; index++) {
        const record = pages[index];
        if (record === undefined) continue;
        const value = pageObject(record, { fractionDigits, contentStart: nextContentNumber, resourceNumbers });
        objects.push({ objectNumber: index + pageStart, generation: 0, value });
        nextContentNumber += record.contents.length;
      }
      for (const record of pages) {
        for (const data of record.contents) {
          // ISO 32000-1:2008, 7.4.4 identifies FlateDecode as the stream filter for zlib-compressed data.
          const dictionary = new PdfDictionaryEntries([[pdfName('Filter').bytes, pdfName('FlateDecode')]]);
          objects.push({ objectNumber: objects.length + 1, generation: 0, value: { kind: 'stream', dictionary, data: deflateZlib(data) } });
        }
      }
      for (const image of images) {
        const numbers = imageNumbers.get(image);
        if (numbers === undefined) throw new ValidationError('image reference is missing');
        if (image.softMask !== undefined) {
          if (numbers.mask === undefined) throw new ValidationError('soft mask reference is missing');
          objects.push({ objectNumber: numbers.mask, generation: 0, value: softMaskObject(image.softMask) });
        }
        objects.push({ objectNumber: numbers.parent, generation: 0, value: imageObject(image, numbers.mask) });
      }
      for (const record of groups) {
        const number = groupNumbers.get(record);
        if (number === undefined) throw new ValidationError('group reference is missing');
        const resources = resourceDictionary(record, resourceNumbers) ?? pdfDictionary();
        objects.push({ objectNumber: number, generation: 0, value: groupObject(record.attributes, record.content, resources, record.pieceInfo) });
      }
      const trailer = new PdfDictionaryEntries([[pdfName('Root').bytes, pdfReference(1, 0)]]);
      if (options.info !== undefined) {
        const info = documentInfoDictionary(options.info);
        if (info.size > 0) {
          const number = objects.length + 1;
          objects.push({ objectNumber: number, generation: 0, value: pdfDictionary(info) });
          trailer.set(pdfName('Info').bytes, pdfReference(number, 0));
        }
      }
      const { info } = options;
      if (metadata?.xmp !== true || info === undefined) return writeDocument(objects, trailer, { fractionDigits, fileIdentifier: options.fileIdentifier });
      // ISO 32000-1:2008, Table 28, Metadata: the catalog names the document packet, the last object.
      const packetNumber = objects.length + 1;
      catalog.set(pdfName('Metadata').bytes, pdfReference(packetNumber, 0));
      const created = createdPacket({ objects, trailer, info, options: metadata, fileIdentifier: options.fileIdentifier, fractionDigits });
      objects.push({ objectNumber: packetNumber, generation: 0, value: created.packet });
      return writeDocument(objects, trailer, { fractionDigits, fileIdentifier: created.fileIdentifier });
    },
  };
};

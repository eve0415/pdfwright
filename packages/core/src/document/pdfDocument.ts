import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { IndirectObject } from '../write/writeDocument.ts';
import type { BlendingSpace, ContentBuilder, ContentHooks, ContentSummary, GraphicsStateOptions } from './contentBuilder.ts';
import type { DocumentInfo } from './documentInfo.ts';
import type { GroupAttributes, GroupOptions, PdfGroup } from './group.ts';
import type { ImageOptions, ImageRecord, PdfImage } from './image.ts';
import type { DocumentPieceInfoInput, PieceInfoInput, PieceInfoRecord } from './pieceInfo.ts';
import type { PdfRect } from './rect.ts';
import type { Separation, SeparationOptions, SeparationRecord } from './separation.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { formatLength } from '../length/length.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { writeDocument } from '../write/writeDocument.ts';

import { createContentBuilder } from './contentBuilder.ts';
import { documentInfoDictionary } from './documentInfo.ts';
import { groupAttributes, groupObject } from './group.ts';
import { createImageRecord, imageObject, softMaskObject } from './image.ts';
import { pieceInfoRecord } from './pieceInfo.ts';
import { rect } from './rect.ts';
import { colorantKey, createSeparationRecord, separationObject } from './separation.ts';

export interface DocumentOptions {
  fractionDigits?: number;
  fileIdentifier?: [Uint8Array, Uint8Array];
  colorantPolicy?: { asciiOnly?: boolean };
  info?: DocumentInfo;
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
  image: (options: ImageOptions) => PdfImage;
  group: (options: GroupOptions, render: (content: ContentBuilder) => void) => PdfGroup;
  object: (value: PdfObject) => PdfReference;
  pieceInfo: (input: DocumentPieceInfoInput) => void;
  save: () => SavedPdf;
}

export interface PdfPage {
  draw: (render: (content: ContentBuilder) => void) => void;
  pieceInfo: (input: PieceInfoInput) => void;
}

interface ResourceRecord {
  graphicsStates: Map<string, { name: string; options: GraphicsStateOptions }>;
  separations: Map<string, { name: string; separation: SeparationRecord }>;
  images: Map<ImageRecord, string>;
  groups: Map<GroupRecord, string>;
}

interface PageRecord extends ResourceRecord {
  options: PageOptions;
  contents: Uint8Array[];
  pieceInfo?: PieceInfoRecord;
}

interface GroupRecord extends ResourceRecord {
  attributes: GroupAttributes;
  content: Uint8Array;
  summary: ContentSummary;
  pieceInfo?: PieceInfoRecord;
}

// Handles are opaque: each document maps the handles it issued to their records, so a handle from another document or built by hand has no record.
interface DocumentRecords {
  separations: WeakMap<Separation, SeparationRecord>;
  images: WeakMap<PdfImage, ImageRecord>;
  groups: WeakMap<PdfGroup, GroupRecord>;
}

interface ImageObjectNumbers {
  parent: number;
  mask?: number;
}

interface PageBuildContext {
  fractionDigits: number;
  contentStart: number;
  resourceNumbers: ResourceNumbers;
}

interface ResourceNumbers {
  imageNumbers: Map<ImageRecord, ImageObjectNumbers>;
  groupNumbers: Map<GroupRecord, number>;
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

const createResourceRecord = (): ResourceRecord => ({ graphicsStates: new Map(), separations: new Map(), images: new Map(), groups: new Map() });

const isolateContent = (data: Uint8Array): Uint8Array => {
  // ISO 32000-1:2008, 8.4.2 defines q and Q as saving and restoring the entire graphics state.
  const isolated = new Uint8Array(data.length + 4);
  isolated.set([0x71, 0x0a], 0);
  isolated.set(data, 2);
  isolated.set([0x51, 0x0a], data.length + 2);
  return isolated;
};

const separationRecord = (records: DocumentRecords, separation: Separation): SeparationRecord => {
  const record = records.separations.get(separation);
  if (record === undefined) throw new ValidationError('separation was not created by this document');
  return record;
};

const imageRecord = (records: DocumentRecords, image: PdfImage): ImageRecord => {
  const record = records.images.get(image);
  if (record === undefined) throw new ValidationError('image was not created by this document');
  return record;
};

const groupRecord = (records: DocumentRecords, group: PdfGroup): GroupRecord => {
  const record = records.groups.get(group);
  if (record === undefined) throw new ValidationError('group was not created by this document, or its render callback has not returned');
  return record;
};

const createContentHooks = (...[resources, records, blendingSpace]: [ResourceRecord, DocumentRecords, BlendingSpace]): ContentHooks => ({
  blendingSpace,
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
    const existing = resources.graphicsStates.get(key);
    if (existing !== undefined) return existing.name;
    const name = `GS${resources.graphicsStates.size + 1}`;
    resources.graphicsStates.set(key, { name, options: stateOptions });
    return name;
  },
  registerSeparation: separation => {
    const record = separationRecord(records, separation);
    const key = colorantKey(record.name);
    const existing = resources.separations.get(key);
    if (existing !== undefined) return existing.name;
    const name = `CS${resources.separations.size + 1}`;
    resources.separations.set(key, { name, separation: record });
    return name;
  },
  registerImage: image => {
    const record = imageRecord(records, image);
    const existing = resources.images.get(record);
    if (existing !== undefined) return existing;
    const name = `Im${resources.images.size + 1}`;
    resources.images.set(record, name);
    return name;
  },
  groupSummary: group => groupRecord(records, group).summary,
  registerGroup: group => {
    const record = groupRecord(records, group);
    const existing = resources.groups.get(record);
    if (existing !== undefined) return existing;
    const name = `Fm${resources.groups.size + 1}`;
    resources.groups.set(record, name);
    return name;
  },
});

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

const pageResources = (record: ResourceRecord, numbers: ResourceNumbers): PdfDirectObject | undefined => {
  if (record.graphicsStates.size === 0 && record.separations.size === 0 && record.images.size === 0 && record.groups.size === 0) return undefined;
  const resources = new PdfDictionaryEntries();
  if (record.separations.size > 0) {
    const colorSpaces = new PdfDictionaryEntries();
    for (const space of record.separations.values()) colorSpaces.set(pdfName(space.name).bytes, separationObject(space.separation));
    resources.set(pdfName('ColorSpace').bytes, pdfDictionary(colorSpaces));
  }
  if (record.graphicsStates.size > 0) {
    const states = new PdfDictionaryEntries();
    for (const state of record.graphicsStates.values()) states.set(pdfName(state.name).bytes, pdfDictionary(graphicsStateDictionary(state.options)));
    resources.set(pdfName('ExtGState').bytes, pdfDictionary(states));
  }
  if (record.images.size > 0 || record.groups.size > 0) {
    const xObjects = new PdfDictionaryEntries();
    for (const [image, name] of record.images) {
      const number = numbers.imageNumbers.get(image)?.parent;
      if (number === undefined) throw new ValidationError('image reference is missing');
      xObjects.set(pdfName(name).bytes, pdfReference(number, 0));
    }
    for (const [group, name] of record.groups) {
      const number = numbers.groupNumbers.get(group);
      if (number === undefined) throw new ValidationError('group reference is missing');
      xObjects.set(pdfName(name).bytes, pdfReference(number, 0));
    }
    resources.set(pdfName('XObject').bytes, pdfDictionary(xObjects));
  }
  return pdfDictionary(resources);
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
  const resources = pageResources(record, context.resourceNumbers);
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

export const createDocument = (options: DocumentOptions = {}): PdfDocument => {
  const pages: PageRecord[] = [];
  const callerObjects: PdfObject[] = [];
  let documentPieceInfo: PieceInfoRecord | undefined = undefined;
  const documentSeparations = new Map<string, Separation>();
  const images: ImageRecord[] = [];
  const groups: GroupRecord[] = [];
  const records: DocumentRecords = { separations: new WeakMap(), images: new WeakMap(), groups: new WeakMap() };
  const fractionDigits = options.fractionDigits ?? DEFAULT_FRACTION_DIGITS;

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
    group: (groupOptions, render): PdfGroup => {
      const attributes = groupAttributes(groupOptions, fractionDigits);
      const handle: PdfGroup = Object.freeze({
        kind: 'PdfGroup',
        pieceInfo: (input: PieceInfoInput): void => {
          groupRecord(records, handle).pieceInfo = pieceInfoRecord(input.lastModified, input.data);
        },
      });
      const resources = createResourceRecord();
      // ISO 32000-1:2008, 11.6.6, Table 147, CS: "Default value: the colour space of the parent group or page into which this transparency group is painted."
      const hooks = createContentHooks(resources, records, attributes.colorSpace ?? 'inherited');
      // A group is drawn only through a page, so its content always starts inside the page's isolating q, the placement's q and the save made by Do (ISO 32000-1:2008, 8.10.1).
      hooks.maxDepth = 25;
      hooks.inheritsState = true;
      const session = createContentBuilder(fractionDigits, hooks);
      render(session.content);
      const { data, summary } = session.finish();
      const record: GroupRecord = { attributes, content: data, summary, ...resources };
      records.groups.set(handle, record);
      groups.push(record);
      return handle;
    },
    image: (imageOptions): PdfImage => {
      const record = createImageRecord(imageOptions, separation => separationRecord(records, separation));
      const handle: PdfImage = Object.freeze({ kind: 'PdfImage' });
      records.images.set(handle, record);
      images.push(record);
      return handle;
    },
    separation: (separationOptions): Separation => {
      const record = createSeparationRecord(separationOptions, options.colorantPolicy?.asciiOnly === true);
      const key = colorantKey(record.name);
      const existing = documentSeparations.get(key);
      if (existing !== undefined) {
        if (JSON.stringify(separationRecord(records, existing).alternate) !== JSON.stringify(record.alternate)) {
          throw new ValidationError('the same colorant name cannot use conflicting alternate colours');
        }
        return existing;
      }
      const handle: Separation = Object.freeze({ kind: 'Separation' });
      records.separations.set(handle, record);
      documentSeparations.set(key, handle);
      return handle;
    },
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
          const hooks = createContentHooks(record, records, normalized.group?.colorSpace ?? 'DeviceCMYK');
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
    save: (): SavedPdf => {
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
        const resources = pageResources(record, resourceNumbers) ?? pdfDictionary();
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
      return writeDocument(objects, trailer, { fractionDigits, fileIdentifier: options.fileIdentifier });
    },
  };
};

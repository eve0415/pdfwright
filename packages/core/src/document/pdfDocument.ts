import type { Length } from '../length/length.ts';
import type { PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { IndirectObject } from '../write/writeDocument.ts';
import type { ContentBuilder, ContentHooks, GraphicsStateOptions } from './contentBuilder.ts';
import type { DocumentInfo } from './documentInfo.ts';
import type { GroupOptions, PdfGroup } from './group.ts';
import type { ImageOptions, PdfImage } from './image.ts';
import type { DocumentPieceInfoInput, PieceInfoInput, PieceInfoRecord } from './pieceInfo.ts';
import type { PdfRect } from './rect.ts';
import type { Separation, SeparationOptions } from './separation.ts';

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
import { createGroup, groupObject } from './group.ts';
import { createImage, imageObject, softMaskObject } from './image.ts';
import { pieceInfoRecord, validateIndirectValue } from './pieceInfo.ts';
import { rect } from './rect.ts';
import { colorantKey, createSeparation, separationObject } from './separation.ts';

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
  separations: Map<string, { name: string; separation: Separation }>;
  images: Map<number, { name: string; image: PdfImage }>;
  groups: Map<number, { name: string; group: PdfGroup }>;
}

interface PageRecord extends ResourceRecord {
  options: PageOptions;
  contents: Uint8Array[];
  pieceInfo?: PieceInfoRecord;
}

interface GroupRecord extends ResourceRecord {
  handle: PdfGroup;
  content: Uint8Array;
  pieceInfo?: PieceInfoRecord;
}

interface GroupRecordHolder {
  record?: GroupRecord;
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
  imageNumbers: Map<number, ImageObjectNumbers>;
  groupNumbers: Map<number, number>;
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

const createResourceRecord = (): ResourceRecord => ({ graphicsStates: new Map(), separations: new Map(), images: new Map(), groups: new Map() });

const isolateContent = (data: Uint8Array): Uint8Array => {
  // ISO 32000-1:2008, 8.4.2 defines q and Q as saving and restoring the entire graphics state.
  const isolated = new Uint8Array(data.length + 4);
  isolated.set([0x71, 0x0a], 0);
  isolated.set(data, 2);
  isolated.set([0x51, 0x0a], data.length + 2);
  return isolated;
};

const createContentHooks = (resources: ResourceRecord, owner: symbol, colorSpace?: 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray'): ContentHooks => ({
  colorSpace,
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
    const key = colorantKey(separation.name);
    const existing = resources.separations.get(key);
    if (existing !== undefined) return existing.name;
    const name = `CS${resources.separations.size + 1}`;
    resources.separations.set(key, { name, separation });
    return name;
  },
  registerImage: image => {
    if (image.owner !== owner) throw new ValidationError('image belongs to a different document');
    const existing = resources.images.get(image.id);
    if (existing !== undefined) return existing.name;
    const name = `Im${resources.images.size + 1}`;
    resources.images.set(image.id, { name, image });
    return name;
  },
  registerGroup: group => {
    if (group.owner !== owner) throw new ValidationError('group belongs to a different document');
    const existing = resources.groups.get(group.id);
    if (existing !== undefined) return existing.name;
    const name = `Fm${resources.groups.size + 1}`;
    resources.groups.set(group.id, { name, group });
    return name;
  },
});

const allocateImageNumbers = (images: readonly PdfImage[], firstNumber: number): Map<number, ImageObjectNumbers> => {
  let nextNumber = firstNumber;
  const numbersByImage = new Map<number, ImageObjectNumbers>();
  for (const image of images) {
    const numbers: ImageObjectNumbers = { parent: nextNumber };
    if (image.softMask !== undefined) {
      numbers.mask = nextNumber++;
      numbers.parent = nextNumber;
    }
    nextNumber++;
    numbersByImage.set(image.id, numbers);
  }
  return numbersByImage;
};

const allocateGroupNumbers = (groups: readonly GroupRecord[], firstNumber: number): Map<number, number> => {
  let nextNumber = firstNumber;
  const numbers = new Map<number, number>();
  for (const group of groups) numbers.set(group.handle.id, nextNumber++);
  return numbers;
};

const pageResources = (record: ResourceRecord, numbers: ResourceNumbers): PdfObject | undefined => {
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
    for (const image of record.images.values()) {
      const number = numbers.imageNumbers.get(image.image.id)?.parent;
      if (number === undefined) throw new ValidationError('image reference is missing');
      xObjects.set(pdfName(image.name).bytes, pdfReference(number, 0));
    }
    for (const group of record.groups.values()) {
      const number = numbers.groupNumbers.get(group.group.id);
      if (number === undefined) throw new ValidationError('group reference is missing');
      xObjects.set(pdfName(group.name).bytes, pdfReference(number, 0));
    }
    resources.set(pdfName('XObject').bytes, pdfDictionary(xObjects));
  }
  return pdfDictionary(resources);
};

const pageObject = (record: PageRecord, context: PageBuildContext): PdfObject => {
  const page = record.options;
  // ISO 32000-1:2008, 7.7.3.3, Table 30 makes MediaBox required and Contents optional; an absent Contents means an empty page.
  const entries = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('Page')],
    [pdfName('Parent').bytes, pdfReference(2, 0)],
    [pdfName('MediaBox').bytes, pdfArray(page.mediaBox.map(length => pointObject(length, context.fractionDigits)))],
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
    if (box !== undefined) entries.set(pdfName(key).bytes, pdfArray(box.map(length => pointObject(length, context.fractionDigits))));
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
  const images: PdfImage[] = [];
  const groups: GroupRecord[] = [];
  const owner = Symbol('pdfwright document');
  const fractionDigits = options.fractionDigits ?? DEFAULT_FRACTION_DIGITS;

  return {
    object: (value): PdfReference => {
      validateIndirectValue(value);
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
      const groupState: GroupRecordHolder = {};
      const handle = createGroup(groups.length + 1, owner, groupOptions, fractionDigits, input => {
        if (groupState.record === undefined) throw new ValidationError('group is not ready for page-piece data');
        groupState.record.pieceInfo = pieceInfoRecord(input.lastModified, input.data);
      });
      const resources = createResourceRecord();
      const content = createContentBuilder(fractionDigits, createContentHooks(resources, owner, handle.colorSpace));
      render(content);
      const data = content.finish();
      const inherited = content.inheritedWhitePaint();
      handle.inheritedWhiteFill = inherited.fill;
      handle.inheritedWhiteStroke = inherited.stroke;
      const record: GroupRecord = { handle, content: data, ...resources };
      groupState.record = record;
      groups.push(record);
      return handle;
    },
    image: (imageOptions): PdfImage => {
      const image = createImage(images.length + 1, owner, imageOptions);
      images.push(image);
      return image;
    },
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
      const record: PageRecord = { options: normalized, contents: [], ...createResourceRecord() };
      pages.push(record);
      return {
        draw: (render): void => {
          const hooks = createContentHooks(record, owner, normalized.group?.colorSpace);
          hooks.maxDepth = 27;
          const content = createContentBuilder(fractionDigits, hooks);
          render(content);
          record.contents.push(isolateContent(content.finish()));
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
        const numbers = imageNumbers.get(image.id);
        if (numbers === undefined) throw new ValidationError('image reference is missing');
        if (image.softMask !== undefined) {
          if (numbers.mask === undefined) throw new ValidationError('soft mask reference is missing');
          objects.push({ objectNumber: numbers.mask, generation: 0, value: softMaskObject(image.softMask) });
        }
        objects.push({ objectNumber: numbers.parent, generation: 0, value: imageObject(image, numbers.mask) });
      }
      for (const record of groups) {
        const number = groupNumbers.get(record.handle.id);
        if (number === undefined) throw new ValidationError('group reference is missing');
        const resources = pageResources(record, resourceNumbers) ?? pdfDictionary();
        objects.push({ objectNumber: number, generation: 0, value: groupObject(record.handle, record.content, resources, fractionDigits, record.pieceInfo) });
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
      return writeDocument(objects, trailer, { fractionDigits, version: '1.7', fileIdentifier: options.fileIdentifier });
    },
  };
};

import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { BlendingSpace, ContentHooks, ContentSummary, GraphicsStateOptions } from './contentBuilder.ts';
import type { GroupAttributes, PdfGroup } from './group.ts';
import type { ImageRecord, PdfImage } from './image.ts';
import type { PieceInfoRecord } from './pieceInfo.ts';
import type { Separation, SeparationRecord } from './separation.ts';

import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';

import { colorantKey, separationObject } from './separation.ts';

// The resources one content stream uses, registered while it is built and named in the order they are first used; shared by created and loaded documents.

export interface ResourceRecord {
  graphicsStates: Map<string, { name: string; options: GraphicsStateOptions }>;
  separations: Map<string, { name: string; separation: SeparationRecord }>;
  images: Map<ImageRecord, string>;
  groups: Map<GroupRecord, string>;
}

export interface GroupRecord extends ResourceRecord {
  attributes: GroupAttributes;
  content: Uint8Array;
  summary: ContentSummary;
  pieceInfo?: PieceInfoRecord;
}

// Handles are opaque: each document maps the handles it issued to their records, so a handle from another document or built by hand has no record.
export interface DocumentRecords {
  separations: WeakMap<Separation, SeparationRecord>;
  images: WeakMap<PdfImage, ImageRecord>;
  groups: WeakMap<PdfGroup, GroupRecord>;
}

export interface ImageObjectNumbers {
  parent: number;
  mask?: number;
}

export interface ResourceNumbers {
  imageNumbers: Map<ImageRecord, ImageObjectNumbers>;
  groupNumbers: Map<GroupRecord, number>;
}

export const graphicsStateDictionary = (options: GraphicsStateOptions): PdfDictionaryEntries => {
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

export const createResourceRecord = (): ResourceRecord => ({ graphicsStates: new Map(), separations: new Map(), images: new Map(), groups: new Map() });

export const separationRecord = (records: DocumentRecords, separation: Separation): SeparationRecord => {
  const record = records.separations.get(separation);
  if (record === undefined) throw new ValidationError('separation was not created by this document');
  return record;
};

export const imageRecord = (records: DocumentRecords, image: PdfImage): ImageRecord => {
  const record = records.images.get(image);
  if (record === undefined) throw new ValidationError('image was not created by this document');
  return record;
};

export const groupRecord = (records: DocumentRecords, group: PdfGroup): GroupRecord => {
  const record = records.groups.get(group);
  if (record === undefined) throw new ValidationError('group was not created by this document, or its render callback has not returned');
  return record;
};

export type ResourcePrefix = 'GS' | 'CS' | 'Im' | 'Fm';

export interface HookOptions {
  readonly blendingSpace: BlendingSpace;
  /** Names a resource from its prefix and its 1-based ordinal in the record; by default the two are joined. */
  readonly name?: (prefix: ResourcePrefix, ordinal: number) => string;
}

const joinedName = (prefix: ResourcePrefix, ordinal: number): string => `${prefix}${String(ordinal)}`;

export const createContentHooks = (resources: ResourceRecord, records: DocumentRecords, options: HookOptions): ContentHooks => {
  const name = options.name ?? joinedName;
  return {
    blendingSpace: options.blendingSpace,
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
      const assigned = name('GS', resources.graphicsStates.size + 1);
      resources.graphicsStates.set(key, { name: assigned, options: stateOptions });
      return assigned;
    },
    registerSeparation: separation => {
      const record = separationRecord(records, separation);
      const key = colorantKey(record.name);
      const existing = resources.separations.get(key);
      if (existing !== undefined) return existing.name;
      const assigned = name('CS', resources.separations.size + 1);
      resources.separations.set(key, { name: assigned, separation: record });
      return assigned;
    },
    registerImage: image => {
      const record = imageRecord(records, image);
      const existing = resources.images.get(record);
      if (existing !== undefined) return existing;
      const assigned = name('Im', resources.images.size + 1);
      resources.images.set(record, assigned);
      return assigned;
    },
    groupSummary: group => groupRecord(records, group).summary,
    registerGroup: group => {
      const record = groupRecord(records, group);
      const existing = resources.groups.get(record);
      if (existing !== undefined) return existing;
      const assigned = name('Fm', resources.groups.size + 1);
      resources.groups.set(record, assigned);
      return assigned;
    },
  };
};

export const resourceDictionary = (record: ResourceRecord, numbers: ResourceNumbers): PdfDirectObject | undefined => {
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

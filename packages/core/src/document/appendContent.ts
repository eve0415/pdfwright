import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { BlendingSpace, ContentBuilder } from './contentBuilder.ts';
import type { DocumentHandles } from './documentHandles.ts';
import type { ResourceAddition, ResourceCategory, ResourceContext } from './pageResources.ts';
import type { PageEntry } from './pageTree.ts';
import type { RegisteredResource, ResourceNumbers, ResourcePrefix, ResourceRecord } from './resourceRecord.ts';

import { readContent } from '../content/contentOperations.ts';
import { checkOperands } from '../content/operands.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { deepEqual } from '../object/deepEqual.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfName, pdfReference } from '../object/pdfObject.ts';

import { createContentBuilder } from './contentBuilder.ts';
import { groupObject } from './group.ts';
import { imageObject, softMaskObject } from './image.ts';
import { addPageResources, takenNames } from './pageResources.ts';
import { isolateContent } from './pdfDocument.ts';
import { createContentHooks, createResourceRecord, resourceDictionary } from './resourceRecord.ts';
import { separationObject } from './separation.ts';

export interface ContentContext extends ResourceContext {
  readonly handles: DocumentHandles;
  /** Objects already written for the document's images and groups. */
  readonly placed: ResourceNumbers;
  readonly fractionDigits: number;
  /** Set when appended content uses a PDF 1.4 transparency feature, so that saving can raise the version. */
  readonly features: { transparency: boolean };
}

export interface AppendRequest {
  readonly content: Uint8Array | ((content: ContentBuilder) => void);
  /** Wraps the existing content in q and Q so the new content starts in the default graphics state; default true. */
  readonly isolate: boolean;
}

const CONTENTS = pdfName('Contents').bytes;
const GROUP = pdfName('Group').bytes;
const CS = pdfName('CS').bytes;
const CATEGORY: Readonly<Record<ResourcePrefix, ResourceCategory>> = { GS: 'ExtGState', CS: 'ColorSpace', Im: 'XObject', Fm: 'XObject' };
const PAINT = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*', 'Do', 'sh', 'BI', 'Tj', 'TJ', "'", '"']);

// Raw content has no builder state. A resource graphics state or an inherited state can make a white paint invisible, so those paths need the builder instead.
const checkRawContent = (data: Uint8Array, isolate: boolean): void => {
  let depth = 0;
  try {
    for (const operation of readContent(data, 256)) {
      const { operator, operands } = operation;
      if (checkOperands(operator, operands).kind !== 'known' || operator === 'gs' || operator === 'Do' || operator === 'sh') {
        throw new ValidationError(`raw content operator ${operator} cannot be checked for invisible overprint`, 'raw-content-unchecked');
      }
      if (operator === 'q') depth++;
      if (operator === 'Q' && --depth < 0) throw new ValidationError('raw content leaves its graphics state scope', 'raw-content-unchecked');
      if (!isolate && PAINT.has(operator)) {
        throw new ValidationError(`raw content paint ${operator} can inherit overprint settings`, 'raw-content-unchecked');
      }
    }
  } catch (error: unknown) {
    if (error instanceof ParseError || error instanceof ResourceLimitError) {
      throw new ValidationError('raw content cannot be parsed for invisible overprint', 'raw-content-unchecked');
    }
    throw error;
  }
};

const label = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)} R`;

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const pageEntries = (context: ContentContext, page: PageEntry): PdfDictionaryEntries => {
  const value = context.objects.get(page.reference);
  if (value.kind !== 'dictionary') throw new ParseError(`page ${label(page.reference)} is not a dictionary`, 0);
  return value.entries;
};

// ISO 32000-1:2008, 11.4.7: the page group's colour space is the blending space; without one, writer policy assumes DeviceCMYK, the space of print devices.
const blendingSpace = (context: ContentContext, page: PageEntry): BlendingSpace => {
  const group = context.objects.deref(pageEntries(context, page).get(GROUP));
  const space = group?.kind === 'dictionary' ? context.objects.deref(group.entries.get(CS)) : undefined;
  const name = space?.kind === 'name' ? latin1(space.bytes) : '';
  return name === 'DeviceRGB' || name === 'DeviceGray' ? name : 'DeviceCMYK';
};

// Writes the image and group objects a record uses, nested groups first, once per document.
const place = (context: ContentContext, record: ResourceRecord): void => {
  const { objects, placed } = context;
  for (const image of record.images.keys()) {
    if (placed.imageNumbers.has(image)) continue;
    const mask = image.softMask === undefined ? undefined : objects.add(softMaskObject(image.softMask)).objectNumber;
    const parent = objects.add(imageObject(image, mask)).objectNumber;
    placed.imageNumbers.set(image, mask === undefined ? { parent } : { parent, mask });
  }
  for (const group of record.groups.keys()) {
    if (placed.groupNumbers.has(group)) continue;
    place(context, group);
    const resources = resourceDictionary(group, placed) ?? pdfDictionary();
    placed.groupNumbers.set(group, objects.add(groupObject(group.attributes, group.content, resources, group.pieceInfo)).objectNumber);
    group.written = true;
  }
};

const additions = (resources: PdfDirectObject | undefined): ResourceAddition[] => {
  const list: ResourceAddition[] = [];
  if (resources?.kind !== 'dictionary') return list;
  for (const [category, entries] of resources.entries.entries()) {
    if (entries.kind !== 'dictionary') continue;
    const name = latin1(category);
    if (name !== 'ExtGState' && name !== 'ColorSpace' && name !== 'XObject') throw new ValidationError(`unexpected resource category ${name}`);
    for (const [key, value] of entries.entries.entries()) list.push({ category: name, name: key, value });
  }
  return list;
};

// A name the page's resources already give the same separation, or the same image or group object written by an earlier append.
const existingName = (context: ContentContext, page: PageEntry, resource: RegisteredResource): string | undefined => {
  let number: number | undefined = undefined;
  if (resource.kind === 'image') number = context.placed.imageNumbers.get(resource.record)?.parent;
  else if (resource.kind === 'group') number = context.placed.groupNumbers.get(resource.record);
  const category: ResourceCategory = resource.kind === 'separation' ? 'ColorSpace' : 'XObject';
  let value: PdfDirectObject | undefined = number === undefined ? undefined : pdfReference(number, 0);
  if (resource.kind === 'separation') value = separationObject(resource.record);
  if (value === undefined) return undefined;
  for (const [key, existing] of takenNames(context, page, category).entries()) if (deepEqual(existing, value, 'strict')) return latin1(key);
  return undefined;
};

// Content drawn with the content builder, with resource names that the page does not use yet.
const built = (context: ContentContext, page: PageEntry, render: (content: ContentBuilder) => void): Uint8Array => {
  const taken = new Map<ResourceCategory, Set<string>>();
  const takenIn = (category: ResourceCategory): Set<string> => {
    let names = taken.get(category);
    if (names === undefined) {
      names = new Set([...takenNames(context, page, category).entries()].map(([key]) => latin1(key)));
      taken.set(category, names);
    }
    return names;
  };
  const record = createResourceRecord();
  const hooks = createContentHooks(record, context.handles.records, {
    blendingSpace: blendingSpace(context, page),
    existing: resource => existingName(context, page, resource),
    name: (prefix, ordinal) => {
      const names = takenIn(CATEGORY[prefix]);
      let number = ordinal;
      while (names.has(`${prefix}${String(number)}`)) number++;
      const name = `${prefix}${String(number)}`;
      names.add(name);
      return name;
    },
  });
  // As for created pages, the content is wrapped in q and Q, which counts as one level of the 28 that ISO 32000-1:2008, Annex C allows.
  hooks.maxDepth = 27;
  const session = createContentBuilder(context.fractionDigits, hooks);
  render(session.content);
  const data = isolateContent(session.finish().data);
  // ISO 32000-1:2008, 8.4.5, Table 58: CA, ca, BM and SMask are "(Optional; PDF 1.4)".
  for (const { options } of record.graphicsStates.values()) {
    if (options.fillAlpha !== undefined || options.strokeAlpha !== undefined || options.blendMode !== undefined || options.softMask !== undefined) {
      context.features.transparency = true;
    }
  }
  place(context, record);
  addPageResources(context, page, additions(resourceDictionary(record, context.placed)));
  return data;
};

const contentStream = (context: ContentContext, data: Uint8Array, compress: boolean): PdfReference => {
  if (!compress) return context.objects.add({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data });
  // ISO 32000-1:2008, 7.4.4 identifies FlateDecode as the filter for zlib-compressed data.
  const dictionary = new PdfDictionaryEntries([[pdfName('Filter').bytes, pdfName('FlateDecode')]]);
  return context.objects.add({ kind: 'stream', dictionary, data: deflateZlib(data) });
};

const existingContents = (context: ContentContext, page: PageEntry): PdfDirectObject[] => {
  const contents = pageEntries(context, page).get(CONTENTS);
  if (contents === undefined) return [];
  if (contents.kind === 'reference') {
    const target = context.objects.resolve(contents.objectNumber, contents.generation);
    // An indirect array of streams is read through; the page gets a direct array of its own.
    return target.kind === 'array' ? [...target.items] : [contents];
  }
  if (contents.kind === 'array') return [...contents.items];
  throw new ParseError(`the Contents of page ${label(page.reference)} is neither a stream nor an array`, 0);
};

/**
 * Adds content after the page's existing content streams, which are never rewritten.
 * ISO 32000-1:2008, 7.7.3.3, Table 30, Contents: "If the value is an array, the effect shall be as if all of the streams in the array were concatenated, in order, to form a single stream."
 */
export const appendPageContent = (context: ContentContext, page: PageEntry, request: AppendRequest): void => {
  if (request.content instanceof Uint8Array) checkRawContent(request.content, request.isolate);
  const data = typeof request.content === 'function' ? built(context, page, request.content) : request.content;
  const existing = existingContents(context, page);
  const appended = existing.length > 0 && !request.isolate ? new Uint8Array(data.length + 1) : data;
  if (appended !== data) {
    appended[0] = 0x0a;
    appended.set(data, 1);
  }
  const added = contentStream(context, appended, true);
  const streams =
    request.isolate && existing.length > 0
      ? [contentStream(context, Uint8Array.of(0x71, 0x0a), false), ...existing, contentStream(context, Uint8Array.of(0x0a, 0x51, 0x0a), false), added]
      : [...existing, added];
  const entries = pageEntries(context, page);
  const [single] = streams;
  entries.set(CONTENTS, streams.length === 1 && single !== undefined ? single : pdfArray(streams));
  context.objects.set(page.reference, { kind: 'dictionary', entries });
};

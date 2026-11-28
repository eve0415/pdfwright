import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { ResourceCarrier } from './resourceCarriers.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';
import type { SourceSpace } from './sourceSpace.ts';

import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfString } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { deleteDiscarded } from './discardedObjects.ts';
import { checkConversionRefusals } from './preflight.ts';
import { replaceCarrierResources, resourceCarriers } from './resourceCarriers.ts';
import { resolveSourceSpace } from './sourceSpace.ts';

export interface IndexedConversionReport {
  readonly indexed: number;
}

interface IndexedContext {
  readonly document: LoadedDocument;
  readonly resources: PdfDictionaryEntries;
  readonly options: RewriteColorOptions;
}

interface PageUpdate {
  readonly reference: PdfReference;
  readonly resources: PdfDictionaryEntries;
  readonly discarded: ReadonlyArray<PdfReference>;
}

interface PageResult {
  readonly update: PageUpdate | undefined;
  readonly count: number;
}

interface ResourceResult {
  readonly resources: PdfDictionaryEntries | undefined;
  readonly discarded: ReadonlyArray<PdfReference>;
  readonly count: number;
}

interface CarrierUpdate {
  readonly carrier: ResourceCarrier;
  readonly resources: PdfDictionaryEntries;
  readonly discarded: ReadonlyArray<PdfReference>;
}

interface ImageUpdate {
  readonly reference: PdfReference;
  readonly image: PdfStream;
  readonly colorSpace: PdfDirectObject;
  readonly discarded: PdfReference | undefined;
}

const COLOR_SPACE = pdfName('ColorSpace').bytes;
const RESOURCES = pdfName('Resources').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const lookupFor = (context: IndexedContext, indexed: Extract<SourceSpace, { kind: 'indexed' }>): Uint8Array | undefined => {
  const { base } = indexed;
  if (base.kind !== 'rgb' && base.kind !== 'gray') {
    return undefined;
  }
  const channels = base.kind === 'rgb' ? 3 : 1;
  if (indexed.lookup.length !== (indexed.hival + 1) * channels) {
    return invalid('Indexed lookup length disagrees with hival and its base space');
  }
  const intent = context.options.intent === undefined || context.options.intent === 'document' ? 'relativeColorimetric' : context.options.intent;
  const { source } = base;
  const transform = createColorTransform(source, context.options.outputProfile, {
    intent,
    blackPointCompensation: context.options.blackPointCompensation !== false,
    lut8LabEncoding: context.options.lut8LabEncoding ?? 'icc',
  });
  const output = new Uint8Array((indexed.hival + 1) * 4);
  // ISO 32000-1:2008, 8.6.6.3: each lookup entry stores one base-space colour; painted indices remain unchanged.
  transform.convertRow8(indexed.lookup, output, indexed.hival + 1);
  return output;
};

export const convertIndexedColorSpace = (context: IndexedContext, value: PdfDirectObject): PdfDirectObject | undefined => {
  const resolved = resolveSourceSpace(context.document, value, {
    resources: context.resources,
    sourceRgbProfile: context.options.sourceRgbProfile,
    options: { iccGray: context.options.iccGray ?? 'convert' },
  });
  if (resolved.kind !== 'indexed') {
    return undefined;
  }
  const lookup = lookupFor(context, resolved);
  if (lookup === undefined) {
    return undefined;
  }
  return pdfArray([pdfName('Indexed'), pdfName('DeviceCMYK'), pdfInteger(resolved.hival), pdfString(lookup, 'hex')]);
};

const convertedResources = (context: IndexedContext): ResourceResult => {
  const { document, resources, options } = context;
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const colors = internals.objects.deref(resources.get(COLOR_SPACE));
  if (colors?.kind !== 'dictionary') {
    return { resources: undefined, discarded: [], count: 0 };
  }
  const mapped = new PdfDictionaryEntries(colors.entries.entries());
  const discarded: Array<PdfReference> = [];
  let count = 0;
  for (const [name, value] of colors.entries.entries()) {
    const replacement = convertIndexedColorSpace({ document, resources, options }, value);
    if (replacement === undefined) {
      continue;
    }
    mapped.set(name, replacement);
    if (value.kind === 'reference') {
      discarded.push(value);
    }
    count++;
  }
  if (count === 0) {
    return { resources: undefined, discarded: [], count };
  }
  const changed = new PdfDictionaryEntries(resources.entries());
  changed.set(COLOR_SPACE, pdfDictionary(mapped));
  const oldColors = resources.get(COLOR_SPACE);
  if (oldColors?.kind === 'reference') {
    discarded.push(oldColors);
  }
  return { resources: changed, discarded, count };
};

const pageUpdate = (document: LoadedDocument, index: number, options: RewriteColorOptions): PageResult => {
  const page = document.page(index);
  const converted = convertedResources({ document, resources: page.resources(), options });
  return {
    update: converted.resources === undefined ? undefined : { reference: page.reference, resources: converted.resources, discarded: converted.discarded },
    count: converted.count,
  };
};

const planImages = (context: IndexedContext, updates: Map<number, ImageUpdate>): void => {
  const { document, resources, options } = context;
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const category = internals.objects.deref(resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') {
    return;
  }
  for (const [, value] of category.entries.entries()) {
    if (value.kind !== 'reference') {
      continue;
    }
    const image = internals.objects.deref(value);
    if (image?.kind !== 'stream') {
      continue;
    }
    const subtype = internals.objects.deref(image.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'Image') {
      continue;
    }
    const original = image.dictionary.get(COLOR_SPACE);
    if (original === undefined) {
      continue;
    }
    const replacement = convertIndexedColorSpace({ document, resources, options }, original);
    if (replacement === undefined) {
      continue;
    }
    const previous = updates.get(value.objectNumber);
    if (previous !== undefined) {
      if (JSON.stringify(previous.colorSpace) !== JSON.stringify(replacement)) {
        throw new ValidationError('shared Indexed image has conflicting source spaces', 'color-space');
      }
      continue;
    }
    updates.set(value.objectNumber, { reference: value, image, colorSpace: replacement, discarded: original.kind === 'reference' ? original : undefined });
  }
};

const planCarriers = (
  context: IndexedContext,
  page: { index: number; reference: PdfReference },
  state: { seen: Set<number>; updates: Array<CarrierUpdate> },
): number => {
  const internals = internalsOf(context.document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  let count = 0;
  for (const carrier of resourceCarriers(internals, { ...page, resources: context.resources }, state.seen)) {
    const converted = convertedResources({ document: context.document, resources: carrier.resources, options: context.options });
    if (converted.resources !== undefined) {
      state.updates.push({ carrier, resources: converted.resources, discarded: converted.discarded });
      count += converted.count;
    }
  }
  return count;
};

/** Converts Indexed lookup tables in effective page ColorSpace resources and in the own resources of every form, tiling pattern, Type 3 font and appearance stream they reach, without changing painted indices. The ColorSpace resources of a soft-mask group, and of carriers only it reaches, keep their lookups. */
export const convertIndexedSpaces = (document: LoadedDocument, options: RewriteColorOptions): IndexedConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const updates: Array<PageUpdate> = [];
  const imageUpdates = new Map<number, ImageUpdate>();
  const carrierUpdates: Array<CarrierUpdate> = [];
  const seenCarriers = new Set<number>();
  let indexed = 0;
  for (const [index, entry] of internals.pages.entries()) {
    const planned = pageUpdate(document, index, options);
    if (planned.update !== undefined) {
      updates.push(planned.update);
    }
    indexed += planned.count;
    indexed += planCarriers(
      { document, resources: document.page(index).resources(), options },
      { index, reference: entry.reference },
      {
        seen: seenCarriers,
        updates: carrierUpdates,
      },
    );
    const resources: PdfDirectObject = { kind: 'dictionary', entries: document.page(index).resources() };
    const unreadable = walkResources(internals, entry, {
      resources,
      visit: visit => {
        planImages({ document, resources: visit.resources, options }, imageUpdates);
      },
    });
    if (unreadable.length > 0) {
      throw new ValidationError('Indexed image resources cannot be read', 'unreadable-resource');
    }
  }
  indexed += imageUpdates.size;
  if (updates.length === 0 && imageUpdates.size === 0 && carrierUpdates.length === 0) {
    return { indexed };
  }
  const discarded: Array<PdfReference> = [];
  for (const update of updates) {
    const page = document.get(update.reference);
    if (page.kind !== 'dictionary') {
      return invalid('page is not a dictionary');
    }
    const oldResources = page.entries.get(RESOURCES);
    if (oldResources?.kind === 'reference') {
      discarded.push(oldResources);
    }
    discarded.push(...update.discarded);
    page.entries.set(RESOURCES, pdfDictionary(update.resources));
    document.set(update.reference, page);
  }
  for (const update of imageUpdates.values()) {
    const dictionary = new PdfDictionaryEntries(update.image.dictionary.entries());
    dictionary.set(COLOR_SPACE, update.colorSpace);
    document.set(update.reference, { kind: 'stream', dictionary, data: update.image.data });
    if (update.discarded !== undefined) {
      discarded.push(update.discarded);
    }
  }
  for (const update of carrierUpdates) {
    discarded.push(...replaceCarrierResources(document, update.carrier, update.resources), ...update.discarded);
  }
  deleteDiscarded(document, internals, discarded);
  internals.objects.requireFullRewrite('color-conversion');
  return { indexed };
};

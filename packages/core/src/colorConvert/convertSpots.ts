import type { ColorSource } from '../color/createColorTransform.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfFunction, PdfFunctionReader } from '../function/pdfFunction.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { CarrierSeen, ResourceCarrier } from './resourceCarriers.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';
import type { SampledCmykFunction } from './sampleCmykFunction.ts';
import type { SourceSpace } from './sourceSpace.ts';
import type { ConvertedCmykFunction, StitchedCmykFunction } from './stitchCmykFunction.ts';

import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunctionReader } from '../function/pdfFunction.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfName } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { deleteDiscarded, discardedFunctionObjects } from './discardedObjects.ts';
import { checkConversionRefusals } from './preflight.ts';
import { carrierSeen, replaceCarrierResources, resourceCarriers } from './resourceCarriers.ts';
import { sampleCmykFunction } from './sampleCmykFunction.ts';
import { resolveSourceSpace } from './sourceSpace.ts';
import { stitchCmykFunction, writeCmykFunction } from './stitchCmykFunction.ts';

export interface SpotConversionReport {
  readonly separations: number;
  readonly deviceN: number;
  readonly approximations: ReadonlyArray<{ readonly maxDeltaE2000: number }>;
}

interface SpotContext {
  readonly document: LoadedDocument;
  readonly resources: PdfDictionaryEntries;
  readonly options: RewriteColorOptions;
}

type SampledFunction = SampledCmykFunction;

type ConvertedTint = ConvertedCmykFunction;

interface SpotPlan {
  readonly name: Uint8Array;
  readonly original: Extract<PdfDirectObject, { kind: 'array' }>;
  /** The converted tint transform, or undefined for a DeviceN whose own alternate needs no conversion but whose Colorants do. */
  readonly sampled: ConvertedTint | undefined;
  readonly kind: 'separation' | 'deviceN';
  readonly colorants: ReadonlyArray<SpotPlan>;
  readonly discarded: ReadonlyArray<PdfReference>;
}

interface ColorantPlans {
  readonly plans: ReadonlyArray<SpotPlan>;
  readonly discarded: ReadonlyArray<PdfReference>;
}

interface ResourceSpotPlan {
  readonly resources: PdfDictionaryEntries;
  readonly spaces: PdfDictionaryEntries;
  readonly spots: ReadonlyArray<SpotPlan>;
  readonly discarded: ReadonlyArray<PdfReference>;
}

interface PagePlan extends ResourceSpotPlan {
  readonly reference: PdfReference;
}

interface CarrierPlan extends ResourceSpotPlan {
  readonly carrier: ResourceCarrier;
}

interface ImagePlan {
  readonly reference: PdfReference;
  readonly image: PdfStream;
  readonly spot: SpotPlan;
}

const COLOR_SPACE = pdfName('ColorSpace').bytes;
const COLORANTS = pdfName('Colorants').bytes;
const RESOURCES = pdfName('Resources').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const checkedDimensions = (evaluate: PdfFunction, dimensions: number): PdfFunction =>
  evaluate.domain.length === dimensions * 2 ? evaluate : invalid('tint function Domain has the wrong dimensions');

const decodedTint = (document: LoadedDocument, object: PdfObject): PdfObject => {
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  if (object.kind !== 'stream') {
    return object;
  }
  const data = decodedData(internals, object);
  if (typeof data === 'string') {
    return invalid(`tint function cannot be decoded: ${data}`);
  }
  const decoded: PdfStream = { kind: 'stream', dictionary: object.dictionary, data };
  return decoded;
};

const functionReader = (document: LoadedDocument): PdfFunctionReader => {
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  return createPdfFunctionReader(value => {
    const child = internals.objects.deref(value);
    if (child === undefined) {
      return invalid('tint function is missing');
    }
    return decodedTint(document, child);
  });
};

const alternateSource = (space: SourceSpace): ColorSource | undefined => (space.kind === 'rgb' || space.kind === 'gray' ? space.source : undefined);

const sampleFunction = (context: SpotContext, space: SourceSpace & { kind: 'separation' | 'deviceN' }, read: PdfFunctionReader): SampledFunction => {
  const dimensions = space.kind === 'separation' ? 1 : space.names.length;
  if (dimensions > 4) {
    throw new UnsupportedFeatureError('DeviceN has more than four colourants', 'device-n-components');
  }
  const source = alternateSource(space.alternate);
  if (source === undefined) {
    return invalid('spot alternate is not a convertible RGB or gray space');
  }
  const original = checkedDimensions(read(decodedTint(context.document, space.tint)), dimensions);
  const intent = context.options.intent === undefined || context.options.intent === 'document' ? 'relativeColorimetric' : context.options.intent;
  const transform = createColorTransform(source, context.options.outputProfile, {
    intent,
    blackPointCompensation: context.options.blackPointCompensation !== false,
    lut8LabEncoding: context.options.lut8LabEncoding ?? 'icc',
  });
  const evaluate = (tints: ReadonlyArray<number>): Float64Array => {
    const output = new Float64Array(4);
    transform.convert(Float64Array.from(original(tints)), output);
    return output;
  };
  return sampleCmykFunction({ dimensions, domain: original.domain, evaluate, destination: context.options.outputProfile, grid: 17 });
};

const stitchedFunction = (context: SpotContext, space: SourceSpace & { kind: 'separation' | 'deviceN' }, read: PdfFunctionReader): StitchedCmykFunction => {
  if (space.kind !== 'separation') {
    return invalid('DeviceN stitching functions are unsupported');
  }
  return stitchCmykFunction(context.document, space.tint, child => sampleFunction(context, { ...space, tint: child }, read));
};

const convertedTint = (context: SpotContext, space: SourceSpace & { kind: 'separation' | 'deviceN' }): ConvertedTint => {
  const { tint } = space;
  let entries: PdfDictionaryEntries | undefined;
  if (tint.kind === 'dictionary') {
    ({ entries } = tint);
  } else if (tint.kind === 'stream') {
    ({ dictionary: entries } = tint);
  }
  const type = entries?.get(pdfName('FunctionType').bytes);
  const read = functionReader(context.document);
  return type?.kind === 'integer' && type.value === 3 ? stitchedFunction(context, space, read) : sampleFunction(context, space, read);
};

const checkNChannel = (context: SpotContext, original: Extract<PdfDirectObject, { kind: 'array' }>): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const attributes = internals.objects.deref(original.items[4]);
  if (attributes?.kind !== 'dictionary') {
    return;
  }
  const subtype = internals.objects.deref(attributes.entries.get(pdfName('Subtype').bytes));
  if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'NChannel') {
    return;
  }
  const process = internals.objects.deref(attributes.entries.get(pdfName('Process').bytes));
  if (process?.kind !== 'dictionary') {
    return;
  }
  const color = process.entries.get(COLOR_SPACE);
  if (color === undefined) {
    return;
  }
  const space = resolveSourceSpace(context.document, color, { resources: context.resources, sourceRgbProfile: context.options.sourceRgbProfile });
  if (space.kind === 'rgb') {
    throw new UnsupportedFeatureError('NChannel Process uses an RGB colour space', 'nchannel-process');
  }
};

const planSpace = (context: SpotContext, name: Uint8Array, value: PdfDirectObject, family?: 'separation'): SpotPlan | undefined => {
  const resolved = resolveSourceSpace(context.document, value, {
    resources: context.resources,
    sourceRgbProfile: context.options.sourceRgbProfile,
    options: { iccGray: context.options.iccGray ?? 'convert' },
  });
  if (resolved.kind !== 'separation' && (resolved.kind !== 'deviceN' || family === 'separation')) {
    return undefined;
  }
  const internals = internalsOf(context.document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const convertible = alternateSource(resolved.alternate) !== undefined;
  const original = internals.objects.deref(value);
  if (original?.kind !== 'array') {
    return convertible ? invalid('spot colour space is not an array') : undefined;
  }
  const colorants = resolved.kind === 'deviceN' ? colorantPlans(context, original) : { plans: [], discarded: [] };
  if (!convertible && colorants.plans.length === 0) {
    return undefined;
  }
  if (resolved.kind === 'deviceN') {
    checkNChannel(context, original);
  }
  const discarded: Array<PdfReference> = [...colorants.discarded];
  if (value.kind === 'reference') {
    discarded.push(value);
  }
  const functionValue = original.items.at(3);
  if (convertible && functionValue !== undefined) {
    discarded.push(...discardedFunctionObjects(internals, functionValue));
  }
  return { name, original, sampled: convertible ? convertedTint(context, resolved) : undefined, kind: resolved.kind, colorants: colorants.plans, discarded };
};

// ISO 32000-1:2008, 8.6.6.5, Table 71: the Colorants entry of a DeviceN attributes dictionary maps colorant names to Separation colour spaces.
const colorantPlans = (context: SpotContext, original: Extract<PdfDirectObject, { kind: 'array' }>): ColorantPlans => {
  const internals = internalsOf(context.document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const attributesValue = original.items.at(4);
  const attributes = internals.objects.deref(attributesValue);
  const colorantsValue = attributes?.kind === 'dictionary' ? attributes.entries.get(COLORANTS) : undefined;
  const colorants = internals.objects.deref(colorantsValue);
  if (colorants?.kind !== 'dictionary') {
    return { plans: [], discarded: [] };
  }
  const plans: Array<SpotPlan> = [];
  for (const [name, value] of colorants.entries.entries()) {
    // ISO 32000-1:2008, 7.3.7: an entry whose value is null is treated as absent, which covers a reference to a missing object (7.3.10).
    if (internals.objects.deref(value)?.kind === 'null') {
      continue;
    }
    const plan = planSpace(context, name, value, 'separation');
    if (plan !== undefined) {
      plans.push(plan);
    }
  }
  const discarded = plans.flatMap(plan => plan.discarded);
  for (const value of [attributesValue, colorantsValue]) {
    if (plans.length > 0 && value?.kind === 'reference') {
      discarded.push(value);
    }
  }
  return { plans, discarded };
};

const resourceSpots = (context: SpotContext): ResourceSpotPlan | undefined => {
  const { document, resources } = context;
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const spaces = internals.objects.deref(resources.get(COLOR_SPACE));
  if (spaces?.kind !== 'dictionary') {
    return undefined;
  }
  const spots: Array<SpotPlan> = [];
  for (const [name, value] of spaces.entries.entries()) {
    const plan = planSpace(context, name, value);
    if (plan !== undefined) {
      spots.push(plan);
    }
  }
  if (spots.length === 0) {
    return undefined;
  }
  const discarded: Array<PdfReference> = [];
  const old = resources.get(COLOR_SPACE);
  if (old?.kind === 'reference') {
    discarded.push(old);
  }
  for (const spot of spots) {
    discarded.push(...spot.discarded);
  }
  return { resources, spaces: spaces.entries, spots, discarded };
};

const pagePlan = (document: LoadedDocument, pageIndex: number, options: RewriteColorOptions): PagePlan | undefined => {
  const page = document.page(pageIndex);
  const planned = resourceSpots({ document, resources: page.resources(), options });
  return planned === undefined ? undefined : { ...planned, reference: page.reference };
};

const planCarriers = (
  context: SpotContext,
  page: { index: number; reference: PdfReference },
  state: { seen: CarrierSeen; plans: Array<CarrierPlan> },
): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  for (const carrier of resourceCarriers(internals, { ...page, resources: context.resources }, state.seen)) {
    const planned = resourceSpots({ document: context.document, resources: carrier.resources, options: context.options });
    if (planned !== undefined) {
      state.plans.push({ ...planned, carrier });
    }
  }
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

const sameTint = (left: ConvertedTint | undefined, right: ConvertedTint | undefined): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'sampled' && right.kind === 'sampled') {
    return sameBytes(left.data, right.data);
  }
  if (left.kind === 'stitched' && right.kind === 'stitched') {
    return (
      left.functions.length === right.functions.length &&
      left.functions.every((child, index) => sameBytes(child.data, right.functions[index]?.data ?? new Uint8Array()))
    );
  }
  return false;
};

const sameSpot = (left: SpotPlan, right: SpotPlan): boolean =>
  sameTint(left.sampled, right.sampled) &&
  left.colorants.length === right.colorants.length &&
  left.colorants.every((colorant, index) => {
    const other = right.colorants[index];
    return other !== undefined && sameBytes(colorant.name, other.name) && sameSpot(colorant, other);
  });

const scanImages = (context: SpotContext, plans: Map<number, ImagePlan>): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const category = internals.objects.deref(context.resources.get(XOBJECT));
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
    const color = image.dictionary.get(COLOR_SPACE);
    if (color === undefined) {
      continue;
    }
    const spot = planSpace(context, new Uint8Array(), color);
    if (spot === undefined) {
      continue;
    }
    const previous = plans.get(value.objectNumber);
    if (previous !== undefined) {
      if (!sameSpot(previous.spot, spot)) {
        throw new ValidationError('shared spot image has conflicting source spaces', 'color-space');
      }
      continue;
    }
    plans.set(value.objectNumber, { reference: value, image, spot });
  }
};

const convertedAttributes = (document: LoadedDocument, spot: SpotPlan, attributes: PdfDirectObject): PdfDirectObject => {
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const entries = internals.objects.deref(attributes);
  const colorants = entries?.kind === 'dictionary' ? internals.objects.deref(entries.entries.get(COLORANTS)) : undefined;
  if (entries?.kind !== 'dictionary' || colorants?.kind !== 'dictionary') {
    return invalid('DeviceN Colorants are missing');
  }
  const mapped = new PdfDictionaryEntries(colorants.entries.entries());
  for (const colorant of spot.colorants) {
    mapped.set(colorant.name, convertedArray(document, colorant));
  }
  const converted = new PdfDictionaryEntries(entries.entries.entries());
  converted.set(COLORANTS, pdfDictionary(mapped));
  return pdfDictionary(converted);
};

const convertedArray = (document: LoadedDocument, spot: SpotPlan): PdfDirectObject => {
  const [family, colorants, alternate, tint, attributes, ...rest] = spot.original.items;
  if (family === undefined || colorants === undefined || alternate === undefined || tint === undefined) {
    return invalid('spot colour space is incomplete');
  }
  const items: Array<PdfDirectObject> =
    spot.sampled === undefined ? [family, colorants, alternate, tint] : [family, colorants, pdfName('DeviceCMYK'), writeCmykFunction(document, spot.sampled)];
  if (attributes !== undefined) {
    items.push(spot.colorants.length === 0 ? attributes : convertedAttributes(document, spot, attributes));
  }
  items.push(...rest);
  return pdfArray(items);
};

const convertedResources = (document: LoadedDocument, plan: ResourceSpotPlan): PdfDictionaryEntries => {
  const spaces = new PdfDictionaryEntries(plan.spaces.entries());
  for (const spot of plan.spots) {
    spaces.set(spot.name, convertedArray(document, spot));
  }
  const resources = new PdfDictionaryEntries(plan.resources.entries());
  resources.set(COLOR_SPACE, pdfDictionary(spaces));
  return resources;
};

const applyPage = (document: LoadedDocument, plan: PagePlan): Array<PdfReference> => {
  const page = document.get(plan.reference);
  if (page.kind !== 'dictionary') {
    return invalid('page is not a dictionary');
  }
  const discarded = [...plan.discarded];
  const oldResources = page.entries.get(RESOURCES);
  if (oldResources?.kind === 'reference') {
    discarded.push(oldResources);
  }
  page.entries.set(RESOURCES, pdfDictionary(convertedResources(document, plan)));
  document.set(plan.reference, page);
  return discarded;
};

const applyCarrier = (document: LoadedDocument, plan: CarrierPlan): Array<PdfReference> => [
  ...plan.discarded,
  ...replaceCarrierResources(document, plan.carrier, convertedResources(document, plan)),
];

const applyImage = (document: LoadedDocument, plan: ImagePlan): Array<PdfReference> => {
  const dictionary = new PdfDictionaryEntries(plan.image.dictionary.entries());
  dictionary.set(COLOR_SPACE, convertedArray(document, plan.spot));
  document.set(plan.reference, { kind: 'stream', dictionary, data: plan.image.data });
  return [...plan.spot.discarded];
};

/** Converts RGB or calibrated-gray alternates while preserving every colorant name object, in page and image colour spaces and in the own resources of every form, tiling pattern, Type 3 font and appearance stream a page reaches; the ColorSpace resources of a soft-mask group, and of carriers only it reaches, keep theirs. ISO 32000-1:2008, 8.6.6.4–5 defines Separation and DeviceN names, alternates and tint transforms. */
export const convertSpotSpaces = (document: LoadedDocument, options: RewriteColorOptions): SpotConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) {
    return invalid('document internals are unavailable');
  }
  const pages: Array<PagePlan> = [];
  const carriers: Array<CarrierPlan> = [];
  const images = new Map<number, ImagePlan>();
  const seenCarriers = carrierSeen();
  for (let page = 0; page < document.pageCount; page++) {
    const planned = pagePlan(document, page, options);
    if (planned !== undefined) {
      pages.push(planned);
    }
    const entry = internals.pages[page];
    if (entry === undefined) {
      return invalid('page entry is missing');
    }
    planCarriers(
      { document, resources: document.page(page).resources(), options },
      { index: page, reference: entry.reference },
      { seen: seenCarriers, plans: carriers },
    );
    const resources: PdfDirectObject = { kind: 'dictionary', entries: document.page(page).resources() };
    const unreadable = walkResources(internals, entry, {
      resources,
      visit: visit => {
        scanImages({ document, resources: visit.resources, options }, images);
      },
    });
    if (unreadable.length > 0) {
      throw new ValidationError('spot resources cannot be read', 'unreadable-resource');
    }
  }
  const planned = [...pages.flatMap(plan => plan.spots), ...carriers.flatMap(plan => plan.spots), ...[...images.values()].map(plan => plan.spot)];
  if (planned.length === 0) {
    return { separations: 0, deviceN: 0, approximations: [] };
  }
  const discarded: Array<PdfReference> = [];
  for (const plan of pages) {
    discarded.push(...applyPage(document, plan));
  }
  for (const plan of carriers) {
    discarded.push(...applyCarrier(document, plan));
  }
  for (const plan of images.values()) {
    discarded.push(...applyImage(document, plan));
  }
  deleteDiscarded(document, internals, discarded);
  internals.objects.requireFullRewrite('color-conversion');
  // A DeviceN whose own tint needs no conversion counts only through its converted Colorants.
  const spots = planned
    .flatMap(spot => [spot, ...spot.colorants])
    .flatMap(spot => (spot.sampled === undefined ? [] : [{ kind: spot.kind, sampled: spot.sampled }]));
  const approximations = spots.flatMap(spot => {
    const functions = spot.sampled.kind === 'sampled' ? [spot.sampled] : spot.sampled.functions;
    return functions.filter(item => item.maxDeltaE2000 > 0.1).map(item => ({ maxDeltaE2000: item.maxDeltaE2000 }));
  });
  return {
    separations: spots.filter(spot => spot.kind === 'separation').length,
    deviceN: spots.filter(spot => spot.kind === 'deviceN').length,
    approximations,
  };
};

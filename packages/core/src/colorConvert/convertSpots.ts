import type { ColorSource } from '../color/createColorTransform.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';
import type { SampledCmykFunction } from './sampleCmykFunction.ts';
import type { SourceSpace } from './sourceSpace.ts';
import type { ConvertedCmykFunction, StitchedCmykFunction } from './stitchCmykFunction.ts';

import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfName } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { deleteDiscarded } from './discardedObjects.ts';
import { checkConversionRefusals } from './preflight.ts';
import { sampleCmykFunction } from './sampleCmykFunction.ts';
import { resolveSourceSpace } from './sourceSpace.ts';
import { stitchCmykFunction, writeCmykFunction } from './stitchCmykFunction.ts';

export interface SpotConversionReport {
  readonly separations: number;
  readonly deviceN: number;
  readonly approximations: readonly { readonly maxDeltaE2000: number }[];
}

interface SpotContext {
  readonly document: LoadedDocument;
  readonly resources: PdfDictionaryEntries;
  readonly options: RewriteColorOptions;
}

type SampledFunction = SampledCmykFunction;

type ConvertedTint = ConvertedCmykFunction;

interface TintEvaluator {
  readonly evaluate: PdfFunction;
  readonly domain: readonly number[];
}

interface SpotPlan {
  readonly name: Uint8Array;
  readonly original: Extract<PdfDirectObject, { kind: 'array' }>;
  readonly sampled: ConvertedTint;
  readonly kind: 'separation' | 'deviceN';
  readonly discarded: readonly PdfReference[];
}

interface ResourceSpotPlan {
  readonly resources: PdfDictionaryEntries;
  readonly spaces: PdfDictionaryEntries;
  readonly spots: readonly SpotPlan[];
  readonly discarded: readonly PdfReference[];
}

interface PagePlan extends ResourceSpotPlan {
  readonly reference: PdfReference;
}

interface FormPlan extends ResourceSpotPlan {
  readonly reference: PdfReference;
  readonly form: PdfStream;
}

interface ImagePlan {
  readonly reference: PdfReference;
  readonly image: PdfStream;
  readonly spot: SpotPlan;
}

const COLOR_SPACE = pdfName('ColorSpace').bytes;
const RESOURCES = pdfName('Resources').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const numeric = (value: PdfDirectObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real') return typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator);
  return invalid('tint function domain is not numeric');
};

const functionDomain = (object: PdfDirectObject | PdfStream, dimensions: number): number[] => {
  let dictionary: PdfDictionaryEntries | undefined = undefined;
  if (object.kind === 'stream') ({ dictionary } = object);
  else if (object.kind === 'dictionary') ({ entries: dictionary } = object);
  const domain = dictionary?.get(pdfName('Domain').bytes);
  if (domain?.kind !== 'array' || domain.items.length !== dimensions * 2) return invalid('tint function Domain has the wrong dimensions');
  return domain.items.map(item => numeric(item));
};

const tintFunction = (document: LoadedDocument, tint: SourceSpace & { kind: 'separation' | 'deviceN' }, dimensions: number): TintEvaluator => {
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const resolve = (value: PdfDirectObject): PdfObject => {
    const child = internals.objects.deref(value);
    if (child === undefined) return invalid('tint function is missing');
    if (child.kind !== 'stream') return child;
    const data = decodedData(internals, child);
    if (typeof data === 'string') return invalid(`tint function cannot be decoded: ${data}`);
    return { kind: 'stream', dictionary: child.dictionary, data };
  };
  const object = tint.tint;
  if (object.kind === 'stream') {
    const data = decodedData(internals, object);
    if (typeof data === 'string') return invalid(`tint function cannot be decoded: ${data}`);
    const decoded: PdfStream = { kind: 'stream', dictionary: object.dictionary, data };
    return { evaluate: createPdfFunction(decoded, resolve), domain: functionDomain(decoded, dimensions) };
  }
  return { evaluate: createPdfFunction(object, resolve), domain: functionDomain(object, dimensions) };
};

const alternateSource = (space: SourceSpace): ColorSource | undefined => (space.kind === 'rgb' || space.kind === 'gray' ? space.source : undefined);

const sampleFunction = (context: SpotContext, space: SourceSpace & { kind: 'separation' | 'deviceN' }): SampledFunction => {
  const dimensions = space.kind === 'separation' ? 1 : space.names.length;
  if (dimensions > 4) throw new UnsupportedFeatureError('DeviceN has more than four colourants', 'device-n-components');
  const source = alternateSource(space.alternate);
  if (source === undefined) return invalid('spot alternate is not a convertible RGB or gray space');
  const original = tintFunction(context.document, space, dimensions);
  const intent = context.options.intent === undefined || context.options.intent === 'document' ? 'relativeColorimetric' : context.options.intent;
  const transform = createColorTransform(source, context.options.outputProfile, {
    intent,
    blackPointCompensation: context.options.blackPointCompensation !== false,
    lut8LabEncoding: context.options.lut8LabEncoding ?? 'icc',
  });
  const evaluate = (tints: readonly number[]): Float64Array => {
    const output = new Float64Array(4);
    transform.convert(Float64Array.from(original.evaluate(tints)), output);
    return output;
  };
  return sampleCmykFunction({ dimensions, domain: original.domain, evaluate, destination: context.options.outputProfile, grid: 17 });
};

const stitchedFunction = (context: SpotContext, space: SourceSpace & { kind: 'separation' | 'deviceN' }): StitchedCmykFunction => {
  if (space.kind !== 'separation') return invalid('DeviceN stitching functions are unsupported');
  return stitchCmykFunction(context.document, space.tint, child => sampleFunction(context, { ...space, tint: child }));
};

const convertedTint = (context: SpotContext, space: SourceSpace & { kind: 'separation' | 'deviceN' }): ConvertedTint => {
  const { tint } = space;
  let entries: PdfDictionaryEntries | undefined = undefined;
  if (tint.kind === 'dictionary') ({ entries } = tint);
  else if (tint.kind === 'stream') ({ dictionary: entries } = tint);
  const type = entries?.get(pdfName('FunctionType').bytes);
  return type?.kind === 'integer' && type.value === 3 ? stitchedFunction(context, space) : sampleFunction(context, space);
};

const checkNChannel = (context: SpotContext, original: Extract<PdfDirectObject, { kind: 'array' }>): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const attributes = internals.objects.deref(original.items[4]);
  if (attributes?.kind !== 'dictionary') return;
  const subtype = internals.objects.deref(attributes.entries.get(pdfName('Subtype').bytes));
  if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'NChannel') return;
  const process = internals.objects.deref(attributes.entries.get(pdfName('Process').bytes));
  if (process?.kind !== 'dictionary') return;
  const color = process.entries.get(COLOR_SPACE);
  if (color === undefined) return;
  const space = resolveSourceSpace(context.document, color, { resources: context.resources, sourceRgbProfile: context.options.sourceRgbProfile });
  if (space.kind === 'rgb') throw new UnsupportedFeatureError('NChannel Process uses an RGB colour space', 'nchannel-process');
};

const planSpace = (context: SpotContext, name: Uint8Array, value: PdfDirectObject): SpotPlan | undefined => {
  const resolved = resolveSourceSpace(context.document, value, {
    resources: context.resources,
    sourceRgbProfile: context.options.sourceRgbProfile,
    options: { iccGray: context.options.iccGray ?? 'convert' },
  });
  if (resolved.kind !== 'separation' && resolved.kind !== 'deviceN') return undefined;
  if (alternateSource(resolved.alternate) === undefined) return undefined;
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const original = internals.objects.deref(value);
  if (original?.kind !== 'array') return invalid('spot colour space is not an array');
  if (resolved.kind === 'deviceN') checkNChannel(context, original);
  const discarded: PdfReference[] = [];
  if (value.kind === 'reference') discarded.push(value);
  const functionValue = original.items.at(3);
  if (functionValue?.kind === 'reference') discarded.push(functionValue);
  const { tint } = resolved;
  if (tint.kind === 'dictionary') {
    const children = tint.entries.get(pdfName('Functions').bytes);
    if (children?.kind === 'array') for (const child of children.items) if (child.kind === 'reference') discarded.push(child);
  }
  return { name, original, sampled: convertedTint(context, resolved), kind: resolved.kind, discarded };
};

const resourceSpots = (context: SpotContext): ResourceSpotPlan | undefined => {
  const { document, resources } = context;
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const spaces = internals.objects.deref(resources.get(COLOR_SPACE));
  if (spaces?.kind !== 'dictionary') return undefined;
  const spots: SpotPlan[] = [];
  for (const [name, value] of spaces.entries.entries()) {
    const plan = planSpace(context, name, value);
    if (plan !== undefined) spots.push(plan);
  }
  if (spots.length === 0) return undefined;
  const discarded: PdfReference[] = [];
  const old = resources.get(COLOR_SPACE);
  if (old?.kind === 'reference') discarded.push(old);
  for (const spot of spots) discarded.push(...spot.discarded);
  return { resources, spaces: spaces.entries, spots, discarded };
};

const pagePlan = (document: LoadedDocument, pageIndex: number, options: RewriteColorOptions): PagePlan | undefined => {
  const page = document.page(pageIndex);
  const planned = resourceSpots({ document, resources: page.resources(), options });
  return planned === undefined ? undefined : { ...planned, reference: page.reference };
};

const scanForms = (context: SpotContext, state: { seen: Set<number>; plans: FormPlan[] }): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const category = internals.objects.deref(context.resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') return;
  for (const [, value] of category.entries.entries()) {
    if (value.kind !== 'reference' || state.seen.has(value.objectNumber)) continue;
    const form = internals.objects.deref(value);
    if (form?.kind !== 'stream') continue;
    const subtype = internals.objects.deref(form.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'Form') continue;
    state.seen.add(value.objectNumber);
    const own = internals.objects.deref(form.dictionary.get(RESOURCES));
    const resources = own?.kind === 'dictionary' ? own.entries : context.resources;
    if (own?.kind === 'dictionary') {
      const planned = resourceSpots({ document: context.document, resources, options: context.options });
      if (planned !== undefined) state.plans.push({ ...planned, reference: value, form });
    }
    scanForms({ document: context.document, resources, options: context.options }, state);
  }
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

const sameTint = (left: ConvertedTint, right: ConvertedTint): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'sampled' && right.kind === 'sampled') return sameBytes(left.data, right.data);
  if (left.kind === 'stitched' && right.kind === 'stitched') {
    return (
      left.functions.length === right.functions.length &&
      left.functions.every((child, index) => sameBytes(child.data, right.functions[index]?.data ?? new Uint8Array()))
    );
  }
  return false;
};

const scanImages = (context: SpotContext, plans: Map<number, ImagePlan>): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const category = internals.objects.deref(context.resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') return;
  for (const [, value] of category.entries.entries()) {
    if (value.kind !== 'reference') continue;
    const image = internals.objects.deref(value);
    if (image?.kind !== 'stream') continue;
    const subtype = internals.objects.deref(image.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'Image') continue;
    const color = image.dictionary.get(COLOR_SPACE);
    if (color === undefined) continue;
    const spot = planSpace(context, new Uint8Array(), color);
    if (spot === undefined) continue;
    const previous = plans.get(value.objectNumber);
    if (previous !== undefined) {
      if (!sameTint(previous.spot.sampled, spot.sampled)) {
        throw new ValidationError('shared spot image has conflicting source spaces', 'color-space');
      }
      continue;
    }
    plans.set(value.objectNumber, { reference: value, image, spot });
  }
};

const convertedArray = (document: LoadedDocument, spot: SpotPlan): PdfDirectObject => {
  const functionReference = writeCmykFunction(document, spot.sampled);
  const [family, colorants] = spot.original.items;
  if (family === undefined || colorants === undefined) return invalid('spot colour space is incomplete');
  const items: PdfDirectObject[] = [family, colorants, pdfName('DeviceCMYK'), functionReference];
  for (const extra of spot.original.items.slice(4)) items.push(extra);
  return pdfArray(items);
};

const convertedResources = (document: LoadedDocument, plan: ResourceSpotPlan): PdfDictionaryEntries => {
  const spaces = new PdfDictionaryEntries(plan.spaces.entries());
  for (const spot of plan.spots) spaces.set(spot.name, convertedArray(document, spot));
  const resources = new PdfDictionaryEntries(plan.resources.entries());
  resources.set(COLOR_SPACE, pdfDictionary(spaces));
  return resources;
};

const applyPage = (document: LoadedDocument, plan: PagePlan): PdfReference[] => {
  const page = document.get(plan.reference);
  if (page.kind !== 'dictionary') return invalid('page is not a dictionary');
  const discarded = [...plan.discarded];
  const oldResources = page.entries.get(RESOURCES);
  if (oldResources?.kind === 'reference') discarded.push(oldResources);
  page.entries.set(RESOURCES, pdfDictionary(convertedResources(document, plan)));
  document.set(plan.reference, page);
  return discarded;
};

const applyForm = (document: LoadedDocument, plan: FormPlan): PdfReference[] => {
  const dictionary = new PdfDictionaryEntries(plan.form.dictionary.entries());
  const discarded = [...plan.discarded];
  const oldResources = dictionary.get(RESOURCES);
  if (oldResources?.kind === 'reference') discarded.push(oldResources);
  dictionary.set(RESOURCES, pdfDictionary(convertedResources(document, plan)));
  document.set(plan.reference, { kind: 'stream', dictionary, data: plan.form.data });
  return discarded;
};

const applyImage = (document: LoadedDocument, plan: ImagePlan): PdfReference[] => {
  const dictionary = new PdfDictionaryEntries(plan.image.dictionary.entries());
  dictionary.set(COLOR_SPACE, convertedArray(document, plan.spot));
  document.set(plan.reference, { kind: 'stream', dictionary, data: plan.image.data });
  return [...plan.spot.discarded];
};

/** Converts RGB or calibrated-gray alternates while preserving every colorant name object. */
export const convertSpotSpaces = (document: LoadedDocument, options: RewriteColorOptions): SpotConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const pages: PagePlan[] = [];
  const forms: FormPlan[] = [];
  const images = new Map<number, ImagePlan>();
  const seenForms = new Set<number>();
  for (let page = 0; page < document.pageCount; page++) {
    const planned = pagePlan(document, page, options);
    if (planned !== undefined) pages.push(planned);
    scanForms({ document, resources: document.page(page).resources(), options }, { seen: seenForms, plans: forms });
    const entry = internals.pages[page];
    if (entry === undefined) return invalid('page entry is missing');
    const resources: PdfDirectObject = { kind: 'dictionary', entries: document.page(page).resources() };
    const unreadable = walkResources(internals, entry, {
      resources,
      visit: visit => {
        scanImages({ document, resources: visit.resources, options }, images);
      },
    });
    if (unreadable.length > 0) throw new ValidationError('spot resources cannot be read', 'unreadable-resource');
  }
  const spots = [...pages.flatMap(plan => plan.spots), ...forms.flatMap(plan => plan.spots), ...[...images.values()].map(plan => plan.spot)];
  if (spots.length === 0) return { separations: 0, deviceN: 0, approximations: [] };
  const discarded: PdfReference[] = [];
  for (const plan of pages) discarded.push(...applyPage(document, plan));
  for (const plan of forms) discarded.push(...applyForm(document, plan));
  for (const plan of images.values()) discarded.push(...applyImage(document, plan));
  deleteDiscarded(document, internals, discarded);
  internals.objects.requireFullRewrite('color-conversion');
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

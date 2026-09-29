import type { ColorSource, ColorTransform } from '../color/createColorTransform.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ColorEntryState, RewriteColorOptions, ShadingUse } from './rewriteContent.ts';
import type { ConvertedCmykFunction } from './stitchCmykFunction.ts';

import { createColorTransform } from '../color/createColorTransform.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfName, pdfReal } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { combineContentStreams } from './combinedContent.ts';
import { deleteDiscarded } from './discardedObjects.ts';
import { checkConversionRefusals } from './preflight.ts';
import { rewriteContentColors } from './rewriteContent.ts';
import { sampleCmykFunction } from './sampleCmykFunction.ts';
import { resolveSourceSpace } from './sourceSpace.ts';
import { stitchCmykFunction, writeCmykFunction } from './stitchCmykFunction.ts';

export interface ShadingConversionReport {
  readonly shadings: number;
  readonly approximations: readonly { readonly maxDeltaE2000: number }[];
}

interface ShadingContext {
  readonly document: LoadedDocument;
  readonly resources: PdfDictionaryEntries;
  readonly options: RewriteColorOptions;
  readonly intent?: RenderingIntent | undefined;
}

interface ShadingUsage {
  readonly indirect: Map<number, RenderingIntent>;
  readonly direct: Map<string, RenderingIntent>;
  readonly activeForms: Set<number>;
}

interface ShadingPlan {
  readonly reference: PdfReference | undefined;
  readonly shading: Extract<PdfObject, { kind: 'dictionary' }>;
  readonly sampled: ConvertedCmykFunction;
  readonly background: PdfDirectObject | undefined;
  readonly discarded: readonly PdfReference[];
}

interface DirectShadingPlan {
  readonly page: PdfReference;
  readonly resources: PdfDictionaryEntries;
  readonly name: Uint8Array;
  readonly shading: ShadingPlan;
}

interface FormShadingPlan {
  readonly form: PdfReference;
  readonly stream: PdfStream;
  readonly resources: PdfDictionaryEntries;
  readonly name: Uint8Array;
  readonly shading: ShadingPlan;
}

interface PatternShadingPlan {
  readonly pattern: PdfReference;
  readonly shading: ShadingPlan;
}

const SHADING = pdfName('Shading').bytes;
const PATTERN = pdfName('Pattern').bytes;
const PATTERN_TYPE = pdfName('PatternType').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const SHADING_TYPE = pdfName('ShadingType').bytes;
const FUNCTION = pdfName('Function').bytes;
const DOMAIN = pdfName('Domain').bytes;
const BACKGROUND = pdfName('Background').bytes;
const RESOURCES = pdfName('Resources').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const useKey = (scope: PdfReference, name: Uint8Array): string =>
  `${String(scope.objectNumber)}:${String(scope.generation)}:${new TextDecoder('latin1').decode(name)}`;

const rememberIntent = <Key>(values: Map<Key, RenderingIntent>, key: Key, intent: RenderingIntent): void => {
  const previous = values.get(key);
  if (previous !== undefined && previous !== intent) throw new ValidationError('one shading is used with different rendering intents', 'color-space');
  values.set(key, intent);
};

const recordShadingUses = (input: { context: ShadingContext; scope: PdfReference; uses: readonly ShadingUse[] }, usage: ShadingUsage): void => {
  const { context, scope, uses } = input;
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const category = internals.objects.deref(context.resources.get(SHADING));
  if (category?.kind !== 'dictionary') return;
  for (const use of uses) {
    const value = category.entries.get(use.name);
    if (value?.kind === 'reference') rememberIntent(usage.indirect, value.objectNumber, use.intent);
    else if (value?.kind === 'dictionary') rememberIntent(usage.direct, useKey(scope, use.name), use.intent);
  }
};

interface UsageStream {
  readonly context: ShadingContext;
  readonly scope: PdfReference;
  readonly bytes: Uint8Array;
  readonly usage: ShadingUsage;
  readonly initialState?: ColorEntryState | undefined;
}

const scanUsageStream = (stream: UsageStream): void => {
  const { context, scope, bytes, usage, initialState } = stream;
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const rewritten = rewriteContentColors(context.document, bytes, {
    resources: context.resources,
    options: context.options,
    initialState,
    overprintNames: { off: 'PWOPM0', on: 'PWOPM1' },
  });
  recordShadingUses({ context, scope, uses: rewritten.shadingUses }, usage);
  const category = internals.objects.deref(context.resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') return;
  for (const use of rewritten.formUses) {
    const reference = category.entries.get(use.name);
    if (reference?.kind !== 'reference') continue;
    const form = internals.objects.deref(reference);
    if (form?.kind !== 'stream') continue;
    const subtype = internals.objects.deref(form.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'Form') continue;
    if (usage.activeForms.has(reference.objectNumber)) throw new ResourceLimitError('recursive form shading walk is unsupported');
    const own = internals.objects.deref(form.dictionary.get(RESOURCES));
    const resources = own?.kind === 'dictionary' ? own.entries : context.resources;
    const data = decodedData(internals, form);
    if (typeof data === 'string') return invalid(`form content cannot be read: ${data}`);
    usage.activeForms.add(reference.objectNumber);
    try {
      scanUsageStream({
        context: { document: context.document, resources, options: context.options },
        scope: reference,
        bytes: data,
        initialState: use.entry,
        usage,
      });
    } finally {
      usage.activeForms.delete(reference.objectNumber);
    }
  }
};

const collectUsage = (document: LoadedDocument, options: RewriteColorOptions): ShadingUsage => {
  const usage: ShadingUsage = { indirect: new Map(), direct: new Map(), activeForms: new Set() };
  if (options.intent !== undefined && options.intent !== 'document') return usage;
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) return invalid('page entry is missing');
    const content = pageContent(internals, entry);
    if (content.problems.length > 0) return invalid(`page content cannot be read: ${content.problems.join('; ')}`);
    scanUsageStream({
      context: { document, resources: document.page(page).resources(), options },
      scope: entry.reference,
      bytes: combineContentStreams(content.streams),
      usage,
    });
  }
  return usage;
};

const numeric = (value: PdfDirectObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real') return typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator);
  return invalid('shading function has a nonnumeric value');
};

const arrayNumbers = (value: PdfDirectObject | undefined, expected: number): number[] => {
  if (value?.kind !== 'array' || value.items.length !== expected) return invalid('shading numeric array has the wrong length');
  return value.items.map(item => numeric(item));
};

const decodedFunction = (document: LoadedDocument, value: PdfObject): PdfObject => {
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const object = value.kind === 'stream' ? value : internals.objects.deref(value);
  if (object === undefined) return invalid('shading function is missing');
  if (object.kind !== 'stream') return object;
  const data = decodedData(internals, object);
  if (typeof data === 'string') return invalid(`shading function cannot be decoded: ${data}`);
  const decoded: PdfStream = { kind: 'stream', dictionary: object.dictionary, data };
  return decoded;
};

const evaluator = (document: LoadedDocument, value: PdfDirectObject, channels: number): PdfFunction => {
  if (value.kind !== 'array') return createPdfFunction(decodedFunction(document, value), child => decodedFunction(document, child));
  if (value.items.length !== channels) return invalid('shading Function array disagrees with its colour space');
  const functions = value.items.map(item => createPdfFunction(decodedFunction(document, item), child => decodedFunction(document, child)));
  return input => functions.map(fn => fn(input)[0] ?? 0);
};

const transformFor = (context: ShadingContext, source: ColorSource): ColorTransform => {
  const intent =
    context.options.intent === undefined || context.options.intent === 'document' ? (context.intent ?? 'relativeColorimetric') : context.options.intent;
  return createColorTransform(source, context.options.outputProfile, {
    intent,
    blackPointCompensation: context.options.blackPointCompensation !== false,
    lut8LabEncoding: context.options.lut8LabEncoding ?? 'icc',
  });
};

const backgroundFor = (value: PdfDirectObject | undefined, channels: number, transform: ColorTransform): PdfDirectObject | undefined => {
  if (value === undefined) return undefined;
  const input = arrayNumbers(value, channels);
  const output = new Float64Array(4);
  transform.convert(Float64Array.from(input), output);
  return pdfArray([...output].map(component => pdfReal(component)));
};

const stitchedShading = (context: ShadingContext, source: PdfObject, transform: ColorTransform): ConvertedCmykFunction =>
  stitchCmykFunction(context.document, source, child => {
    const decoded = decodedFunction(context.document, child);
    if (decoded.kind !== 'dictionary' && decoded.kind !== 'stream') return invalid('stitching subfunction is invalid');
    const entries = decoded.kind === 'stream' ? decoded.dictionary : decoded.entries;
    const domain = arrayNumbers(entries.get(DOMAIN), 2);
    const fn = createPdfFunction(decoded);
    const evaluate = (input: readonly number[]): Float64Array => {
      const output = new Float64Array(4);
      transform.convert(Float64Array.from(fn(input)), output);
      return output;
    };
    return sampleCmykFunction({ dimensions: 1, domain, evaluate, destination: context.options.outputProfile, minimumGrid: 2, midpointTolerance: 0.5 });
  });

const sampledShading = (config: {
  context: ShadingContext;
  value: PdfDirectObject;
  transform: ColorTransform;
  channels: number;
  dimensions: number;
  domain: readonly number[];
}): ConvertedCmykFunction => {
  const { context, value, transform, channels, dimensions, domain } = config;
  const sourceFunction = decodedFunction(context.document, value);
  let entries: PdfDictionaryEntries | undefined = undefined;
  if (sourceFunction.kind === 'dictionary') ({ entries } = sourceFunction);
  else if (sourceFunction.kind === 'stream') ({ dictionary: entries } = sourceFunction);
  const functionType = entries?.get(pdfName('FunctionType').bytes);
  if (functionType?.kind === 'integer' && functionType.value === 3 && dimensions === 1) return stitchedShading(context, sourceFunction, transform);
  const fn = evaluator(context.document, value, channels);
  const evaluate = (values: readonly number[]): Float64Array => {
    const output = new Float64Array(4);
    transform.convert(Float64Array.from(fn(values)), output);
    return output;
  };
  return sampleCmykFunction({ dimensions, domain, evaluate, destination: context.options.outputProfile, grid: 65, minimumGrid: 2, midpointTolerance: 0.5 });
};

const discardedFunctions = (document: LoadedDocument, functionValue: PdfDirectObject): PdfReference[] => {
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const discarded: PdfReference[] = [];
  const seen = new Set<number>();
  const pending: PdfDirectObject[] = [functionValue];
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (value.kind === 'array') {
      pending.push(...value.items);
      continue;
    }
    if (value.kind === 'reference') {
      if (seen.has(value.objectNumber)) continue;
      seen.add(value.objectNumber);
      discarded.push(value);
    }
    const object = internals.objects.deref(value);
    let entries: PdfDictionaryEntries | undefined = undefined;
    if (object?.kind === 'dictionary') ({ entries } = object);
    else if (object?.kind === 'stream') ({ dictionary: entries } = object);
    const children = entries?.get(pdfName('Functions').bytes);
    if (children !== undefined) pending.push(children);
  }
  return discarded;
};

const planShading = (
  context: ShadingContext,
  reference: PdfReference | undefined,
  shading: Extract<PdfObject, { kind: 'dictionary' }>,
): ShadingPlan | undefined => {
  const type = shading.entries.get(SHADING_TYPE);
  if (type?.kind !== 'integer' || type.value < 1 || type.value > 3) return undefined;
  const color = shading.entries.get(COLOR_SPACE);
  if (color === undefined) return invalid('shading ColorSpace is missing');
  const space = resolveSourceSpace(context.document, color, {
    resources: context.resources,
    sourceRgbProfile: context.options.sourceRgbProfile,
    options: { iccGray: context.options.iccGray ?? 'convert' },
  });
  if (space.kind !== 'rgb' && space.kind !== 'gray') return undefined;
  const channels = space.kind === 'rgb' ? 3 : 1;
  const dimensions = type.value === 1 ? 2 : 1;
  const domain =
    shading.entries.get(DOMAIN) === undefined
      ? Array.from({ length: dimensions }, () => [0, 1]).flat()
      : arrayNumbers(shading.entries.get(DOMAIN), dimensions * 2);
  const functionValue = shading.entries.get(FUNCTION);
  if (functionValue === undefined) return invalid('function shading has no Function');
  const transform = transformFor(context, space.source);
  const sampled = sampledShading({ context, value: functionValue, transform, channels, dimensions, domain });
  return {
    reference,
    shading,
    sampled,
    background: backgroundFor(shading.entries.get(BACKGROUND), channels, transform),
    discarded: discardedFunctions(context.document, functionValue),
  };
};

const scanResources = (context: ShadingContext, plans: Map<number, ShadingPlan>, usage: ShadingUsage): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const planReference = (value: PdfDirectObject): void => {
    if (value.kind !== 'reference' || plans.has(value.objectNumber)) return;
    const shading = internals.objects.deref(value);
    if (shading?.kind !== 'dictionary') return;
    const planned = planShading({ ...context, intent: usage.indirect.get(value.objectNumber) }, value, shading);
    if (planned !== undefined) plans.set(value.objectNumber, planned);
  };
  const category = internals.objects.deref(context.resources.get(SHADING));
  if (category?.kind === 'dictionary') for (const [, value] of category.entries.entries()) planReference(value);
  const patterns = internals.objects.deref(context.resources.get(PATTERN));
  if (patterns?.kind !== 'dictionary') return;
  for (const [, value] of patterns.entries.entries()) {
    const pattern = internals.objects.deref(value);
    if (pattern?.kind !== 'dictionary') continue;
    const type = pattern.entries.get(PATTERN_TYPE);
    if (type?.kind !== 'integer' || type.value !== 2) continue;
    const shading = pattern.entries.get(SHADING);
    if (shading !== undefined) planReference(shading);
  }
};

const directPatternPlans = (context: ShadingContext, plans: Map<number, PatternShadingPlan>): void => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const category = internals.objects.deref(context.resources.get(PATTERN));
  if (category?.kind !== 'dictionary') return;
  for (const [, value] of category.entries.entries()) {
    if (value.kind !== 'reference' || plans.has(value.objectNumber)) continue;
    const pattern = internals.objects.deref(value);
    if (pattern?.kind !== 'dictionary') continue;
    const type = pattern.entries.get(PATTERN_TYPE);
    if (type?.kind !== 'integer' || type.value !== 2) continue;
    const direct = pattern.entries.get(SHADING);
    if (direct?.kind !== 'dictionary') continue;
    const shading = planShading(context, undefined, direct);
    if (shading !== undefined) plans.set(value.objectNumber, { pattern: value, shading });
  }
};

const directPagePlans = (context: ShadingContext, page: PdfReference, usage: ShadingUsage): DirectShadingPlan[] => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const category = internals.objects.deref(context.resources.get(SHADING));
  if (category?.kind !== 'dictionary') return [];
  const plans: DirectShadingPlan[] = [];
  for (const [name, value] of category.entries.entries()) {
    if (value.kind !== 'dictionary') continue;
    const shading = planShading({ ...context, intent: usage.direct.get(useKey(page, name)) }, undefined, value);
    if (shading !== undefined) plans.push({ page, resources: context.resources, name, shading });
  }
  return plans;
};

const formShadingResources = (context: ShadingContext, target: { reference: PdfReference; form: PdfStream }, usage: ShadingUsage): FormShadingPlan[] => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const shadings = internals.objects.deref(context.resources.get(SHADING));
  if (shadings?.kind !== 'dictionary') return [];
  const plans: FormShadingPlan[] = [];
  for (const [name, entry] of shadings.entries.entries()) {
    if (entry.kind !== 'dictionary') continue;
    const shading = planShading({ ...context, intent: usage.direct.get(useKey(target.reference, name)) }, undefined, entry);
    if (shading !== undefined) plans.push({ form: target.reference, stream: target.form, resources: context.resources, name, shading });
  }
  return plans;
};

const directFormPlans = (context: ShadingContext, state: { seen: Set<number>; usage: ShadingUsage }): FormShadingPlan[] => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const category = internals.objects.deref(context.resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') return [];
  const plans: FormShadingPlan[] = [];
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
      plans.push(...formShadingResources({ document: context.document, resources, options: context.options }, { reference: value, form }, state.usage));
    }
    plans.push(...directFormPlans({ document: context.document, resources, options: context.options }, state));
  }
  return plans;
};

const convertedDictionary = (document: LoadedDocument, plan: ShadingPlan): PdfDictionaryEntries => {
  const functionReference = writeCmykFunction(document, plan.sampled);
  const dictionary = new PdfDictionaryEntries(plan.shading.entries.entries());
  dictionary.set(COLOR_SPACE, pdfName('DeviceCMYK'));
  dictionary.set(FUNCTION, functionReference);
  if (plan.background !== undefined) dictionary.set(BACKGROUND, plan.background);
  return dictionary;
};

const applyDirectPages = (document: LoadedDocument, plans: readonly DirectShadingPlan[]): PdfReference[] => {
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const grouped = new Map<number, DirectShadingPlan[]>();
  for (const plan of plans) {
    const list = grouped.get(plan.page.objectNumber) ?? [];
    list.push(plan);
    grouped.set(plan.page.objectNumber, list);
  }
  const discarded: PdfReference[] = [];
  for (const group of grouped.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const page = document.get(first.page);
    if (page.kind !== 'dictionary') return invalid('page is not a dictionary');
    const category = internals.objects.deref(first.resources.get(SHADING));
    if (category?.kind !== 'dictionary') return invalid('Shading resources are missing');
    const mapped = new PdfDictionaryEntries(category.entries.entries());
    for (const plan of group) {
      mapped.set(plan.name, { kind: 'dictionary', entries: convertedDictionary(document, plan.shading) });
      discarded.push(...plan.shading.discarded);
    }
    const resources = new PdfDictionaryEntries(first.resources.entries());
    const oldShadings = resources.get(SHADING);
    if (oldShadings?.kind === 'reference') discarded.push(oldShadings);
    resources.set(SHADING, pdfDictionary(mapped));
    const oldResources = page.entries.get(RESOURCES);
    if (oldResources?.kind === 'reference') discarded.push(oldResources);
    page.entries.set(RESOURCES, pdfDictionary(resources));
    document.set(first.page, page);
  }
  return discarded;
};

const applyDirectForms = (document: LoadedDocument, plans: readonly FormShadingPlan[]): PdfReference[] => {
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const grouped = new Map<number, FormShadingPlan[]>();
  for (const plan of plans) {
    const list = grouped.get(plan.form.objectNumber) ?? [];
    list.push(plan);
    grouped.set(plan.form.objectNumber, list);
  }
  const discarded: PdfReference[] = [];
  for (const group of grouped.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const category = internals.objects.deref(first.resources.get(SHADING));
    if (category?.kind !== 'dictionary') return invalid('form Shading resources are missing');
    const mapped = new PdfDictionaryEntries(category.entries.entries());
    for (const plan of group) {
      mapped.set(plan.name, { kind: 'dictionary', entries: convertedDictionary(document, plan.shading) });
      discarded.push(...plan.shading.discarded);
    }
    const resources = new PdfDictionaryEntries(first.resources.entries());
    const oldShadings = resources.get(SHADING);
    if (oldShadings?.kind === 'reference') discarded.push(oldShadings);
    resources.set(SHADING, pdfDictionary(mapped));
    const dictionary = new PdfDictionaryEntries(first.stream.dictionary.entries());
    const oldResources = dictionary.get(RESOURCES);
    if (oldResources?.kind === 'reference') discarded.push(oldResources);
    dictionary.set(RESOURCES, pdfDictionary(resources));
    document.set(first.form, { kind: 'stream', dictionary, data: first.stream.data });
  }
  return discarded;
};

/** Converts function, axial and radial shading functions while preserving geometry and stops. ISO 32000-1:2008, 8.7.4.5.2–4 and Tables 79–81 define their domains, coordinates and functions. */
export const convertShadings = (document: LoadedDocument, options: RewriteColorOptions): ShadingConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const usage = collectUsage(document, options);
  const plans = new Map<number, ShadingPlan>();
  const patternPlans = new Map<number, PatternShadingPlan>();
  const direct: DirectShadingPlan[] = [];
  const formDirect: FormShadingPlan[] = [];
  const seenForms = new Set<number>();
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) return invalid('page entry is missing');
    const effective = document.page(page).resources();
    direct.push(...directPagePlans({ document, resources: effective, options }, entry.reference, usage));
    formDirect.push(...directFormPlans({ document, resources: effective, options }, { seen: seenForms, usage }));
    const resources: PdfDirectObject = { kind: 'dictionary', entries: effective };
    const unreadable = walkResources(internals, entry, {
      resources,
      visit: visit => {
        scanResources({ document, resources: visit.resources, options }, plans, usage);
        directPatternPlans({ document, resources: visit.resources, options }, patternPlans);
      },
    });
    if (unreadable.length > 0) throw new ValidationError('shading resources cannot be read', 'unreadable-resource');
  }
  const discarded: PdfReference[] = [];
  for (const plan of plans.values()) {
    if (plan.reference === undefined) return invalid('indirect shading reference is missing');
    document.set(plan.reference, { kind: 'dictionary', entries: convertedDictionary(document, plan) });
    discarded.push(...plan.discarded);
  }
  for (const plan of patternPlans.values()) {
    const pattern = document.get(plan.pattern);
    if (pattern.kind !== 'dictionary') return invalid('shading pattern is missing');
    const dictionary = new PdfDictionaryEntries(pattern.entries.entries());
    dictionary.set(SHADING, pdfDictionary(convertedDictionary(document, plan.shading)));
    document.set(plan.pattern, pdfDictionary(dictionary));
    discarded.push(...plan.shading.discarded);
  }
  discarded.push(...applyDirectPages(document, direct), ...applyDirectForms(document, formDirect));
  if (plans.size > 0 || patternPlans.size > 0 || direct.length > 0 || formDirect.length > 0) {
    deleteDiscarded(document, internals, discarded);
    internals.objects.requireFullRewrite('color-conversion');
  }
  const all = [
    ...plans.values(),
    ...[...patternPlans.values()].map(item => item.shading),
    ...direct.map(item => item.shading),
    ...formDirect.map(item => item.shading),
  ];
  const approximations = all.flatMap(plan => {
    const functions = plan.sampled.kind === 'sampled' ? [plan.sampled] : plan.sampled.functions;
    return functions.filter(item => item.maxDeltaE2000 > 0.5).map(item => ({ maxDeltaE2000: item.maxDeltaE2000 }));
  });
  return { shadings: all.length, approximations };
};

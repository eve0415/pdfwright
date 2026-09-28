import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { NamedInlineImage } from './inlineResources.ts';
import type { OverprintNames, RewriteColorOptions } from './rewriteContent.ts';

import { createColorTransform } from '../color/createColorTransform.ts';
import { readContent } from '../content/contentOperations.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { deleteDiscarded } from './discardedObjects.ts';
import { addInlineXObjects } from './inlineResources.ts';
import { addOverprintStates, chooseOverprintNames } from './overprintResources.ts';
import { checkConversionRefusals } from './preflight.ts';
import { rewriteContentColors } from './rewriteContent.ts';

export interface OtherCarrierReport {
  readonly annotations: number;
  readonly appearances: number;
  readonly patterns: number;
  readonly glyphs: number;
}

interface StreamPlan {
  readonly reference: PdfReference;
  readonly stream: PdfStream;
  readonly data: Uint8Array;
  readonly resources: PdfDictionaryEntries;
  readonly names: OverprintNames;
  readonly overprintAdjustments: number;
  readonly inlineImages: readonly NamedInlineImage[];
  readonly kind: 'appearance' | 'pattern' | 'glyph';
}

interface AnnotationPlan {
  readonly reference: PdfReference;
  readonly dictionary: PdfDictionaryEntries;
  readonly discarded: readonly PdfReference[];
}

interface Scan {
  readonly document: LoadedDocument;
  readonly internals: DocumentInternals;
  readonly options: RewriteColorOptions;
  readonly streams: Map<number, StreamPlan>;
  readonly annotations: AnnotationPlan[];
}

const RESOURCES = pdfName('Resources').bytes;
const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const PATTERN = pdfName('Pattern').bytes;
const PATTERN_TYPE = pdfName('PatternType').bytes;
const PAINT_TYPE = pdfName('PaintType').bytes;
const FONT = pdfName('Font').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const CHAR_PROCS = pdfName('CharProcs').bytes;
const ANNOTS = pdfName('Annots').bytes;
const AP = pdfName('AP').bytes;
const MK = pdfName('MK').bytes;

const dictionaryOf = (value: PdfDirectObject | PdfStream | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const numberOf = (value: PdfDirectObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real' && typeof value.value === 'number') return value.value;
  throw new ValidationError('annotation colour component is not numeric', 'color-space');
};

const nameOf = (value: PdfDirectObject | undefined): string | undefined => (value?.kind === 'name' ? new TextDecoder('latin1').decode(value.bytes) : undefined);

const planStream = (scan: Scan, input: { reference: PdfReference; resources: PdfDictionaryEntries; kind: StreamPlan['kind'] }): void => {
  const { reference, resources, kind } = input;
  if (scan.streams.has(reference.objectNumber)) return;
  const stream = scan.internals.objects.deref(reference);
  if (stream?.kind !== 'stream') throw new ValidationError(`${kind} is not a stream`, 'color-space');
  const own = scan.internals.objects.deref(stream.dictionary.get(RESOURCES));
  const effective = own?.kind === 'dictionary' ? own.entries : resources;
  const bytes = decodedData(scan.internals, stream);
  if (typeof bytes === 'string') throw new ValidationError(`${kind} content cannot be read: ${bytes}`, 'color-operator');
  const names = chooseOverprintNames(scan.document, effective);
  const rewritten = rewriteContentColors(scan.document, bytes, { resources: effective, options: scan.options, overprintNames: names });
  if (rewritten.formUses.length > 0) throw new UnsupportedFeatureError(`${kind} contains a nested form`);
  if (rewritten.bytes.length > scan.internals.maxDecodedBytes) throw new ResourceLimitError(`converted ${kind} exceeds maxDecodedBytes`);
  if (rewritten.operators === 0 && rewritten.overprintAdjustments === 0) return;
  scan.streams.set(reference.objectNumber, {
    reference,
    stream,
    data: deflateZlib(rewritten.bytes),
    resources: effective,
    names,
    overprintAdjustments: rewritten.overprintAdjustments,
    inlineImages: rewritten.newInlineImages,
    kind,
  });
};

const planPatternResources = (scan: Scan, resources: PdfDictionaryEntries): void => {
  const category = scan.internals.objects.deref(resources.get(PATTERN));
  if (category?.kind !== 'dictionary') return;
  for (const [, entry] of category.entries.entries()) {
    if (entry.kind !== 'reference') continue;
    const value = scan.internals.objects.deref(entry);
    if (value?.kind !== 'stream') continue;
    const patternType = value.dictionary.get(PATTERN_TYPE);
    const paintType = value.dictionary.get(PAINT_TYPE);
    // ISO 32000-1:2008, Table 75: a coloured tiling pattern specifies its colours in its content stream.
    if (patternType?.kind !== 'integer' || patternType.value !== 1) continue;
    if (paintType?.kind !== 'integer' || paintType.value !== 1) continue;
    planStream(scan, { reference: entry, resources, kind: 'pattern' });
  }
};

const planGlyphs = (scan: Scan, resources: PdfDictionaryEntries): void => {
  const category = scan.internals.objects.deref(resources.get(FONT));
  if (category?.kind !== 'dictionary') return;
  for (const [, entry] of category.entries.entries()) {
    const font = scan.internals.objects.deref(entry);
    const dictionary = dictionaryOf(font);
    if (dictionary === undefined || nameOf(dictionary.get(SUBTYPE)) !== 'Type3') continue;
    const own = scan.internals.objects.deref(dictionary.get(RESOURCES));
    const effective = own?.kind === 'dictionary' ? own.entries : resources;
    const glyphs = scan.internals.objects.deref(dictionary.get(CHAR_PROCS));
    if (glyphs?.kind !== 'dictionary') continue;
    for (const [, glyph] of glyphs.entries.entries()) {
      if (glyph.kind !== 'reference') continue;
      const stream = scan.internals.objects.deref(glyph);
      if (stream?.kind !== 'stream') continue;
      const bytes = decodedData(scan.internals, stream);
      if (typeof bytes === 'string') throw new ValidationError(`Type 3 glyph cannot be read: ${bytes}`, 'color-operator');
      const [first] = readContent(bytes, scan.internals.maxNesting);
      if (first?.operator === 'd0') planStream(scan, { reference: glyph, resources: effective, kind: 'glyph' });
    }
  }
};

const annotationColor = (scan: Scan, value: PdfDirectObject | undefined): PdfDirectObject | undefined => {
  // ISO 32000-1:2008, Table 164: three annotation colour components mean DeviceRGB; four mean DeviceCMYK.
  if (value?.kind !== 'array' || value.items.length !== 3) return undefined;
  const rgb = value.items.map(item => numberOf(item));
  if (rgb.every(component => component === 0) && scan.options.pureBlack !== 'convert') {
    return pdfArray([pdfInteger(0), pdfInteger(0), pdfInteger(0), pdfInteger(1)]);
  }
  const intent = scan.options.intent === undefined || scan.options.intent === 'document' ? 'relativeColorimetric' : scan.options.intent;
  const transform = createColorTransform({ kind: 'icc', profile: scan.options.sourceRgbProfile }, scan.options.outputProfile, {
    intent,
    blackPointCompensation: scan.options.blackPointCompensation !== false,
    lut8LabEncoding: scan.options.lut8LabEncoding ?? 'icc',
  });
  const result = new Float64Array(4);
  transform.convert(Float64Array.from(rgb), result);
  return pdfArray([...result].map(component => pdfReal(component)));
};

const replaceColor = (scan: Scan, dictionary: PdfDictionaryEntries, key: Uint8Array): boolean => {
  const converted = annotationColor(scan, dictionary.get(key));
  if (converted === undefined) return false;
  dictionary.set(key, converted);
  return true;
};

const planAppearances = (scan: Scan, dictionary: PdfDictionaryEntries, resources: PdfDictionaryEntries): void => {
  const appearances = scan.internals.objects.deref(dictionary.get(AP));
  if (appearances?.kind !== 'dictionary') return;
  for (const state of ['N', 'R', 'D']) {
    const entry = appearances.entries.get(pdfName(state).bytes);
    if (entry?.kind === 'reference') {
      const object = scan.internals.objects.deref(entry);
      if (object?.kind === 'stream') {
        planStream(scan, { reference: entry, resources, kind: 'appearance' });
        continue;
      }
    }
    const variants = scan.internals.objects.deref(entry);
    if (variants?.kind !== 'dictionary') continue;
    for (const [, appearance] of variants.entries.entries()) {
      if (appearance.kind === 'reference') planStream(scan, { reference: appearance, resources, kind: 'appearance' });
    }
  }
};

const planAnnotations = (scan: Scan, page: PdfReference, resources: PdfDictionaryEntries): void => {
  const owner = scan.internals.objects.deref(page);
  const pageDictionary = dictionaryOf(owner);
  const annotations = scan.internals.objects.deref(pageDictionary?.get(ANNOTS));
  if (annotations?.kind !== 'array') return;
  for (const entry of annotations.items) {
    if (entry.kind !== 'reference') continue;
    const annotation = scan.internals.objects.deref(entry);
    if (annotation?.kind !== 'dictionary') continue;
    planAppearances(scan, annotation.entries, resources);
    const dictionary = new PdfDictionaryEntries(annotation.entries.entries());
    let changed = replaceColor(scan, dictionary, pdfName('C').bytes);
    changed = replaceColor(scan, dictionary, pdfName('IC').bytes) || changed;
    const oldMk = dictionary.get(MK);
    const mk = scan.internals.objects.deref(oldMk);
    const discarded: PdfReference[] = [];
    if (mk?.kind === 'dictionary') {
      const mapped = new PdfDictionaryEntries(mk.entries.entries());
      const background = replaceColor(scan, mapped, pdfName('BG').bytes);
      const border = replaceColor(scan, mapped, pdfName('BC').bytes);
      if (background || border) {
        if (oldMk?.kind === 'reference') discarded.push(oldMk);
        dictionary.set(MK, pdfDictionary(mapped));
        changed = true;
      }
    }
    if (changed) scan.annotations.push({ reference: entry, dictionary, discarded });
  }
};

const apply = (scan: Scan): OtherCarrierReport => {
  const discarded: PdfReference[] = [];
  for (const plan of scan.streams.values()) {
    const dictionary = new PdfDictionaryEntries(plan.stream.dictionary.entries());
    dictionary.set(FILTER, pdfName('FlateDecode'));
    dictionary.delete(DECODE_PARMS);
    if (plan.overprintAdjustments > 0 || plan.inlineImages.length > 0) {
      const resources = new PdfDictionaryEntries(plan.resources.entries());
      if (plan.overprintAdjustments > 0) addOverprintStates(scan.document, resources, plan.names);
      addInlineXObjects(scan.document, resources, plan.inlineImages);
      const oldResources = dictionary.get(RESOURCES);
      if (oldResources?.kind === 'reference') discarded.push(oldResources);
      dictionary.set(RESOURCES, pdfDictionary(resources));
    }
    scan.document.set(plan.reference, { kind: 'stream', dictionary, data: plan.data });
  }
  for (const plan of scan.annotations) {
    scan.document.set(plan.reference, pdfDictionary(plan.dictionary));
    discarded.push(...plan.discarded);
  }
  if (scan.streams.size > 0 || scan.annotations.length > 0) {
    deleteDiscarded(scan.document, scan.internals, discarded);
    scan.internals.objects.requireFullRewrite('color-conversion');
  }
  const kinds = [...scan.streams.values()].map(plan => plan.kind);
  return {
    annotations: scan.annotations.length,
    appearances: kinds.filter(kind => kind === 'appearance').length,
    patterns: kinds.filter(kind => kind === 'pattern').length,
    glyphs: kinds.filter(kind => kind === 'glyph').length,
  };
};

/** Converts colours in annotation appearances and arrays, coloured tiling patterns, and Type 3 d0 glyphs. */
export const convertOtherCarriers = (document: LoadedDocument, options: RewriteColorOptions): OtherCarrierReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const scan: Scan = { document, internals, options, streams: new Map(), annotations: [] };
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) throw new ValidationError('page entry is missing', 'color-space');
    const effective = document.page(page).resources();
    const resources: PdfDirectObject = pdfDictionary(effective);
    const unreadable = walkResources(internals, entry, {
      resources,
      visit: visit => {
        planPatternResources(scan, visit.resources);
        planGlyphs(scan, visit.resources);
      },
    });
    if (unreadable.length > 0) throw new ValidationError('painted resources cannot be read', 'unreadable-resource');
    planAnnotations(scan, entry.reference, effective);
  }
  return apply(scan);
};

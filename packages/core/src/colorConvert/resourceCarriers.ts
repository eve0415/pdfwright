import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { readContent } from '../content/contentOperations.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfName } from '../object/pdfObject.ts';

/** What holds a resource dictionary that a carrier is reached from: a page, or another carrier. */
export type CarrierHolder = { readonly kind: 'page'; readonly index: number; readonly reference: PdfReference } | ResourceCarrier;

/**
 * What a carrier's replacement resources are written to.
 * `object` is an indirect carrier, whose Resources entry is replaced.
 * The other kinds belong to a Type 3 font dictionary stored directly, because ISO 32000-1:2008, 7.3.8.1 says "All streams shall be indirect objects", so only a font dictionary can be direct.
 * `resources` is the indirect Resources dictionary such a font names, which is replaced itself, so every font and holder that names it gets the replacement.
 * `category` is such a font under a name in an indirect Font category, which is replaced itself for the same reason.
 * `font` is such a font under a name in its holder's direct Font category, which is replaced through the holder.
 */
export type CarrierOwner =
  | { readonly kind: 'object'; readonly reference: PdfReference }
  | { readonly kind: 'resources'; readonly reference: PdfReference }
  | { readonly kind: 'category'; readonly reference: PdfReference; readonly name: Uint8Array }
  | { readonly kind: 'font'; readonly holder: CarrierHolder; readonly name: Uint8Array };

/** An object reached from a page that names colour spaces and shadings in a resource dictionary of its own. */
export interface ResourceCarrier {
  readonly kind: 'carrier';
  /** How the carrier was reached; an object reached both as a form and as an appearance has the role it was first reached by. */
  readonly role: 'form' | 'tiling-pattern' | 'type3' | 'appearance';
  /** The carrier's stream or font dictionary as it was listed; for a `resources` owner, every directly stored Type 3 font that names the dictionary, including fonts that later walks with the same `CarrierSeen` reach. */
  readonly objects: ReadonlySet<PdfObject>;
  /** Distinct for every carrier; for an `object` or `resources` owner it is `referenceKey` of its reference. */
  readonly key: string;
  readonly owner: CarrierOwner;
  readonly resources: PdfDictionaryEntries;
}

/** What the walks of one pass have listed; the walks of every page share it, so that each carrier and each indirect dictionary they share is listed once. */
export interface CarrierSeen {
  /** Object numbers of listed indirect carriers, of the indirect Resources of listed directly stored Type 3 fonts, and of walked indirect Font categories. */
  readonly objects: Set<number>;
  /** The directly stored Type 3 fonts that name each listed indirect Resources dictionary, by its object number. */
  readonly fonts: Map<number, Set<PdfObject>>;
}

export const carrierSeen = (): CarrierSeen => ({ objects: new Set(), fonts: new Map() });

/** The key of an indirect object, shared by carrier keys and by callers that key pages and forms. */
export const referenceKey = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)} R`;

const RESOURCES = pdfName('Resources').bytes;
const XOBJECT = pdfName('XObject').bytes;
const PATTERN = pdfName('Pattern').bytes;
const FONT = pdfName('Font').bytes;
const EXT_G_STATE = pdfName('ExtGState').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const PATTERN_TYPE = pdfName('PatternType').bytes;
const ANNOTS = pdfName('Annots').bytes;
const AP = pdfName('AP').bytes;
const APPEARANCE_STATES = [pdfName('N').bytes, pdfName('R').bytes, pdfName('D').bytes] as const;

const entriesOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') {
    return value.entries;
  }
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const nameIs = (value: PdfObject | undefined, text: string): boolean => value?.kind === 'name' && new TextDecoder('latin1').decode(value.bytes) === text;

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const holderKey = (holder: CarrierHolder): string => (holder.kind === 'page' ? `page ${String(holder.index)}` : holder.key);

// ISO 32000-1:2008, Tables 95, 75, 112 and 168: a form XObject, a tiling pattern, a Type 3 font and an appearance stream may each hold a Resources dictionary.
const carrierRole = (internals: DocumentInternals, object: PdfObject): 'form' | 'tiling-pattern' | 'type3' | undefined => {
  if (object.kind === 'stream') {
    const { dictionary } = object;
    if (nameIs(internals.objects.deref(dictionary.get(SUBTYPE)), 'Form')) {
      return 'form';
    }
    const patternType = internals.objects.deref(dictionary.get(PATTERN_TYPE));
    return patternType?.kind === 'integer' && patternType.value === 1 ? 'tiling-pattern' : undefined;
  }
  return object.kind === 'dictionary' && nameIs(internals.objects.deref(object.entries.get(SUBTYPE)), 'Type3') ? 'type3' : undefined;
};

type FontSlot = { readonly kind: 'holder'; readonly holder: CarrierHolder } | { readonly kind: 'category'; readonly reference: PdfReference };

type PendingCarrier =
  | { readonly kind: 'owner'; readonly value: PdfDirectObject | undefined; readonly appearance: boolean }
  | { readonly kind: 'font'; readonly slot: FontSlot; readonly name: Uint8Array; readonly font: PdfObject };

// An explicit stack instead of recursion, so nesting depth is bounded by memory rather than the call stack. Entries are pushed in reverse and checked against `seen` when popped, which keeps the order a depth-first recursion would list.
// A directly stored font has no object number of its own, so the walk marks the indirect objects it is reached through instead: its Font category and its Resources. Every cycle through such a font runs through one of them, so each is walked once.
class CarrierWalk {
  readonly carriers: Array<ResourceCarrier> = [];
  private readonly internals: DocumentInternals;
  private readonly seen: CarrierSeen;
  private readonly pending: Array<PendingCarrier> = [];

  constructor(internals: DocumentInternals, seen: CarrierSeen) {
    this.internals = internals;
    this.seen = seen;
  }

  private owner(value: PdfDirectObject | undefined, appearance: boolean): void {
    if (value?.kind !== 'reference' || this.seen.objects.has(value.objectNumber)) {
      return;
    }
    const object = this.internals.objects.deref(value);
    if (object === undefined) {
      return;
    }
    const role = appearance ? (object.kind === 'stream' ? 'appearance' : undefined) : carrierRole(this.internals, object);
    if (role === undefined) {
      return;
    }
    this.seen.objects.add(value.objectNumber);
    this.list({ kind: 'carrier', role, objects: new Set([object]), key: referenceKey(value), owner: { kind: 'object', reference: value } }, object);
  }

  private directFont(slot: FontSlot, name: Uint8Array, font: PdfObject): void {
    if (carrierRole(this.internals, font) !== 'type3') {
      return;
    }
    const resources = entriesOf(font)?.get(RESOURCES);
    if (resources?.kind === 'reference') {
      const sharing = this.seen.fonts.get(resources.objectNumber);
      if (sharing !== undefined) {
        sharing.add(font);
        return;
      }
      if (this.seen.objects.has(resources.objectNumber)) {
        return;
      }
      const fonts = new Set([font]);
      this.seen.objects.add(resources.objectNumber);
      this.seen.fonts.set(resources.objectNumber, fonts);
      this.list({ kind: 'carrier', role: 'type3', objects: fonts, key: referenceKey(resources), owner: { kind: 'resources', reference: resources } }, font);
      return;
    }
    const objects = new Set([font]);
    if (slot.kind === 'category') {
      const owner = { kind: 'category', reference: slot.reference, name } as const;
      this.list({ kind: 'carrier', role: 'type3', objects, key: `${referenceKey(slot.reference)} Font ${hex(name)}`, owner }, font);
    } else {
      const owner = { kind: 'font', holder: slot.holder, name } as const;
      this.list({ kind: 'carrier', role: 'type3', objects, key: `${holderKey(slot.holder)} Font ${hex(name)}`, owner }, font);
    }
  }

  private list(carrier: Omit<ResourceCarrier, 'resources'>, object: PdfObject): void {
    // A carrier without its own Resources uses its parent's, which the parent's walk already covers.
    const own = this.internals.objects.deref(entriesOf(object)?.get(RESOURCES));
    if (own?.kind !== 'dictionary') {
      return;
    }
    const listed = { ...carrier, resources: own.entries };
    this.carriers.push(listed);
    this.enqueue(own.entries, listed);
  }

  // An indirect Font category is walked once, and its directly stored fonts are replaced in it, so every holder that names it gets the replacement.
  private fontSlot(value: PdfDirectObject | undefined, holder: CarrierHolder): FontSlot | undefined {
    if (value?.kind !== 'reference') {
      return { kind: 'holder', holder };
    }
    if (this.seen.objects.has(value.objectNumber)) {
      return undefined;
    }
    this.seen.objects.add(value.objectNumber);
    return { kind: 'category', reference: value };
  }

  private enqueue(resources: PdfDictionaryEntries, holder: CarrierHolder): void {
    const found: Array<PendingCarrier> = [];
    for (const key of [XOBJECT, PATTERN]) {
      const category = this.internals.objects.deref(resources.get(key));
      for (const [, value] of category?.kind === 'dictionary' ? category.entries.entries() : []) {
        found.push({ kind: 'owner', value, appearance: false });
      }
    }
    const slot = this.fontSlot(resources.get(FONT), holder);
    if (slot !== undefined) {
      const fonts = this.internals.objects.deref(resources.get(FONT));
      for (const [name, value] of fonts?.kind === 'dictionary' ? fonts.entries.entries() : []) {
        found.push(value.kind === 'dictionary' ? { kind: 'font', slot, name, font: value } : { kind: 'owner', value, appearance: false });
      }
    }
    // ISO 32000-1:2008, Table 58: a graphics state's Font entry is an array whose first element is an indirect reference to a font dictionary.
    const states = this.internals.objects.deref(resources.get(EXT_G_STATE));
    for (const [, value] of states?.kind === 'dictionary' ? states.entries.entries() : []) {
      const font = this.internals.objects.deref(entriesOf(this.internals.objects.deref(value))?.get(FONT));
      found.push({ kind: 'owner', value: font?.kind === 'array' ? font.items[0] : undefined, appearance: false });
    }
    for (let index = found.length - 1; index >= 0; index--) {
      const item = found[index];
      if (item !== undefined) {
        this.pending.push(item);
      }
    }
  }

  private drain(): void {
    for (let item = this.pending.pop(); item !== undefined; item = this.pending.pop()) {
      if (item.kind === 'font') {
        this.directFont(item.slot, item.name, item.font);
      } else {
        this.owner(item.value, item.appearance);
      }
    }
  }

  resources(resources: PdfDictionaryEntries, holder: CarrierHolder): void {
    this.enqueue(resources, holder);
    this.drain();
  }

  appearances(page: PdfReference): void {
    const annotations = this.internals.objects.deref(entriesOf(this.internals.objects.deref(page))?.get(ANNOTS));
    for (const annotation of annotations?.kind === 'array' ? annotations.items : []) {
      const appearance = this.internals.objects.deref(entriesOf(this.internals.objects.deref(annotation))?.get(AP));
      if (appearance?.kind !== 'dictionary') {
        continue;
      }
      // ISO 32000-1:2008, Table 168: each appearance entry is a stream or a subdictionary of streams keyed by appearance state.
      for (const state of APPEARANCE_STATES) {
        const entry = appearance.entries.get(state);
        const variants = this.internals.objects.deref(entry);
        if (variants?.kind === 'dictionary') {
          for (const [, value] of variants.entries.entries()) {
            this.owner(value, true);
            this.drain();
          }
        } else {
          this.owner(entry, true);
          this.drain();
        }
      }
    }
  }
}

/**
 * Lists, from a page's effective resources and its annotations' appearances, every form XObject, tiling pattern, Type 3 font and appearance stream that has its own Resources dictionary, nested to any depth, including a Type 3 font stored directly in a Font category or selected by a graphics state's Font entry.
 * A holder is listed before the carriers reached from it.
 * Soft-mask groups and what only they reach are not listed.
 * Indirect objects in `seen` are skipped and every listed or walked one is added to it, which ends every cycle, including one through a directly stored Type 3 font, and lists an object shared by pages or holders once, so the walk is linear in the objects it reaches.
 */
export const resourceCarriers = (
  internals: DocumentInternals,
  page: { index: number; reference: PdfReference; resources: PdfDictionaryEntries },
  seen: CarrierSeen,
): ReadonlyArray<ResourceCarrier> => {
  const walk = new CarrierWalk(internals, seen);
  walk.resources(page.resources, { kind: 'page', index: page.index, reference: page.reference });
  walk.appearances(page.reference);
  return walk.carriers;
};

const PAINT_TYPE = pdfName('PaintType').bytes;
const CHAR_PROCS = pdfName('CharProcs').bytes;

/**
 * The decoded content streams of a carrier that set colours of their own: an appearance stream, a coloured tiling pattern and the d0 glyphs of a Type 3 font.
 * A glyph starts in the graphics state of the text that shows it, so a scan from its own start knows only what the glyph itself selects.
 * A form is not listed, because it starts in the graphics state at the place that paints it.
 */
export const carrierContent = (internals: DocumentInternals, carrier: ResourceCarrier): ReadonlyArray<Uint8Array> =>
  [...carrier.objects].flatMap(object => objectContent(internals, carrier.role, object));

const objectContent = (internals: DocumentInternals, role: ResourceCarrier['role'], object: PdfObject): ReadonlyArray<Uint8Array> => {
  const decoded = (stream: Extract<PdfObject, { kind: 'stream' }>, what: string): Uint8Array => {
    const bytes = decodedData(internals, stream);
    if (typeof bytes === 'string') {
      throw new ValidationError(`${what} cannot be read: ${bytes}`, 'color-operator');
    }
    return bytes;
  };
  if (object.kind === 'stream') {
    // ISO 32000-1:2008, Table 75: a coloured tiling pattern (PaintType 1) specifies its colours in its content stream.
    const paintType = internals.objects.deref(object.dictionary.get(PAINT_TYPE));
    const coloured = role === 'tiling-pattern' && paintType?.kind === 'integer' && paintType.value === 1;
    return role === 'appearance' || coloured ? [decoded(object, `${role} content`)] : [];
  }
  const glyphs = role === 'type3' ? internals.objects.deref(entriesOf(object)?.get(CHAR_PROCS)) : undefined;
  const streams: Array<Uint8Array> = [];
  for (const [, glyph] of glyphs?.kind === 'dictionary' ? glyphs.entries.entries() : []) {
    const stream = internals.objects.deref(glyph);
    if (stream?.kind !== 'stream') {
      continue;
    }
    const bytes = decoded(stream, 'Type 3 glyph');
    // A glyph that starts with d1 describes only a shape and takes its colour from the text that shows it.
    const [first] = readContent(bytes, internals.maxNesting);
    if (first?.operator === 'd0') {
      streams.push(bytes);
    }
  }
  return streams;
};

const dictionaryEntries = (document: LoadedDocument, value: PdfDirectObject | undefined, what: string): PdfDictionaryEntries => {
  const resolved = value?.kind === 'reference' ? internalsOf(document)?.objects.deref(value) : value;
  if (resolved?.kind !== 'dictionary') {
    throw new ValidationError(`${what} is not a dictionary`, 'color-space');
  }
  return resolved.entries;
};

// The holder's resources as earlier replacements in this pass left them.
const holderResources = (document: LoadedDocument, holder: CarrierHolder): PdfDictionaryEntries => {
  if (holder.kind === 'page') {
    return document.page(holder.index).resources();
  }
  const { owner } = holder;
  if (owner.kind === 'object') {
    return dictionaryEntries(document, entriesOf(document.get(owner.reference))?.get(RESOURCES), 'resource carrier Resources');
  }
  if (owner.kind === 'resources') {
    return dictionaryEntries(document, owner.reference, 'Type 3 font Resources');
  }
  const fonts =
    owner.kind === 'category'
      ? dictionaryEntries(document, owner.reference, 'Font category')
      : dictionaryEntries(document, holderResources(document, owner.holder).get(FONT), 'Font resources');
  return dictionaryEntries(document, dictionaryEntries(document, fonts.get(owner.name), 'Type 3 font').get(RESOURCES), 'Type 3 font Resources');
};

const replaceHolderResources = (document: LoadedDocument, holder: CarrierHolder, resources: PdfDictionaryEntries): Array<PdfReference> => {
  if (holder.kind !== 'page') {
    return replaceCarrierResources(document, holder, resources);
  }
  const page = document.get(holder.reference);
  if (page.kind !== 'dictionary') {
    throw new ValidationError('page is not a dictionary', 'color-space');
  }
  const old = page.entries.get(RESOURCES);
  page.entries.set(RESOURCES, pdfDictionary(resources));
  document.set(holder.reference, page);
  return old?.kind === 'reference' ? [old] : [];
};

// The Font category with the named font's Resources entry replaced.
const withFontResources = (
  document: LoadedDocument,
  category: PdfDictionaryEntries,
  name: Uint8Array,
  resources: PdfDictionaryEntries,
): PdfDictionaryEntries => {
  const fonts = new PdfDictionaryEntries(category.entries());
  const font = new PdfDictionaryEntries(dictionaryEntries(document, fonts.get(name), 'Type 3 font').entries());
  font.set(RESOURCES, pdfDictionary(resources));
  fonts.set(name, pdfDictionary(font));
  return fonts;
};

/**
 * Gives a carrier the replacement resource dictionary and returns the indirect objects it replaced.
 * A `resources` or `category` owner is replaced as the object itself, which keeps its references and so the cycles that run through it.
 * A `font` owner is replaced through its holder's Font category, which is read as earlier replacements left it, so carriers are replaced in the order `resourceCarriers` lists them.
 */
export const replaceCarrierResources = (document: LoadedDocument, carrier: ResourceCarrier, resources: PdfDictionaryEntries): Array<PdfReference> => {
  const { owner } = carrier;
  if (owner.kind === 'resources') {
    document.set(owner.reference, pdfDictionary(resources));
    return [];
  }
  if (owner.kind === 'category') {
    document.set(
      owner.reference,
      pdfDictionary(withFontResources(document, dictionaryEntries(document, owner.reference, 'Font category'), owner.name, resources)),
    );
    return [];
  }
  if (owner.kind === 'font') {
    const holder = holderResources(document, owner.holder);
    const replaced = new PdfDictionaryEntries(holder.entries());
    replaced.set(FONT, pdfDictionary(withFontResources(document, dictionaryEntries(document, holder.get(FONT), 'Font resources'), owner.name, resources)));
    return replaceHolderResources(document, owner.holder, replaced);
  }
  const object = document.get(owner.reference);
  const entries = new PdfDictionaryEntries(entriesOf(object)?.entries() ?? []);
  const old = entries.get(RESOURCES);
  entries.set(RESOURCES, pdfDictionary(resources));
  if (object.kind === 'stream') {
    document.set(owner.reference, { kind: 'stream', dictionary: entries, data: object.data });
  } else if (object.kind === 'dictionary') {
    document.set(owner.reference, pdfDictionary(entries));
  } else {
    throw new ValidationError('resource carrier is not a dictionary or stream', 'color-space');
  }
  return old?.kind === 'reference' ? [old] : [];
};

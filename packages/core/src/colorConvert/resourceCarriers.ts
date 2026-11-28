import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { readContent } from '../content/contentOperations.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
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
 * `resources` is the indirect Resources dictionary such a font names, and `category` is such a font under a name in an indirect Font category; each is replaced by one new object that every font or holder naming it is pointed at, so a soft-mask group that also names it keeps it.
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
  /** How the carrier was reached; an object reached both as a form and as an appearance has the role it was first reached by, and `CarrierSeen.appearances` records that it is also an appearance. */
  readonly role: 'form' | 'tiling-pattern' | 'type3' | 'appearance';
  /** The carrier's stream or font dictionary as it was listed; for a `resources` owner, every directly stored Type 3 font that names the dictionary, including fonts that later walks with the same `CarrierSeen` reach. */
  readonly objects: ReadonlySet<PdfObject>;
  /** Distinct for every carrier; for an `object` or `resources` owner it is `referenceKey` of its reference. */
  readonly key: string;
  readonly owner: CarrierOwner;
  readonly resources: PdfDictionaryEntries;
}

type FontSlot = { readonly kind: 'holder'; readonly holder: CarrierHolder } | { readonly kind: 'category'; readonly reference: PdfReference };

/** A directly stored Type 3 font: the Font category it sits in and its name there. */
interface FontPlace {
  readonly slot: FontSlot;
  readonly name: Uint8Array;
}

/** What the walks of one pass have listed; the walks of every page share it, so that each carrier and each indirect dictionary they share is listed once. */
export interface CarrierSeen {
  /** Object numbers of listed indirect carriers, of the indirect Resources of listed directly stored Type 3 fonts, and of walked indirect Font categories. */
  readonly objects: Set<number>;
  /** The directly stored Type 3 fonts that name each listed indirect Resources dictionary, by its object number. */
  readonly fonts: Map<number, { readonly places: Array<FontPlace>; readonly objects: Set<PdfObject> }>;
  /** The holders whose Font entry names each walked indirect Font category, by its object number. */
  readonly categories: Map<number, Array<CarrierHolder>>;
  /** Object numbers of the streams an annotation's appearance names, whatever role they were listed by. */
  readonly appearances: Set<number>;
  /** The indirect dictionaries whose entries a walk has queued, by object number and how they were read: as Resources, as an XObject or Pattern category, or as an ExtGState category. */
  readonly expanded: Set<string>;
  /** The directly stored fonts in the direct Font category of each indirect Resources a walk has queued, by its object number, which later holders of it queue again without examining the rest of the category. */
  readonly directFonts: Map<number, ReadonlyArray<readonly [Uint8Array, PdfObject]>>;
  /** The most steps the walks may take together, where a step is one resource entry or appearance a walk examines; every carrier costs one. */
  readonly maxSteps: number;
  steps: number;
}

/** The steps one pass's carrier walks may take together by default. */
const MAX_CARRIER_STEPS = 10_000_000;

export const carrierSeen = (maxSteps: number = MAX_CARRIER_STEPS): CarrierSeen => ({
  objects: new Set(),
  fonts: new Map(),
  categories: new Map(),
  appearances: new Set(),
  expanded: new Set(),
  directFonts: new Map(),
  maxSteps,
  steps: 0,
});

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

// `depth` is how many carriers deep the entry sits below the page, counting itself.
type PendingCarrier =
  | { readonly kind: 'owner'; readonly value: PdfDirectObject | undefined; readonly appearance: boolean; readonly depth: number }
  | { readonly kind: 'font'; readonly slot: FontSlot; readonly name: Uint8Array; readonly font: PdfObject; readonly depth: number };

// An explicit stack instead of recursion, so nesting depth is bounded by maxNesting rather than the call stack. Entries are pushed in reverse and checked against `seen` when popped, which keeps the order a depth-first recursion would list; an indirect Font category is checked when its holder is walked.
// A directly stored font has no object number of its own, so the walk marks the indirect objects it is reached through instead: its Font category and its Resources. Every cycle through such a font runs through one of them, so each is walked once.
class CarrierWalk {
  readonly carriers: Array<ResourceCarrier> = [];
  private readonly internals: DocumentInternals;
  private readonly seen: CarrierSeen;
  private readonly pending: Array<PendingCarrier> = [];
  // The shallowest depth each indirect object has been queued at. A depth-first walk can reach an object through a long path before a short one it has already queued, so an object is listed at the shallowest depth known, and forms whose own Resources each name every form do not count as nested.
  private readonly depths = new Map<number, number>();

  constructor(internals: DocumentInternals, seen: CarrierSeen) {
    this.internals = internals;
    this.seen = seen;
  }

  private owner(value: PdfDirectObject | undefined, appearance: boolean, queued: number): void {
    if (value?.kind !== 'reference') {
      return;
    }
    if (appearance) {
      this.seen.appearances.add(value.objectNumber);
    }
    if (this.seen.objects.has(value.objectNumber)) {
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
    const depth = Math.min(queued, this.depths.get(value.objectNumber) ?? queued);
    this.list({ kind: 'carrier', role, objects: new Set([object]), key: referenceKey(value), owner: { kind: 'object', reference: value } }, object, depth);
  }

  private directFont(slot: FontSlot, name: Uint8Array, font: PdfObject, depth: number): void {
    if (carrierRole(this.internals, font) !== 'type3') {
      return;
    }
    const resources = entriesOf(font)?.get(RESOURCES);
    if (resources?.kind === 'reference') {
      const sharing = this.seen.fonts.get(resources.objectNumber);
      if (sharing !== undefined) {
        sharing.places.push({ slot, name });
        sharing.objects.add(font);
        return;
      }
      if (this.seen.objects.has(resources.objectNumber)) {
        return;
      }
      const objects = new Set([font]);
      this.seen.objects.add(resources.objectNumber);
      this.seen.fonts.set(resources.objectNumber, { places: [{ slot, name }], objects });
      this.list({ kind: 'carrier', role: 'type3', objects, key: referenceKey(resources), owner: { kind: 'resources', reference: resources } }, font, depth);
      return;
    }
    const objects = new Set([font]);
    if (slot.kind === 'category') {
      const owner = { kind: 'category', reference: slot.reference, name } as const;
      this.list({ kind: 'carrier', role: 'type3', objects, key: `${referenceKey(slot.reference)} Font ${hex(name)}`, owner }, font, depth);
    } else {
      const owner = { kind: 'font', holder: slot.holder, name } as const;
      this.list({ kind: 'carrier', role: 'type3', objects, key: `${holderKey(slot.holder)} Font ${hex(name)}`, owner }, font, depth);
    }
  }

  private list(carrier: Omit<ResourceCarrier, 'resources'>, object: PdfObject, depth: number): void {
    // A carrier without its own Resources uses its parent's, which the parent's walk already covers.
    const value = entriesOf(object)?.get(RESOURCES);
    const own = this.internals.objects.deref(value);
    if (own?.kind !== 'dictionary') {
      return;
    }
    if (depth > this.internals.maxNesting) {
      throw new ResourceLimitError(`resource carriers nest deeper than maxNesting (${String(this.internals.maxNesting)})`);
    }
    const listed = { ...carrier, resources: own.entries };
    this.carriers.push(listed);
    this.enqueue(own.entries, listed, value, depth + 1);
  }

  // The entries of an indirect dictionary reach the same carriers whichever holder names it, so they are queued once per pass; a dictionary shared by many holders then costs its size once rather than once per holder.
  private expand(value: PdfDirectObject | undefined, reading: 'resources' | 'category' | 'states'): boolean {
    if (value?.kind !== 'reference') {
      return true;
    }
    const key = `${String(value.objectNumber)} ${reading}`;
    if (this.seen.expanded.has(key)) {
      return false;
    }
    this.seen.expanded.add(key);
    return true;
  }

  // An indirect Font category is walked once; every holder that names it is recorded, so that each can be pointed at its replacement.
  private fontSlot(value: PdfDirectObject | undefined, holder: CarrierHolder): FontSlot | undefined {
    if (value?.kind !== 'reference') {
      return { kind: 'holder', holder };
    }
    const holders = this.seen.categories.get(value.objectNumber);
    if (holders !== undefined) {
      holders.push(holder);
      return undefined;
    }
    if (this.seen.objects.has(value.objectNumber)) {
      return undefined;
    }
    this.seen.objects.add(value.objectNumber);
    this.seen.categories.set(value.objectNumber, [holder]);
    return { kind: 'category', reference: value };
  }

  // `reference` is how the holder names `resources`. When an earlier walk queued that dictionary, only the directly stored fonts of its direct Font category are queued again, because they are replaced through the holder; they are recorded when it is first queued, so a later holder does not examine the other entries.
  private enqueue(resources: PdfDictionaryEntries, holder: CarrierHolder, reference: PdfDirectObject | undefined, depth: number): void {
    const fresh = this.expand(reference, 'resources');
    const found: Array<PendingCarrier> = [];
    for (const key of fresh ? [XOBJECT, PATTERN] : []) {
      const category = this.expand(resources.get(key), 'category') ? this.internals.objects.deref(resources.get(key)) : undefined;
      for (const [, value] of category?.kind === 'dictionary' ? category.entries.entries() : []) {
        found.push({ kind: 'owner', value, appearance: false, depth });
      }
    }
    const slot = this.fontSlot(resources.get(FONT), holder);
    if (slot !== undefined && fresh) {
      this.fonts(resources, reference, { slot, found, depth });
    } else if (slot !== undefined && reference?.kind === 'reference') {
      for (const [name, font] of this.seen.directFonts.get(reference.objectNumber) ?? []) {
        found.push({ kind: 'font', slot, name, font, depth });
      }
    }
    // ISO 32000-1:2008, Table 58: a graphics state's Font entry is an array whose first element is an indirect reference to a font dictionary.
    const states = fresh && this.expand(resources.get(EXT_G_STATE), 'states') ? this.internals.objects.deref(resources.get(EXT_G_STATE)) : undefined;
    for (const [, value] of states?.kind === 'dictionary' ? states.entries.entries() : []) {
      const font = this.internals.objects.deref(entriesOf(this.internals.objects.deref(value))?.get(FONT));
      found.push({ kind: 'owner', value: font?.kind === 'array' ? font.items[0] : undefined, appearance: false, depth });
    }
    for (let index = found.length - 1; index >= 0; index--) {
      const item = found[index];
      if (item !== undefined) {
        this.queue(item);
      }
    }
  }

  // Adds every entry of the Font category in `resources` to `found`, and records its directly stored fonts for an indirect `reference`.
  private fonts(resources: PdfDictionaryEntries, reference: PdfDirectObject | undefined, into: { slot: FontSlot; found: Array<PendingCarrier>; depth: number }): void {
    const { slot, found, depth } = into;
    const fonts = this.internals.objects.deref(resources.get(FONT));
    const direct: Array<readonly [Uint8Array, PdfObject]> = [];
    for (const [name, value] of fonts?.kind === 'dictionary' ? fonts.entries.entries() : []) {
      if (value.kind === 'dictionary') {
        direct.push([name, value]);
        found.push({ kind: 'font', slot, name, font: value, depth });
      } else {
        found.push({ kind: 'owner', value, appearance: false, depth });
      }
    }
    if (reference?.kind === 'reference') {
      this.seen.directFonts.set(reference.objectNumber, direct);
    }
  }

  private queue(item: PendingCarrier): void {
    if (item.kind === 'owner' && item.value?.kind === 'reference') {
      const known = this.depths.get(item.value.objectNumber);
      if (known === undefined || item.depth < known) {
        this.depths.set(item.value.objectNumber, item.depth);
      }
    }
    this.pending.push(item);
  }

  private drain(): void {
    for (let item = this.pending.pop(); item !== undefined; item = this.pending.pop()) {
      if (++this.seen.steps > this.seen.maxSteps) {
        throw new ResourceLimitError(`the resource carrier walk takes more than ${String(this.seen.maxSteps)} steps`);
      }
      if (item.kind === 'font') {
        this.directFont(item.slot, item.name, item.font, item.depth);
      } else {
        this.owner(item.value, item.appearance, item.depth);
      }
    }
  }

  resources(resources: PdfDictionaryEntries, holder: CarrierHolder, reference: PdfDirectObject | undefined): void {
    this.enqueue(resources, holder, reference, 1);
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
            this.queue({ kind: 'owner', value, appearance: true, depth: 1 });
            this.drain();
          }
        } else {
          this.queue({ kind: 'owner', value: entry, appearance: true, depth: 1 });
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
 * Throws ResourceLimitError once the walks sharing `seen` take more than its `maxSteps` steps, or when a carrier with its own Resources sits more than the document's maxNesting carriers below the page.
 */
export const resourceCarriers = (
  internals: DocumentInternals,
  page: { index: number; reference: PdfReference; resources: PdfDictionaryEntries },
  seen: CarrierSeen,
): ReadonlyArray<ResourceCarrier> => {
  const walk = new CarrierWalk(internals, seen);
  // Pages that name one indirect Resources dictionary share its entries, which the first such page queues.
  const named = entriesOf(internals.objects.deref(page.reference))?.get(RESOURCES);
  walk.resources(page.resources, { kind: 'page', index: page.index, reference: page.reference }, named?.kind === 'reference' ? named : undefined);
  walk.appearances(page.reference);
  return walk.carriers;
};

const PAINT_TYPE = pdfName('PaintType').bytes;
const CHAR_PROCS = pdfName('CharProcs').bytes;

/**
 * The decoded content streams of a carrier that set colours of their own: an appearance stream, a coloured tiling pattern and the d0 glyphs of a Type 3 font.
 * A glyph starts in the graphics state of the text that shows it, so a scan from its own start knows only what the glyph itself selects.
 * A form is not listed, because it starts in the graphics state at the place that paints it, unless `seen` records that an annotation also names it as an appearance, which starts in the default graphics state.
 */
export const carrierContent = (internals: DocumentInternals, carrier: ResourceCarrier, seen: CarrierSeen): ReadonlyArray<Uint8Array> => {
  const { owner } = carrier;
  const role = carrier.role === 'form' && owner.kind === 'object' && seen.appearances.has(owner.reference.objectNumber) ? 'appearance' : carrier.role;
  return [...carrier.objects].flatMap(object => objectContent(internals, role, object));
};

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

/** An indirect object whose working copy `finish` writes. */
interface Root {
  readonly reference: PdfReference;
  readonly entries: PdfDictionaryEntries;
}

/**
 * Gives carriers their replacement resource dictionaries, in the order `resourceCarriers` listed them, and collects the indirect objects it replaced.
 * The resources of each page and indirect carrier, each replaced indirect dictionary and each directly stored font are read once into a working copy that later replacements edit, a font's copy sitting inside its holder's, and `finish` writes each page, carrier and new object once, so the work is linear in the carriers and fonts.
 * A `resources` or `category` owner is copied to one new object; `finish` points every font and holder the walk found naming the old object at the new one, which also carries a cycle through it over to the new object, and leaves the old object to whatever else names it, such as a soft-mask group.
 */
export class CarrierReplacement {
  private readonly document: LoadedDocument;
  private readonly seen: CarrierSeen;
  // The working copy of each replaced indirect dictionary and the new object it is written to, by the old object's number.
  private readonly copies = new Map<number, Root>();
  // Replaced objects in the order their copies were created, which `finish` works through while pointing adds more.
  private readonly replaced: Array<PdfReference> = [];
  private readonly discarded: Array<PdfReference> = [];
  // Pages and indirect carriers whose Resources entry `finish` writes.
  private readonly written: Array<Root> = [];
  // Working copies of holders' resources and of the direct Font categories in them, by holder key, and of directly stored fonts, by Font category and name.
  private readonly holders = new Map<string, PdfDictionaryEntries>();
  private readonly categories = new Map<string, PdfDictionaryEntries>();
  private readonly fonts = new Map<string, PdfDictionaryEntries>();

  constructor(document: LoadedDocument, seen: CarrierSeen) {
    this.document = document;
    this.seen = seen;
  }

  // The working copy of a `resources` or `category` owner, created with its new object at its first replacement.
  private copy(reference: PdfReference, what: string): PdfDictionaryEntries {
    const known = this.copies.get(reference.objectNumber);
    if (known !== undefined) {
      return known.entries;
    }
    const entries = new PdfDictionaryEntries(dictionaryEntries(this.document, reference, what).entries());
    this.copies.set(reference.objectNumber, { reference: this.document.object(pdfDictionary()), entries });
    this.replaced.push(reference);
    return entries;
  }

  // The working copy of the Font category a directly stored font sits in.
  private category(slot: FontSlot): PdfDictionaryEntries {
    if (slot.kind === 'category') {
      return this.copy(slot.reference, 'Font category');
    }
    const key = holderKey(slot.holder);
    const known = this.categories.get(key);
    if (known !== undefined) {
      return known;
    }
    const resources = this.resourcesOf(slot.holder);
    const fonts = new PdfDictionaryEntries(dictionaryEntries(this.document, resources.get(FONT), 'Font resources').entries());
    resources.set(FONT, pdfDictionary(fonts));
    this.categories.set(key, fonts);
    return fonts;
  }

  // The working copy of a directly stored font, inside the working copy of its Font category.
  private font(slot: FontSlot, name: Uint8Array): PdfDictionaryEntries {
    const key = `${slot.kind === 'holder' ? holderKey(slot.holder) : referenceKey(slot.reference)} ${slot.kind} ${hex(name)}`;
    const known = this.fonts.get(key);
    if (known !== undefined) {
      return known;
    }
    const category = this.category(slot);
    const font = new PdfDictionaryEntries(dictionaryEntries(this.document, category.get(name), 'Type 3 font').entries());
    category.set(name, pdfDictionary(font));
    this.fonts.set(key, font);
    return font;
  }

  // The working copy of the holder's resources, as earlier replacements in this pass left them.
  private resourcesOf(holder: CarrierHolder): PdfDictionaryEntries {
    const key = holderKey(holder);
    const known = this.holders.get(key);
    if (known !== undefined) {
      return known;
    }
    const entries = this.read(holder);
    this.holders.set(key, entries);
    return entries;
  }

  private read(holder: CarrierHolder): PdfDictionaryEntries {
    if (holder.kind === 'page') {
      const entries = this.document.page(holder.index).resources();
      this.written.push({ reference: holder.reference, entries });
      return entries;
    }
    const { owner } = holder;
    if (owner.kind === 'object') {
      const value = entriesOf(this.document.get(owner.reference))?.get(RESOURCES);
      const entries = new PdfDictionaryEntries(dictionaryEntries(this.document, value, 'resource carrier Resources').entries());
      this.written.push({ reference: owner.reference, entries });
      return entries;
    }
    if (owner.kind === 'resources') {
      return this.copy(owner.reference, 'Type 3 font Resources');
    }
    const slot: FontSlot = owner.kind === 'category' ? { kind: 'category', reference: owner.reference } : { kind: 'holder', holder: owner.holder };
    const font = this.font(slot, owner.name);
    const entries = new PdfDictionaryEntries(dictionaryEntries(this.document, font.get(RESOURCES), 'Type 3 font Resources').entries());
    font.set(RESOURCES, pdfDictionary(entries));
    return entries;
  }

  /** Gives one carrier its replacement resource dictionary. */
  replace(carrier: ResourceCarrier, resources: PdfDictionaryEntries): void {
    const target = this.resourcesOf(carrier);
    for (const [key] of target.entries()) {
      target.delete(key);
    }
    for (const [key, value] of resources.entries()) {
      target.set(key, value);
    }
  }

  /** Points every font and holder that names a replaced object at its replacement, writes every page, carrier and new object once, and returns the indirect objects replaced. Pointing a holder can replace a further object, which is then pointed in turn. */
  finish(): Array<PdfReference> {
    for (let index = 0; index < this.replaced.length; index++) {
      const original = this.replaced[index];
      const copy = original === undefined ? undefined : this.copies.get(original.objectNumber);
      if (original === undefined || copy === undefined) {
        continue;
      }
      for (const place of this.seen.fonts.get(original.objectNumber)?.places ?? []) {
        this.font(place.slot, place.name).set(RESOURCES, copy.reference);
      }
      for (const holder of this.seen.categories.get(original.objectNumber) ?? []) {
        this.resourcesOf(holder).set(FONT, copy.reference);
      }
      this.discarded.push(original);
    }
    for (const { reference, entries } of this.copies.values()) {
      this.document.set(reference, pdfDictionary(entries));
    }
    for (const root of this.written) {
      this.writeResources(root);
    }
    return this.discarded;
  }

  // Sets the Resources entry of a page or indirect carrier to its working copy.
  private writeResources({ reference, entries: resources }: Root): void {
    const object = this.document.get(reference);
    const entries = new PdfDictionaryEntries(entriesOf(object)?.entries() ?? []);
    const old = entries.get(RESOURCES);
    entries.set(RESOURCES, pdfDictionary(resources));
    if (object.kind === 'stream') {
      this.document.set(reference, { kind: 'stream', dictionary: entries, data: object.data });
    } else if (object.kind === 'dictionary') {
      this.document.set(reference, pdfDictionary(entries));
    } else {
      throw new ValidationError('resource carrier is not a dictionary or stream', 'color-space');
    }
    if (old?.kind === 'reference') {
      this.discarded.push(old);
    }
  }
}

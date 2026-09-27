import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';

import { annotationFlags } from './annotationFlags.ts';

const FONT = pdfName('Font').bytes;
const XOBJECT = pdfName('XObject').bytes;
const PATTERN = pdfName('Pattern').bytes;
const EXT_G_STATE = pdfName('ExtGState').bytes;
const RESOURCES = pdfName('Resources').bytes;
const SOFT_MASK = pdfName('SMask').bytes;
const GROUP = pdfName('G').bytes;
const ANNOTS = pdfName('Annots').bytes;
const APPEARANCE = pdfName('AP').bytes;
const APPEARANCE_STATE = pdfName('AS').bytes;
const FLAGS = pdfName('F').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const TYPE3 = pdfName('Type3').bytes;
const APPEARANCES = [
  ['N', pdfName('N').bytes],
  ['R', pdfName('R').bytes],
  ['D', pdfName('D').bytes],
] as const;

const dictionaryOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const referenceKey = (value: PdfDirectObject | undefined): string | undefined =>
  value?.kind === 'reference' ? `${String(value.objectNumber)}.${String(value.generation)}` : undefined;

const referenceOf = (value: PdfDirectObject | undefined): PdfReference | undefined => (value?.kind === 'reference' ? value : undefined);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

/** The page entry a walk reached an object from. */
export type WalkEntry = 'Resources' | 'Annots';

/** An object a walk could not parse, and the page entry it was reached from. */
export interface UnreadableObject {
  readonly from: WalkEntry;
  readonly reason: string;
}

/**
 * What a resource dictionary belongs to. A form, pattern or soft-mask group is identified by its reference, which a well-formed file always has because ISO 32000-1:2008, 7.3.8.1 says "All streams shall be indirect objects".
 * An annotation appearance is `printable` when the annotation prints (Table 165) and the appearance is its normal appearance, or the state of a normal appearance subdictionary that AS selects.
 */
export type ResourceOrigin =
  | { readonly kind: 'page' }
  | { readonly kind: 'form'; readonly reference: PdfReference | undefined }
  | { readonly kind: 'tiling-pattern'; readonly reference: PdfReference | undefined }
  | { readonly kind: 'type3'; readonly font: PdfReference | undefined; readonly inheritsPageResources: boolean }
  | { readonly kind: 'soft-mask'; readonly group: PdfReference | undefined }
  | { readonly kind: 'annotation'; readonly index: number; readonly state: 'N' | 'R' | 'D'; readonly printable: boolean };

/** A resource dictionary a walk reached, with every origin it was reached through. */
export interface ResourceVisit {
  readonly resources: PdfDictionaryEntries;
  /** The dictionary's own reference when it is an indirect object. */
  readonly reference?: PdfReference;
  readonly origins: readonly ResourceOrigin[];
}

/** A font dictionary a walk reached: from a Font resource or a graphics state's Font entry. */
export interface FontVisit {
  readonly value: PdfDirectObject;
  readonly dictionary: PdfDictionaryEntries;
}

export interface ResourceWalk {
  /** The page's Resources value, own or inherited, as `inherited` in `document/loadedPage.ts` finds it with the caller's inheritance cache. */
  readonly resources: PdfDirectObject | undefined;
  /** Called once per resource dictionary after the walk, in the order the walk read them. */
  readonly visit?: (visit: ResourceVisit) => void;
  /** Called once per font object; a ParseError it throws is reported as an unreadable object. */
  readonly font?: (font: FontVisit) => void;
}

// What an object holding resources is to the walk; the origin is completed with the object's reference.
type OwnerRole = { readonly kind: 'form' | 'tiling-pattern' | 'soft-mask' } | Extract<ResourceOrigin, { kind: 'annotation' }>;

type Visit =
  | { readonly kind: 'resources'; readonly key: string; readonly value: PdfDirectObject; readonly origin: ResourceOrigin; readonly from: WalkEntry }
  | { readonly kind: 'origin'; readonly key: string; readonly origin: ResourceOrigin }
  | { readonly kind: 'owner'; readonly value: PdfDirectObject | undefined; readonly role: OwnerRole; readonly from: WalkEntry }
  | { readonly kind: 'font'; readonly value: PdfDirectObject | undefined; readonly from: WalkEntry };

interface VisitRecord {
  readonly resources: PdfDictionaryEntries;
  readonly reference: PdfReference | undefined;
  readonly origins: ResourceOrigin[];
  readonly originKeys: Set<string>;
}

const ownerKey = (value: PdfReference | undefined): string => referenceKey(value) ?? 'direct';

const originKey = (origin: ResourceOrigin): string => {
  if (origin.kind === 'page') return 'page';
  if (origin.kind === 'form' || origin.kind === 'tiling-pattern') return `${origin.kind} ${ownerKey(origin.reference)}`;
  if (origin.kind === 'soft-mask') return `soft-mask ${ownerKey(origin.group)}`;
  if (origin.kind === 'type3') return `type3 ${ownerKey(origin.font)} ${String(origin.inheritsPageResources)}`;
  return `annotation ${String(origin.index)} ${origin.state} ${String(origin.printable)}`;
};

const ownerOrigin = (role: OwnerRole, reference: PdfReference | undefined): ResourceOrigin => {
  if (role.kind === 'annotation') return role;
  return role.kind === 'soft-mask' ? { kind: 'soft-mask', group: reference } : { kind: role.kind, reference };
};

/**
 * Walks from a page through its resources: resource dictionaries (ISO 32000-1:2008, 7.8.3), form XObjects, patterns, Type 3 fonts (9.6.5), a graphics state's Font entry (8.4.5, Table 58) and soft-mask groups (11.6.5.2, Table 144), and annotation appearance streams (12.5.5, Table 168).
 * Each object is read once; an object reached again through another origin adds that origin to its visit without being read or walked again, which also ends cycles.
 */
class Walk {
  private readonly document: DocumentInternals;
  private readonly handlers: ResourceWalk;
  private readonly seen = new Set<string>();
  private readonly resolved = new Map<string, PdfObject | undefined>();
  private readonly owners = new Map<string, string | undefined>();
  private readonly records = new Map<string, VisitRecord | undefined>();
  // Origins of resource dictionaries reached again before the walk has read them.
  private readonly pending = new Map<string, ResourceOrigin[]>();
  private readonly visits: Visit[] = [];
  private readonly unreadable: UnreadableObject[] = [];
  private pageKey = 'page';
  private directOwners = 0;
  private from: WalkEntry = 'Resources';

  constructor(document: DocumentInternals, handlers: ResourceWalk) {
    this.document = document;
    this.handlers = handlers;
  }

  private record(error: unknown): void {
    if (!(error instanceof ParseError)) throw error;
    this.unreadable.push({ from: this.from, reason: error.message });
  }

  // Every indirect object is resolved at most once per walk, including those an annotation's appearance dictionary names several times.
  private read(value: PdfDirectObject | undefined): PdfObject | undefined {
    const key = referenceKey(value);
    if (key !== undefined && this.resolved.has(key)) return this.resolved.get(key);
    const object = this.resolve(value);
    if (key !== undefined) this.resolved.set(key, object);
    return object;
  }

  private resolve(value: PdfDirectObject | undefined): PdfObject | undefined {
    try {
      return this.document.objects.deref(value);
    } catch (error: unknown) {
      this.record(error);
      return undefined;
    }
  }

  page(resources: PdfDirectObject | undefined): void {
    this.pageKey = referenceKey(resources) ?? 'page';
    if (resources !== undefined) this.visits.push({ kind: 'resources', key: this.pageKey, value: resources, origin: { kind: 'page' }, from: 'Resources' });
  }

  annotations(page: PageEntry): void {
    this.from = 'Annots';
    const pageDictionary = dictionaryOf(this.read(page.reference));
    const annotations = this.read(pageDictionary?.get(ANNOTS));
    for (const [index, annotation] of annotations?.kind === 'array' ? annotations.items.entries() : []) {
      const annotationDictionary = dictionaryOf(this.read(annotation));
      const { printable } = annotationFlags(this.read(annotationDictionary?.get(FLAGS)));
      const selected = this.read(annotationDictionary?.get(APPEARANCE_STATE));
      const appearance = dictionaryOf(this.read(annotationDictionary?.get(APPEARANCE)));
      for (const [state, key] of APPEARANCES) {
        const value = appearance?.get(key);
        const resolved = this.read(value);
        // 12.5.5: "The normal appearance shall be used when the annotation is not interacting with the user. This appearance is also used for printing the annotation."
        const prints = printable && state === 'N';
        // Table 168: an entry holds "either a single appearance stream or an appearance subdictionary"; Table 164, AS: "The annotation's appearance state, which selects the applicable appearance stream from an appearance subdictionary".
        // Without an AS naming one of its states, no state of a subdictionary prints.
        if (resolved?.kind === 'stream') this.owner(value, { kind: 'annotation', index, state, printable: prints });
        else {
          for (const [name, stream] of resolved?.kind === 'dictionary' ? resolved.entries.entries() : []) {
            const chosen = prints && selected?.kind === 'name' && sameBytes(selected.bytes, name);
            this.owner(stream, { kind: 'annotation', index, state, printable: chosen });
          }
        }
      }
    }
  }

  private owner(value: PdfDirectObject | undefined, role: OwnerRole): void {
    this.visits.push({ kind: 'owner', value, role, from: this.from });
  }

  run(): readonly UnreadableObject[] {
    for (let visit = this.visits.pop(); visit !== undefined; visit = this.visits.pop()) {
      if (visit.kind === 'origin') {
        this.origin(visit.key, visit.origin);
        continue;
      }
      this.from = visit.from;
      if (visit.kind === 'resources') this.resources(visit);
      else if (visit.kind === 'owner') this.ownerVisit(visit);
      else this.fontVisit(visit.value);
    }
    for (const record of this.records.values()) {
      if (record === undefined) continue;
      const { resources, reference, origins } = record;
      this.handlers.visit?.(reference === undefined ? { resources, origins } : { resources, reference, origins });
    }
    return this.unreadable;
  }

  // An object with a reference is walked at most once, whatever it was reached as.
  private once(value: PdfDirectObject | undefined): boolean {
    const key = referenceKey(value);
    if (key === undefined) return true;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private origin(key: string, origin: ResourceOrigin): void {
    if (!this.records.has(key)) {
      const waiting = this.pending.get(key) ?? [];
      waiting.push(origin);
      this.pending.set(key, waiting);
      return;
    }
    const record = this.records.get(key);
    const known = originKey(origin);
    if (record === undefined || record.originKeys.has(known)) return;
    record.originKeys.add(known);
    record.origins.push(origin);
  }

  private resources({ key, value, origin }: Extract<Visit, { kind: 'resources' }>): void {
    if (this.records.has(key)) {
      this.origin(key, origin);
      return;
    }
    const dictionary = this.once(value) ? dictionaryOf(this.read(value)) : undefined;
    this.records.set(
      key,
      dictionary === undefined
        ? undefined
        : { resources: dictionary, reference: referenceOf(value), origins: [origin], originKeys: new Set([originKey(origin)]) },
    );
    for (const waiting of this.pending.get(key) ?? []) this.origin(key, waiting);
    this.pending.delete(key);
    if (dictionary === undefined) return;
    this.category(dictionary, FONT, font => {
      this.visits.push({ kind: 'font', value: font, from: this.from });
    });
    this.category(dictionary, XOBJECT, form => {
      this.owner(form, { kind: 'form' });
    });
    this.category(dictionary, PATTERN, pattern => {
      this.owner(pattern, { kind: 'tiling-pattern' });
    });
    this.category(dictionary, EXT_G_STATE, state => {
      this.graphicsState(state);
    });
  }

  // The key under which the resources an owner holds are recorded: the resource dictionary's reference, or the owner itself for a direct dictionary.
  private resourcesKey(owner: string | undefined, resources: PdfDirectObject): string {
    return referenceKey(resources) ?? `in ${owner ?? `direct ${String(this.directOwners++)}`}`;
  }

  // A form XObject, a pattern, a soft-mask group or an appearance stream has its own resources.
  private ownerVisit({ value, role }: Extract<Visit, { kind: 'owner' }>): void {
    const owner = referenceKey(value);
    const origin = ownerOrigin(role, referenceOf(value));
    if (owner !== undefined && this.owners.has(owner)) {
      const key = this.owners.get(owner);
      if (key !== undefined) this.visits.push({ kind: 'origin', key, origin });
      return;
    }
    const resources = dictionaryOf(this.read(value))?.get(RESOURCES);
    const key = resources === undefined ? undefined : this.resourcesKey(owner, resources);
    if (owner !== undefined) this.owners.set(owner, key);
    if (key !== undefined && resources !== undefined) this.visits.push({ kind: 'resources', key, value: resources, origin, from: this.from });
  }

  private fontVisit(value: PdfDirectObject | undefined): void {
    if (value === undefined || !this.once(value)) return;
    const dictionary = dictionaryOf(this.read(value));
    if (dictionary === undefined) return;
    try {
      this.handlers.font?.({ value, dictionary });
    } catch (error: unknown) {
      this.record(error);
    }
    const subtype = this.read(dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || !sameBytes(subtype.bytes, TYPE3)) return;
    const font = referenceOf(value);
    const resources = dictionary.get(RESOURCES);
    // Table 112, Resources: "If any glyph descriptions refer to named resources but this dictionary is absent, the names shall be looked up in the resource dictionary of the page on which the font is used."
    // 7.3.7: "A dictionary entry whose value is null … shall be treated the same as if the entry does not exist", which covers a reference to a missing object (7.3.10).
    if (resources === undefined || this.read(resources)?.kind === 'null') {
      this.visits.push({ kind: 'origin', key: this.pageKey, origin: { kind: 'type3', font, inheritsPageResources: true } });
      return;
    }
    const key = this.resourcesKey(referenceKey(value), resources);
    this.visits.push({ kind: 'resources', key, value: resources, origin: { kind: 'type3', font, inheritsPageResources: false }, from: this.from });
  }

  private category(resources: PdfDictionaryEntries, key: Uint8Array, visit: (value: PdfDirectObject) => void): void {
    const entries = dictionaryOf(this.read(resources.get(key)));
    for (const [, value] of entries?.entries() ?? []) visit(value);
  }

  private graphicsState(value: PdfDirectObject): void {
    const state = dictionaryOf(this.read(value));
    const font = this.read(state?.get(FONT));
    if (font?.kind === 'array') this.visits.push({ kind: 'font', value: font.items[0], from: this.from });
    const mask = dictionaryOf(this.read(state?.get(SOFT_MASK)));
    if (mask !== undefined) this.owner(mask.get(GROUP), { kind: 'soft-mask' });
  }
}

/**
 * Walks the resources a page reaches through its Resources and its annotations' appearances and reports each resource dictionary once, with every origin it was reached through.
 * Objects that cannot be parsed are returned, never skipped silently. AcroForm default resources are not on any page and are not walked.
 */
export const walkResources = (document: DocumentInternals, page: PageEntry, handlers: ResourceWalk): readonly UnreadableObject[] => {
  const walk = new Walk(document, handlers);
  walk.page(handlers.resources);
  walk.annotations(page);
  return walk.run();
};

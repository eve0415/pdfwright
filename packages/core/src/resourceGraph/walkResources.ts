import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';

const FONT = pdfName('Font').bytes;
const XOBJECT = pdfName('XObject').bytes;
const PATTERN = pdfName('Pattern').bytes;
const EXT_G_STATE = pdfName('ExtGState').bytes;
const RESOURCES = pdfName('Resources').bytes;
const SOFT_MASK = pdfName('SMask').bytes;
const GROUP = pdfName('G').bytes;
const ANNOTS = pdfName('Annots').bytes;
const APPEARANCE = pdfName('AP').bytes;
const APPEARANCE_STATES = [pdfName('N').bytes, pdfName('R').bytes, pdfName('D').bytes];

const dictionaryOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const referenceKey = (value: PdfDirectObject): string | undefined =>
  value.kind === 'reference' ? `${String(value.objectNumber)}.${String(value.generation)}` : undefined;

/** The page entry a walk reached an object from. */
export type WalkEntry = 'Resources' | 'Annots';

/** An object a walk could not parse, and the page entry it was reached from. */
export interface UnreadableObject {
  readonly from: WalkEntry;
  readonly reason: string;
}

/** A font dictionary a walk reached: from a Font resource or a graphics state's Font entry. */
export interface FontVisit {
  readonly value: PdfDirectObject;
  readonly dictionary: PdfDictionaryEntries;
}

export interface ResourceWalk {
  /** The page's Resources value, own or inherited, as `inherited` in `document/loadedPage.ts` finds it with the caller's inheritance cache. */
  readonly resources: PdfDirectObject | undefined;
  /** Called once per font object; a ParseError it throws is reported as an unreadable object. */
  readonly font?: (font: FontVisit) => void;
}

interface Visit {
  readonly from: WalkEntry;
  readonly kind: 'resources' | 'font' | 'form';
  readonly value: PdfDirectObject | undefined;
}

/**
 * Walks from a page through its resources: resource dictionaries (ISO 32000-1:2008, 7.8.3), form XObjects, patterns, Type 3 fonts (9.6.5), a graphics state's Font entry (8.4.5, Table 58) and soft-mask groups (11.6.5.2, Table 144), and annotation appearance streams (12.5.5, Table 168).
 */
class Walk {
  private readonly document: DocumentInternals;
  private readonly handlers: ResourceWalk;
  private readonly seen = new Set<string>();
  private readonly visits: Visit[] = [];
  private readonly unreadable: UnreadableObject[] = [];
  private from: WalkEntry = 'Resources';

  constructor(document: DocumentInternals, handlers: ResourceWalk) {
    this.document = document;
    this.handlers = handlers;
  }

  push(visit: Omit<Visit, 'from'>): void {
    this.visits.push({ ...visit, from: this.from });
  }

  private record(error: unknown): void {
    if (!(error instanceof ParseError)) throw error;
    this.unreadable.push({ from: this.from, reason: error.message });
  }

  private read(value: PdfDirectObject | undefined): PdfObject | undefined {
    try {
      return this.document.objects.deref(value);
    } catch (error: unknown) {
      this.record(error);
      return undefined;
    }
  }

  annotations(page: PageEntry): void {
    this.from = 'Annots';
    const pageDictionary = dictionaryOf(this.read(page.reference));
    const annotations = this.read(pageDictionary?.get(ANNOTS));
    for (const annotation of annotations?.kind === 'array' ? annotations.items : []) {
      const annotationDictionary = dictionaryOf(this.read(annotation));
      const appearance = dictionaryOf(this.read(annotationDictionary?.get(APPEARANCE)));
      for (const state of APPEARANCE_STATES) {
        const value = appearance?.get(state);
        const resolved = this.read(value);
        // An appearance entry holds a stream, or a dictionary of streams by appearance state.
        if (resolved?.kind === 'stream') this.push({ kind: 'form', value });
        else for (const [, stream] of resolved?.kind === 'dictionary' ? resolved.entries.entries() : []) this.push({ kind: 'form', value: stream });
      }
    }
  }

  // Each object is visited once, which also ends cycles through forms that use themselves.
  private once(value: PdfDirectObject | undefined): boolean {
    const key = value === undefined ? undefined : referenceKey(value);
    if (key === undefined) return true;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  run(): readonly UnreadableObject[] {
    for (let visit = this.visits.pop(); visit !== undefined; visit = this.visits.pop()) {
      if (this.once(visit.value)) this.visit(visit);
    }
    return this.unreadable;
  }

  private visit({ kind, value, from }: Visit): void {
    this.from = from;
    const dictionary = dictionaryOf(this.read(value));
    if (dictionary === undefined || value === undefined) return;
    if (kind === 'font') this.font(dictionary, value);
    // A form XObject, an appearance stream or a Type 3 font has its own resources.
    if (kind !== 'resources') {
      this.push({ kind: 'resources', value: dictionary.get(RESOURCES) });
      return;
    }
    this.category(dictionary, FONT, font => {
      this.push({ kind: 'font', value: font });
    });
    for (const key of [XOBJECT, PATTERN]) {
      this.category(dictionary, key, form => {
        this.push({ kind: 'form', value: form });
      });
    }
    this.category(dictionary, EXT_G_STATE, state => {
      this.graphicsState(state);
    });
  }

  private font(dictionary: PdfDictionaryEntries, value: PdfDirectObject): void {
    try {
      this.handlers.font?.({ value, dictionary });
    } catch (error: unknown) {
      this.record(error);
    }
  }

  private category(resources: PdfDictionaryEntries, key: Uint8Array, visit: (value: PdfDirectObject) => void): void {
    const entries = dictionaryOf(this.read(resources.get(key)));
    for (const [, value] of entries?.entries() ?? []) visit(value);
  }

  private graphicsState(value: PdfDirectObject): void {
    const state = dictionaryOf(this.read(value));
    const font = this.read(state?.get(FONT));
    if (font?.kind === 'array') this.push({ kind: 'font', value: font.items[0] });
    const mask = dictionaryOf(this.read(state?.get(SOFT_MASK)));
    if (mask !== undefined) this.push({ kind: 'form', value: mask.get(GROUP) });
  }
}

/** Walks the resources a page reaches through its Resources and its annotations' appearances, visiting each referenced object once; objects that cannot be parsed are returned, never skipped silently. */
export const walkResources = (document: DocumentInternals, page: PageEntry, handlers: ResourceWalk): readonly UnreadableObject[] => {
  const walk = new Walk(document, handlers);
  walk.push({ kind: 'resources', value: handlers.resources });
  walk.annotations(page);
  return walk.run();
};

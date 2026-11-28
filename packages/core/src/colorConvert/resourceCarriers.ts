import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfName } from '../object/pdfObject.ts';

/** An object reached from a page that names colour spaces and shadings in a resource dictionary of its own. */
export interface ResourceCarrier {
  readonly reference: PdfReference;
  readonly resources: PdfDictionaryEntries;
}

const RESOURCES = pdfName('Resources').bytes;
const XOBJECT = pdfName('XObject').bytes;
const PATTERN = pdfName('Pattern').bytes;
const FONT = pdfName('Font').bytes;
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

// ISO 32000-1:2008, Tables 95, 75, 112 and 168: a form XObject, a tiling pattern, a Type 3 font and an appearance stream may each hold a Resources dictionary.
const holdsResources = (internals: DocumentInternals, object: PdfObject): boolean => {
  if (object.kind === 'stream') {
    const { dictionary } = object;
    if (nameIs(internals.objects.deref(dictionary.get(SUBTYPE)), 'Form')) {
      return true;
    }
    const patternType = internals.objects.deref(dictionary.get(PATTERN_TYPE));
    return patternType?.kind === 'integer' && patternType.value === 1;
  }
  return object.kind === 'dictionary' && nameIs(internals.objects.deref(object.entries.get(SUBTYPE)), 'Type3');
};

class CarrierWalk {
  readonly carriers: Array<ResourceCarrier> = [];
  private readonly internals: DocumentInternals;
  private readonly seen: Set<number>;

  constructor(internals: DocumentInternals, seen: Set<number>) {
    this.internals = internals;
    this.seen = seen;
  }

  owner(value: PdfDirectObject | undefined, appearance: boolean): void {
    if (value?.kind !== 'reference' || this.seen.has(value.objectNumber)) {
      return;
    }
    const object = this.internals.objects.deref(value);
    if (object === undefined || (appearance ? object.kind !== 'stream' : !holdsResources(this.internals, object))) {
      return;
    }
    this.seen.add(value.objectNumber);
    // A carrier without its own Resources uses its parent's, which the parent's walk already covers.
    const own = this.internals.objects.deref(entriesOf(object)?.get(RESOURCES));
    if (own?.kind !== 'dictionary') {
      return;
    }
    this.carriers.push({ reference: value, resources: own.entries });
    this.resources(own.entries);
  }

  resources(resources: PdfDictionaryEntries): void {
    for (const key of [XOBJECT, PATTERN, FONT]) {
      const category = this.internals.objects.deref(resources.get(key));
      for (const [, value] of category?.kind === 'dictionary' ? category.entries.entries() : []) {
        this.owner(value, false);
      }
    }
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
          }
        } else {
          this.owner(entry, true);
        }
      }
    }
  }
}

/**
 * Lists, from a page's effective resources and its annotations' appearances, every form XObject, tiling pattern, Type 3 font and appearance stream that has its own Resources dictionary, nested to any depth.
 * Soft-mask groups and what only they reach are not listed. Objects in `seen` are skipped and every listed one is added to it, which ends cycles and lists an object shared by pages once.
 */
export const resourceCarriers = (
  internals: DocumentInternals,
  page: { reference: PdfReference; resources: PdfDictionaryEntries },
  seen: Set<number>,
): ReadonlyArray<ResourceCarrier> => {
  const walk = new CarrierWalk(internals, seen);
  walk.resources(page.resources);
  walk.appearances(page.reference);
  return walk.carriers;
};

/** Gives a carrier the replacement resource dictionary and returns the indirect Resources object it replaced, if any. */
export const replaceCarrierResources = (document: LoadedDocument, reference: PdfReference, resources: PdfDictionaryEntries): PdfReference | undefined => {
  const owner = document.get(reference);
  const entries = new PdfDictionaryEntries(entriesOf(owner)?.entries() ?? []);
  const old = entries.get(RESOURCES);
  entries.set(RESOURCES, pdfDictionary(resources));
  if (owner.kind === 'stream') {
    document.set(reference, { kind: 'stream', dictionary: entries, data: owner.data });
  } else if (owner.kind === 'dictionary') {
    document.set(reference, pdfDictionary(entries));
  } else {
    throw new ValidationError('resource carrier is not a dictionary or stream', 'color-space');
  }
  return old?.kind === 'reference' ? old : undefined;
};

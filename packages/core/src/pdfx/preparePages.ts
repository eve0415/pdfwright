import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { readContent } from '../content/contentOperations.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { pt } from '../length/length.ts';
import { PdfDictionaryEntries as Entries, pdfDictionary, pdfName } from '../object/pdfObject.ts';

export interface PdfX4PageOptions {
  /** The default writes a missing TrimBox from MediaBox when the page has no ArtBox. */
  readonly pageBoxes?: 'trim-from-media' | 'refuse';
}

export interface PdfX4PageChange {
  /** Zero-based page indices. */
  readonly addedTrimBoxes: readonly number[];
  /** Zero-based page indices. */
  readonly addedPageGroups: readonly number[];
}

const key = (name: string): Uint8Array => pdfName(name).bytes;
const nameOf = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? new TextDecoder('latin1').decode(value.bytes) : undefined);
const entriesOf = (internals: DocumentInternals, value: PdfDirectObject | undefined): PdfDictionaryEntries | undefined => {
  const resolved = internals.objects.deref(value);
  if (resolved?.kind === 'dictionary') return resolved.entries;
  return resolved?.kind === 'stream' ? resolved.dictionary : undefined;
};
const numeric = (value: PdfObject | undefined): number | undefined => {
  if (value?.kind === 'integer') return value.value;
  return value?.kind === 'real' && typeof value.value === 'number' ? value.value : undefined;
};

const transparentState = (internals: DocumentInternals, state: PdfDictionaryEntries): boolean => {
  const { objects } = internals;
  const fill = objects.deref(state.get(key('ca')));
  const stroke = objects.deref(state.get(key('CA')));
  const fillAlpha = numeric(fill);
  const strokeAlpha = numeric(stroke);
  if ((fillAlpha !== undefined && fillAlpha < 1) || (strokeAlpha !== undefined && strokeAlpha < 1)) return true;
  const mask = objects.deref(state.get(key('SMask')));
  if (mask !== undefined && nameOf(mask) !== 'None') return true;
  const blend = objects.deref(state.get(key('BM')));
  const modes = blend?.kind === 'array' ? blend.items.map(item => nameOf(objects.deref(item))) : [nameOf(blend)];
  return modes.some(mode => mode !== undefined && mode !== 'Normal' && mode !== 'Compatible');
};

class TransparencyScan {
  private readonly internals: DocumentInternals;
  private readonly seen = new Set<number>();

  constructor(internals: DocumentInternals) {
    this.internals = internals;
  }

  private xobject(value: PdfDirectObject | undefined, inherited: PdfDictionaryEntries): boolean {
    if (value?.kind !== 'reference' || this.seen.has(value.objectNumber)) return false;
    this.seen.add(value.objectNumber);
    const object = this.internals.objects.deref(value);
    if (object?.kind !== 'stream') return false;
    const subtypeValue = this.internals.objects.deref(object.dictionary.get(key('Subtype')));
    const subtype = nameOf(subtypeValue);
    if (subtype === 'Image') return object.dictionary.has(key('SMask')) || object.dictionary.has(key('Mask'));
    if (subtype !== 'Form') return false;
    const group = entriesOf(this.internals, object.dictionary.get(key('Group')));
    const groupSubtype = this.internals.objects.deref(group?.get(key('S')));
    if (nameOf(groupSubtype) === 'Transparency') return true;
    const resources = entriesOf(this.internals, object.dictionary.get(key('Resources'))) ?? inherited;
    const bytes = decodedData(this.internals, object);
    if (typeof bytes === 'string') throw new ValidationError(`form content cannot be read: ${bytes}`, 'unreadable-resource');
    return this.operations(bytes, resources);
  }

  operations(bytes: Uint8Array | readonly Uint8Array[], resources: PdfDictionaryEntries): boolean {
    const states = entriesOf(this.internals, resources.get(key('ExtGState')));
    const xobjects = entriesOf(this.internals, resources.get(key('XObject')));
    for (const operation of readContent(bytes, this.internals.maxNesting)) {
      const [operand] = operation.operands;
      if (operand?.kind !== 'name') continue;
      if (operation.operator === 'gs') {
        const state = entriesOf(this.internals, states?.get(operand.bytes));
        if (state !== undefined && transparentState(this.internals, state)) return true;
      }
      if (operation.operator === 'Do' && this.xobject(xobjects?.get(operand.bytes), resources)) return true;
    }
    return false;
  }
}

const pageUsesTransparency = (document: LoadedDocument, internals: DocumentInternals, pageIndex: number): boolean => {
  const page = document.page(pageIndex);
  const object = document.get(page.reference);
  if (object.kind !== 'dictionary') throw new ValidationError('page is not a dictionary', 'unreadable-resource');
  const group = entriesOf(internals, object.entries.get(key('Group')));
  const groupSubtype = internals.objects.deref(group?.get(key('S')));
  if (nameOf(groupSubtype) === 'Transparency') return true;
  const entry = internals.pages[pageIndex];
  if (entry === undefined) throw new ValidationError('page entry is missing', 'unreadable-resource');
  const content = pageContent(internals, entry);
  if (content.problems.length > 0) throw new ValidationError('page content cannot be read', 'unreadable-resource');
  return new TransparencyScan(internals).operations(content.streams, page.resources());
};

/** ISO 32000-1:2008, Table 30 defines page boxes; 11.4.7 permits an explicit colour space for page compositing. */
export const preparePdfX4Pages = (document: LoadedDocument, options: PdfX4PageOptions = {}): PdfX4PageChange => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable', 'unreadable-resource');
  const trim: number[] = [];
  const groups: number[] = [];
  for (let index = 0; index < document.pageCount; index++) {
    const page = document.page(index);
    const boxes = page.boxes();
    if (!boxes.TrimBox.explicit && !boxes.ArtBox.explicit) {
      if (options.pageBoxes === 'refuse') throw new ValidationError(`page ${String(index)} has no TrimBox or ArtBox`);
      trim.push(index);
    }
    const owner = document.get(page.reference);
    if (owner.kind !== 'dictionary') throw new ValidationError('page is not a dictionary', 'unreadable-resource');
    if (!owner.entries.has(key('Group')) && pageUsesTransparency(document, internals, index)) groups.push(index);
  }
  for (const index of trim) {
    const page = document.page(index);
    const [left, bottom, right, top] = page.boxes().MediaBox.rect;
    page.setBox('TrimBox', [pt(left), pt(bottom), pt(right), pt(top)]);
  }
  for (const index of groups) {
    const page = document.page(index);
    const owner = document.get(page.reference);
    if (owner.kind !== 'dictionary') throw new ValidationError('page is not a dictionary', 'unreadable-resource');
    const group = new Entries([
      [key('S'), pdfName('Transparency')],
      [key('CS'), pdfName('DeviceCMYK')],
      [key('I'), { kind: 'boolean', value: true }],
    ]);
    owner.entries.set(key('Group'), pdfDictionary(group));
    document.set(page.reference, owner);
  }
  if (trim.length > 0 || groups.length > 0) internals.objects.requireFullRewrite('color-conversion');
  return { addedTrimBoxes: trim, addedPageGroups: groups };
};

import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { EffectiveBoxes } from '../document/loadedPage.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { readContent } from '../content/contentOperations.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { pt } from '../length/length.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { PdfDictionaryEntries as Entries, pdfDictionary, pdfName } from '../object/pdfObject.ts';

/** Adds the default TrimBox when a page has neither TrimBox nor ArtBox by default; `refuse` instead raises ValidationError without a reason under ISO 32000-1:2008, 14.11.2 and Table 30. */
export interface PdfX4PageOptions {
  /** `trim-from-crop` (the default) writes a TrimBox equal to the CropBox, which defaults to the MediaBox, reduced to the MediaBox and to an explicit BleedBox, on a page that sets neither TrimBox nor ArtBox; `refuse` throws ValidationError for such a page. */
  readonly pageBoxes?: 'trim-from-crop' | 'refuse';
}

/** Zero-based page indexes where TrimBoxes or isolated DeviceCMYK transparency groups were added under ISO 32000-1:2008, 14.11.2 and 11.6.6. */
export interface PdfX4PageChange {
  /** Zero-based page indices. */
  readonly addedTrimBoxes: ReadonlyArray<number>;
  /** Zero-based page indices. */
  readonly addedPageGroups: ReadonlyArray<number>;
}

const latin1 = new TextDecoder('latin1');
const key = (name: string): Uint8Array => pdfName(name).bytes;
const nameOf = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? latin1.decode(value.bytes) : undefined);
const entriesOf = (internals: DocumentInternals, value: PdfDirectObject | undefined): PdfDictionaryEntries | undefined => {
  const resolved = internals.objects.deref(value);
  if (resolved?.kind === 'dictionary') {
    return resolved.entries;
  }
  return resolved?.kind === 'stream' ? resolved.dictionary : undefined;
};
const numeric = (value: PdfObject | undefined): number | undefined => {
  if (value?.kind === 'integer') {
    return value.value;
  }
  return value?.kind === 'real' && typeof value.value === 'number' ? value.value : undefined;
};

// Each token is a tag that only one kind uses, then the length of its text and the text, so two different objects never spell the same text.
const token = (parts: Array<string>, tag: string, text: string): void => {
  parts.push(`${tag}${String(text.length)}:${text}`);
};

// Spells a direct object out with its references unresolved, so that two dictionaries with the same entries, such as one the object cache parsed again, give the same text.
const directText = (value: PdfDirectObject, parts: Array<string>): void => {
  switch (value.kind) {
    case 'null':
      parts.push('z');
      return;
    case 'boolean':
      parts.push(value.value ? 't' : 'f');
      return;
    case 'integer':
      token(parts, 'i', String(value.value));
      return;
    case 'real':
      token(parts, 'r', typeof value.value === 'number' ? String(value.value) : `${String(value.value.numerator)}/${String(value.value.denominator)}`);
      return;
    case 'reference':
      token(parts, 'R', `${String(value.objectNumber)} ${String(value.generation)}`);
      return;
    case 'name':
      token(parts, 'n', latin1.decode(value.bytes));
      return;
    case 'string':
      token(parts, 's', latin1.decode(value.bytes));
      return;
    case 'invalid':
      token(parts, 'x', latin1.decode(value.bytes));
      return;
    case 'array':
      parts.push('[');
      for (const item of value.items) {
        directText(item, parts);
      }
      parts.push(']');
      return;
    case 'dictionary':
      parts.push('<');
      for (const [name, item] of value.entries.entries()) {
        token(parts, 'k', latin1.decode(name));
        directText(item, parts);
      }
      parts.push('>');
  }
};

const transparentState = (internals: DocumentInternals, state: PdfDictionaryEntries): boolean => {
  const { objects } = internals;
  const fill = objects.deref(state.get(key('ca')));
  const stroke = objects.deref(state.get(key('CA')));
  const fillAlpha = numeric(fill);
  const strokeAlpha = numeric(stroke);
  if ((fillAlpha !== undefined && fillAlpha < 1) || (strokeAlpha !== undefined && strokeAlpha < 1)) {
    return true;
  }
  const mask = objects.deref(state.get(key('SMask')));
  if (mask !== undefined && nameOf(mask) !== 'None') {
    return true;
  }
  const blend = objects.deref(state.get(key('BM')));
  const modes = blend?.kind === 'array' ? blend.items.map(item => nameOf(objects.deref(item))) : [nameOf(blend)];
  return modes.some(mode => mode !== undefined && mode !== 'Normal' && mode !== 'Compatible');
};

/** A resource name that content selects, with the operator that selects it. */
interface Use {
  readonly operator: 'gs' | 'Do' | 'Tf' | 'scn';
  readonly name: Uint8Array;
}

/** The resource subdictionaries that the operators of a Use look a name up in. */
interface Lookup {
  readonly resources: PdfDictionaryEntries;
  readonly states: PdfDictionaryEntries | undefined;
  readonly xobjects: PdfDictionaryEntries | undefined;
  readonly patterns: PdfDictionaryEntries | undefined;
  readonly fonts: PdfDictionaryEntries | undefined;
}

function* usesOf(bytes: Uint8Array | ReadonlyArray<Uint8Array>, maxNesting: number): Generator<Use> {
  for (const operation of readContent(bytes, maxNesting)) {
    if (operation.operator === 'scn' || operation.operator === 'SCN') {
      const patternName = operation.operands.at(-1);
      if (patternName?.kind === 'name') {
        yield { operator: 'scn', name: patternName.bytes };
      }
    }
    const [operand] = operation.operands;
    if (operand?.kind === 'name' && (operation.operator === 'gs' || operation.operator === 'Do' || operation.operator === 'Tf')) {
      yield { operator: operation.operator, name: operand.bytes };
    }
  }
}

class TransparencyScan {
  private readonly internals: DocumentInternals;
  private readonly page: PdfDictionaryEntries;
  private readonly seen = new Set<number>();
  private readonly procedures = new Set<string>();
  // Fonts are remembered apart from forms, patterns and appearances, so that an object a font selection names is still read when Do, scn or an annotation draws it.
  private readonly fontObjects = new Set<number>();
  private readonly fonts = new Set<PdfDictionaryEntries>();
  private readonly directResources = new Map<string, number>();
  // A glyph procedure is tokenised once per scan, and a CharProcs dictionary is walked once; the names they select are kept, and a font with other Resources looks only those names up.
  private readonly glyphUses = new Map<number, ReadonlyMap<string, Use>>();
  private readonly charProcsUses = new Map<string, ReadonlyArray<Use>>();
  private readonly reading = new Set<number>();
  private steps = 0;
  private depth = 0;

  constructor(internals: DocumentInternals, page: PdfDictionaryEntries) {
    this.internals = internals;
    this.page = page;
  }

  // Each form, pattern, glyph procedure or appearance subdictionary is read inside the one that uses it, so a chain of distinct objects is bounded by maxNesting rather than by the call stack.
  private enter(): void {
    if (this.depth >= this.internals.maxNesting) {
      throw new ResourceLimitError(`content streams and appearance subdictionaries nest deeper than maxNesting (${String(this.internals.maxNesting)})`);
    }
    this.depth++;
  }

  // Fonts that share glyph procedures multiply the work of reading them with each font's Resources, so that work is counted against maxDecodedBytes.
  private step(count: number): void {
    this.steps += count;
    if (this.steps > this.internals.maxDecodedBytes) {
      throw new ResourceLimitError(
        `reading Type 3 glyph procedures with the Resources of each font takes more than maxDecodedBytes (${String(this.internals.maxDecodedBytes)}) steps`,
      );
    }
  }

  private nested(bytes: Uint8Array | ReadonlyArray<Uint8Array>, resources: PdfDictionaryEntries, record?: Map<string, Use>): boolean {
    this.enter();
    const found = this.operations(bytes, resources, record);
    this.depth--;
    return found;
  }

  private replay(uses: Iterable<Use>, resources: PdfDictionaryEntries): boolean {
    this.enter();
    const lookup = this.lookup(resources);
    let found = false;
    for (const use of uses) {
      if (this.use(use, lookup)) {
        found = true;
        break;
      }
    }
    this.depth--;
    return found;
  }

  private xobject(value: PdfDirectObject | undefined, inherited: PdfDictionaryEntries): boolean {
    if (value?.kind !== 'reference' || this.seen.has(value.objectNumber)) {
      return false;
    }
    this.seen.add(value.objectNumber);
    const object = this.internals.objects.deref(value);
    if (object?.kind !== 'stream') {
      return false;
    }
    const subtypeValue = this.internals.objects.deref(object.dictionary.get(key('Subtype')));
    const subtype = nameOf(subtypeValue);
    if (subtype === 'Image') {
      return object.dictionary.has(key('SMask')) || object.dictionary.has(key('Mask'));
    }
    if (subtype !== 'Form') {
      return false;
    }
    const group = entriesOf(this.internals, object.dictionary.get(key('Group')));
    const groupSubtype = this.internals.objects.deref(group?.get(key('S')));
    if (nameOf(groupSubtype) === 'Transparency') {
      return true;
    }
    const resources = entriesOf(this.internals, object.dictionary.get(key('Resources'))) ?? inherited;
    const bytes = decodedData(this.internals, object);
    if (typeof bytes === 'string') {
      throw new ValidationError(`form content cannot be read: ${bytes}`, 'unreadable-resource');
    }
    return this.nested(bytes, resources);
  }

  private pattern(value: PdfDirectObject | undefined, inherited: PdfDictionaryEntries): boolean {
    if (value?.kind === 'reference') {
      if (this.seen.has(value.objectNumber)) {
        return false;
      }
      this.seen.add(value.objectNumber);
    }
    const pattern = this.internals.objects.deref(value);
    if (pattern?.kind !== 'dictionary' && pattern?.kind !== 'stream') {
      return false;
    }
    const entries = pattern.kind === 'stream' ? pattern.dictionary : pattern.entries;
    const state = entriesOf(this.internals, entries.get(key('ExtGState')));
    if (state !== undefined && transparentState(this.internals, state)) {
      return true;
    }
    if (pattern.kind !== 'stream') {
      return false;
    }
    const resources = entriesOf(this.internals, entries.get(key('Resources'))) ?? inherited;
    const bytes = decodedData(this.internals, pattern);
    if (typeof bytes === 'string') {
      throw new ValidationError(`pattern content cannot be read: ${bytes}`, 'unreadable-resource');
    }
    return this.nested(bytes, resources);
  }

  private directScope(value: PdfDirectObject): number {
    const parts: Array<string> = [];
    directText(value, parts);
    const text = parts.join('');
    const known = this.directResources.get(text);
    if (known !== undefined) {
      return known;
    }
    const scope = this.directResources.size;
    this.directResources.set(text, scope);
    return scope;
  }

  private font(value: PdfDirectObject | undefined): boolean {
    if (value?.kind === 'reference') {
      if (this.fontObjects.has(value.objectNumber)) {
        return false;
      }
      this.fontObjects.add(value.objectNumber);
    }
    const font = entriesOf(this.internals, value);
    // A direct font has no object number, so each font read is remembered by its dictionary and a later selection of it returns at once. A dictionary parsed again after the object cache drops it is a new one, so the procedure keys below, not this set, are what end a glyph that selects its own font.
    if (font === undefined || this.fonts.has(font)) {
      return false;
    }
    this.fonts.add(font);
    if (nameOf(this.internals.objects.deref(font.get(key('Subtype')))) !== 'Type3') {
      return false;
    }
    // ISO 32000-1:2008, 9.6.5: each CharProcs entry is a glyph procedure, a content stream; Table 112, Resources: "If any glyph descriptions refer to named resources but this dictionary is absent, the names shall be looked up in the resource dictionary of the page on which the font is used."
    const ownValue = font.get(key('Resources'));
    const own = entriesOf(this.internals, ownValue);
    const resources = own ?? this.page;
    // A glyph procedure that fonts with different Resources share is read once with each; a direct Resources or CharProcs dictionary is known by its entries, so that one parsed again, as when a glyph selects its own font, is not read again.
    let scope = 'page';
    if (ownValue?.kind === 'reference') {
      scope = `resources ${String(ownValue.objectNumber)}`;
    } else if (ownValue?.kind === 'dictionary') {
      scope = `direct ${String(this.directScope(ownValue))}`;
    }
    const charProcsValue = font.get(key('CharProcs'));
    const procedures = entriesOf(this.internals, charProcsValue);
    let charProcs: string | undefined;
    if (charProcsValue?.kind === 'reference') {
      charProcs = `object ${String(charProcsValue.objectNumber)}`;
    } else if (charProcsValue?.kind === 'dictionary') {
      charProcs = `direct ${String(this.directScope(charProcsValue))}`;
    }
    if (procedures === undefined || charProcs === undefined) {
      return false;
    }
    const read = `${charProcs} ${scope}`;
    if (this.procedures.has(read)) {
      return false;
    }
    this.procedures.add(read);
    const known = this.charProcsUses.get(charProcs);
    if (known !== undefined) {
      this.step(1 + known.length);
      return this.replay(known, resources);
    }
    const uses = new Map<string, Use>();
    let complete = true;
    for (const [, procedure] of procedures.entries()) {
      this.step(1);
      if (procedure.kind !== 'reference') {
        continue;
      }
      const glyph = this.glyph(procedure, resources);
      if (glyph === true) {
        return true;
      }
      if (glyph === undefined) {
        complete = false;
        continue;
      }
      for (const [text, use] of glyph) {
        if (!uses.has(text)) {
          uses.set(text, use);
        }
      }
    }
    if (complete) {
      this.charProcsUses.set(charProcs, [...uses.values()]);
    }
    return false;
  }

  /** Reads one glyph procedure with the given Resources: true when it uses transparency, else the names it selects, or undefined while they are not all known. */
  private glyph(procedure: PdfReference, resources: PdfDictionaryEntries): true | ReadonlyMap<string, Use> | undefined {
    const { objectNumber } = procedure;
    const known = this.glyphUses.get(objectNumber);
    if (known !== undefined) {
      this.step(known.size);
      return this.replay(known.values(), resources) || known;
    }
    const stream = this.internals.objects.deref(procedure);
    if (stream?.kind !== 'stream') {
      return new Map();
    }
    const bytes = decodedData(this.internals, stream);
    if (typeof bytes === 'string') {
      throw new ValidationError(`glyph procedure cannot be read: ${bytes}`, 'unreadable-resource');
    }
    // A glyph that selects another font sharing it is reached again before its first read ends, while the names it selects are not all known.
    if (this.reading.has(objectNumber)) {
      this.step(bytes.length);
      return this.nested(bytes, resources) || undefined;
    }
    this.reading.add(objectNumber);
    const uses = new Map<string, Use>();
    const found = this.nested(bytes, resources, uses);
    this.reading.delete(objectNumber);
    if (found) {
      return true;
    }
    this.glyphUses.set(objectNumber, uses);
    return uses;
  }

  private appearance(value: PdfDirectObject | undefined, resources: PdfDictionaryEntries): boolean {
    if (value?.kind === 'reference') {
      if (this.seen.has(value.objectNumber)) {
        return false;
      }
      const resolved = this.internals.objects.deref(value);
      if (resolved?.kind === 'stream') {
        return this.xobject(value, resources);
      }
      this.seen.add(value.objectNumber);
    }
    const object = this.internals.objects.deref(value);
    if (object?.kind !== 'dictionary') {
      return false;
    }
    this.enter();
    let found = false;
    for (const [, child] of object.entries.entries()) {
      if (this.appearance(child, resources)) {
        found = true;
        break;
      }
    }
    this.depth--;
    return found;
  }

  annotations(value: PdfDirectObject | undefined, resources: PdfDictionaryEntries): boolean {
    const annots = this.internals.objects.deref(value);
    if (annots?.kind !== 'array') {
      return false;
    }
    for (const item of annots.items) {
      const annotation = entriesOf(this.internals, item);
      const appearances = entriesOf(this.internals, annotation?.get(key('AP')));
      if (appearances !== undefined && this.appearance(appearances.get(key('N')), resources)) {
        return true;
      }
    }
    return false;
  }

  private lookup(resources: PdfDictionaryEntries): Lookup {
    return {
      resources,
      states: entriesOf(this.internals, resources.get(key('ExtGState'))),
      xobjects: entriesOf(this.internals, resources.get(key('XObject'))),
      patterns: entriesOf(this.internals, resources.get(key('Pattern'))),
      fonts: entriesOf(this.internals, resources.get(key('Font'))),
    };
  }

  private use({ operator, name }: Use, lookup: Lookup): boolean {
    switch (operator) {
      case 'scn':
        return this.pattern(lookup.patterns?.get(name), lookup.resources);
      case 'gs': {
        const state = entriesOf(this.internals, lookup.states?.get(name));
        if (state !== undefined && transparentState(this.internals, state)) {
          return true;
        }
        // ISO 32000-1:2008, 8.4.5, Table 58: a Font entry is an array of a font and a size, and gs selects that font as Tf does.
        const selected = this.internals.objects.deref(state?.get(key('Font')));
        return selected?.kind === 'array' && this.font(selected.items[0]);
      }
      case 'Do':
        return this.xobject(lookup.xobjects?.get(name), lookup.resources);
      case 'Tf':
        return this.font(lookup.fonts?.get(name));
    }
  }

  // `record` keeps each distinct name the content selects, in the order it first selects it.
  operations(bytes: Uint8Array | ReadonlyArray<Uint8Array>, resources: PdfDictionaryEntries, record?: Map<string, Use>): boolean {
    const lookup = this.lookup(resources);
    for (const use of usesOf(bytes, this.internals.maxNesting)) {
      if (record !== undefined) {
        const text = `${use.operator} ${latin1.decode(use.name)}`;
        if (!record.has(text)) {
          record.set(text, use);
        }
      }
      if (this.use(use, lookup)) {
        return true;
      }
    }
    return false;
  }
}

const pageUsesTransparency = (document: LoadedDocument, internals: DocumentInternals, pageIndex: number): boolean => {
  const page = document.page(pageIndex);
  const object = document.get(page.reference);
  if (object.kind !== 'dictionary') {
    throw new ValidationError('page is not a dictionary', 'unreadable-resource');
  }
  const group = entriesOf(internals, object.entries.get(key('Group')));
  const groupSubtype = internals.objects.deref(group?.get(key('S')));
  if (nameOf(groupSubtype) === 'Transparency') {
    return true;
  }
  const entry = internals.pages[pageIndex];
  if (entry === undefined) {
    throw new ValidationError('page entry is missing', 'unreadable-resource');
  }
  const content = pageContent(internals, entry);
  if (content.problems.length > 0) {
    throw new ValidationError('page content cannot be read', 'unreadable-resource');
  }
  const resources = page.resources();
  const scan = new TransparencyScan(internals, resources);
  return scan.operations(content.streams, resources) || scan.annotations(object.entries.get(key('Annots')), resources);
};

const scale = 10 ** DEFAULT_FRACTION_DIGITS;
// The writer keeps DEFAULT_FRACTION_DIGITS decimals, so an edge copied from a box written with more digits is rounded towards the inside of that box.
const roundUp = (value: number): number => {
  const scaled = Math.round(value * scale);
  return (scaled / scale < value ? scaled + 1 : scaled) / scale;
};
const roundDown = (value: number): number => {
  const scaled = Math.round(value * scale);
  return (scaled / scale > value ? scaled - 1 : scaled) / scale;
};

const defaultTrim = (boxes: EffectiveBoxes, index: number): readonly [number, number, number, number] => {
  // ISO 32000-1:2008, Table 30: TrimBox "Default value: the value of CropBox", and CropBox "Default value: the value of MediaBox".
  // 14.11.2.1: a crop, bleed, trim or art box that extends beyond the media box is effectively reduced to its intersection with the media box.
  const limits = [boxes.MediaBox.rect, boxes.CropBox.rect];
  // Table 30, BleedBox: the region to which page contents are clipped in production output, so a trimmed page lies inside it.
  if (boxes.BleedBox.explicit) {
    limits.push(boxes.BleedBox.rect);
  }
  const left = roundUp(Math.max(...limits.map(box => box[0])));
  const bottom = roundUp(Math.max(...limits.map(box => box[1])));
  const right = roundDown(Math.min(...limits.map(box => box[2])));
  const top = roundDown(Math.min(...limits.map(box => box[3])));
  if (left >= right || bottom >= top) {
    throw new ValidationError(`page ${String(index)} has no area shared by its MediaBox, CropBox and BleedBox to use as a TrimBox`);
  }
  return [left, bottom, right, top];
};

/** Adds a TrimBox equal to the CropBox, reduced to the MediaBox and to an explicit BleedBox, to each page that sets neither TrimBox nor ArtBox (ISO 32000-1:2008, Table 30), and an isolated DeviceCMYK transparency group (11.4.7; 11.6.6, Table 147) to each page without a Group entry whose content uses transparency. A Type 3 font that the content selects, with Tf or a graphics state Font entry, uses transparency when any of its glyph procedures does, whichever glyphs are shown, and one that cannot be decoded throws ValidationError `unreadable-resource`. Forms, patterns, glyph procedures and annotation appearance subdictionaries nested more than the document's maxNesting levels deep throw ResourceLimitError. A glyph procedure is read with the Resources of each font that shows it, and ResourceLimitError is also thrown when that takes a page more than maxDecodedBytes steps: one for each entry of a CharProcs dictionary the first time it is read, one for each later font that reads it with other Resources and for each resource name that font looks up again, and one for each byte of a glyph procedure read again before its first read ends. */
export const preparePdfX4Pages = (document: LoadedDocument, options: PdfX4PageOptions = {}): PdfX4PageChange => {
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new ValidationError('document internals are unavailable', 'unreadable-resource');
  }
  const trim = new Map<number, readonly [number, number, number, number]>();
  const groups: Array<number> = [];
  for (let index = 0; index < document.pageCount; index++) {
    const page = document.page(index);
    const boxes = page.boxes();
    if (!boxes.TrimBox.explicit && !boxes.ArtBox.explicit) {
      if (options.pageBoxes === 'refuse') {
        throw new ValidationError(`page ${String(index)} has no TrimBox or ArtBox`);
      }
      trim.set(index, defaultTrim(boxes, index));
    }
    const owner = document.get(page.reference);
    if (owner.kind !== 'dictionary') {
      throw new ValidationError('page is not a dictionary', 'unreadable-resource');
    }
    if (!owner.entries.has(key('Group')) && pageUsesTransparency(document, internals, index)) {
      groups.push(index);
    }
  }
  for (const [index, [left, bottom, right, top]] of trim) {
    document.page(index).setBox('TrimBox', [pt(left), pt(bottom), pt(right), pt(top)]);
  }
  for (const index of groups) {
    const page = document.page(index);
    const owner = document.get(page.reference);
    if (owner.kind !== 'dictionary') {
      throw new ValidationError('page is not a dictionary', 'unreadable-resource');
    }
    const group = new Entries([
      [key('S'), pdfName('Transparency')],
      [key('CS'), pdfName('DeviceCMYK')],
      [key('I'), { kind: 'boolean', value: true }],
    ]);
    owner.entries.set(key('Group'), pdfDictionary(group));
    document.set(page.reference, owner);
  }
  if (trim.size > 0 || groups.length > 0) {
    internals.objects.requireFullRewrite('color-conversion');
  }
  return { addedTrimBoxes: [...trim.keys()], addedPageGroups: groups };
};

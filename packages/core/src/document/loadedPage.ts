import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ContentContext } from './appendContent.ts';
import type { ContentBuilder } from './contentBuilder.ts';
import type { ResourceCategory, ResourceObjects } from './pageResources.ts';
import type { PageEntry, TreeNode } from './pageTree.ts';
import type { PdfRect } from './rect.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { ParseError } from '../error/parseError.ts';
import { ValidationError } from '../error/validationError.ts';
import { formatLength } from '../length/length.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { cloneDirect, cloneObject } from '../object/cloneObject.ts';
import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfName, pdfReal } from '../object/pdfObject.ts';

import { appendPageContent } from './appendContent.ts';
import { addPageResource } from './pageResources.ts';
import { rect } from './rect.ts';

/** One of the five page boundaries defined by ISO 32000-1:2008, 7.7.3.3, Table 30. */
export type BoxName = 'MediaBox' | 'CropBox' | 'BleedBox' | 'TrimBox' | 'ArtBox';

/** A normalized page boundary with its explicit or inherited origin; inherited CropBox, BleedBox, TrimBox, and ArtBox values use ISO 32000-1:2008, 7.7.3.3, Table 30 defaults. */
export interface EffectiveBox {
  /** Normalised to lower-left and upper-right corners. */
  readonly rect: readonly [number, number, number, number];
  /** Whether the page or an ancestor sets the box, rather than an ISO 32000-1:2008, Table 30 default applying. */
  readonly explicit: boolean;
  /** The page tree node the value is inherited from. */
  readonly inheritedFrom?: PdfReference;
}

/** The five effective page boxes plus rotation and user-unit scaling after inheritance and defaults under ISO 32000-1:2008, 7.7.3.3–7.7.3.4. */
export type EffectiveBoxes = Readonly<Record<BoxName, EffectiveBox>> & { readonly rotate: number; readonly userUnit: number };

/** Reads effective page boxes and resources and edits boxes, content, date, and page-piece data; boxes must have nonzero area inside MediaBox and invalid edits raise ValidationError under ISO 32000-1:2008, 7.7.3.3, Table 30. */
export interface LoadedPage {
  readonly index: number;
  readonly reference: PdfReference;
  /** The five page boxes with inheritance and defaults applied (ISO 32000-1:2008, 7.7.3.3, Table 30 and 7.7.3.4). */
  boxes: () => EffectiveBoxes;
  /** The effective resource dictionary, own or inherited, as a fresh copy. */
  resources: () => PdfDictionaryEntries;
  /**
   * Sets one of the page's own boxes, or removes it with undefined so that the inherited value or the ISO 32000-1:2008, Table 30 default applies.
   * Only the page object changes, never an ancestor it inherits from; the box must have non-zero area and lie within the effective MediaBox.
   */
  setBox: (box: BoxName, rect: PdfRect | undefined) => void;
  /**
   * Adds a resource under the first free name made of the prefix and a number (CS1, CS2, … for colour spaces by default) and returns the name's bytes.
   * A stream value is added as a new object. Only the page, its own resources object, or new copies of resources other pages share are changed.
   */
  addResource: (category: ResourceCategory, value: PdfObject, options?: { prefix?: string }) => Uint8Array;
  /**
   * Adds a content stream after the existing ones, which are never rewritten: raw content bytes, or content drawn with a builder whose resources are added to the page under unused names.
   * With isolate (the default) the existing content is wrapped in q and Q, so the new content starts in the default graphics state.
   */
  appendContent: (content: Uint8Array | ((content: ContentBuilder) => void), options?: { isolate?: boolean }) => void;
  lastModified: () => PdfObject | undefined;
  /**
   * Sets the page's LastModified date, or removes it with undefined; no other edit changes it.
   * Removing it is refused while the page has PieceInfo, which ISO 32000-1:2008, Table 30 says requires it.
   */
  setLastModified: (date: PdfDate | undefined) => void;
  pieceInfo: () => PdfObject | undefined;
}

/** The objects a page reads and changes. */
export type PageObjects = ResourceObjects;

/** Resolves indirect objects, including changes made to the document. */
export interface ObjectResolver {
  resolve: (objectNumber: number, generation: number) => PdfObject;
  deref: (value: PdfDirectObject | undefined) => PdfObject | undefined;
}

const MEDIA_BOX = pdfName('MediaBox').bytes;
const CROP_BOX = pdfName('CropBox').bytes;
const ROTATE = pdfName('Rotate').bytes;
const USER_UNIT = pdfName('UserUnit').bytes;
const RESOURCES = pdfName('Resources').bytes;
const LAST_MODIFIED = pdfName('LastModified').bytes;
const PIECE_INFO = pdfName('PieceInfo').bytes;

const label = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)} R`;

const dictionaryOf = (resolver: ObjectResolver, reference: PdfReference): PdfDictionaryEntries => {
  const value = resolver.resolve(reference.objectNumber, reference.generation);
  if (value.kind !== 'dictionary') throw new ParseError(`page tree object ${label(reference)} is not a dictionary`, 0);
  return value.entries;
};

/** Reads a number, or throws ParseError naming the object and key; a real may hold an exact length set by an edit. */
export const numberValue = (value: PdfObject | undefined, where: string): number => {
  if (value?.kind === 'integer') return value.value;
  if (value?.kind === 'real') return typeof value.value === 'number' ? value.value : Number(formatLength(value.value, DEFAULT_FRACTION_DIGITS));
  const found = value?.kind === 'invalid' ? `the token ${new TextDecoder('latin1').decode(value.bytes)}` : (value?.kind ?? 'nothing');
  throw new ParseError(`${where} must be a number but is ${found}`, 0);
};

// ISO 32000-1:2008, 7.9.5: "A rectangle shall be written as an array of four numbers giving the coordinates of a pair of diagonally opposite corners." Rectangles are normalised, as its NOTE says readers should be prepared to do.
const rectangle = (resolver: ObjectResolver, value: PdfDirectObject, where: string): EffectiveBox['rect'] => {
  const array = resolver.deref(value);
  if (array?.kind !== 'array' || array.items.length !== 4) throw new ParseError(`${where} is not an array of four numbers`, 0);
  const [x1, y1, x2, y2] = array.items.map((item, index) => numberValue(resolver.deref(item), `${where}[${String(index)}]`));
  return [Math.min(x1 ?? 0, x2 ?? 0), Math.min(y1 ?? 0, y2 ?? 0), Math.max(x1 ?? 0, x2 ?? 0), Math.max(y1 ?? 0, y2 ?? 0)];
};

export interface Found {
  readonly value: PdfDirectObject;
  readonly from?: PdfReference;
}

/** Inherited values shared by pages and their ancestors during one load or comparison. */
export interface InheritedCache {
  readonly pages: WeakMap<PageEntry, Map<string, Found | undefined>>;
  readonly ancestors: WeakMap<TreeNode, Map<string, Found | undefined>>;
}

export const createInheritedCache = (): InheritedCache => ({ pages: new WeakMap(), ancestors: new WeakMap() });

const keyText = (key: Uint8Array): string => {
  let text = '';
  for (const byte of key) text += String.fromCodePoint(byte);
  return text;
};

// ISO 32000-1:2008, 7.3.10 reads a reference to a missing object as null, and 7.3.7 treats a null value as an absent entry.
const present = (resolver: ObjectResolver, value: PdfDirectObject | undefined): value is PdfDirectObject =>
  value !== undefined && resolver.deref(value)?.kind !== 'null';

// 7.7.3.4: "If such an attribute is omitted from a page object, its value shall be inherited from an ancestor node in the page tree."
export const inherited = (
  resolver: ObjectResolver,
  entry: PageEntry,
  { key, cache }: { key: Uint8Array; cache?: InheritedCache | undefined },
): Found | undefined => {
  const name = cache === undefined ? '' : keyText(key);
  const cached = cache?.pages.get(entry);
  if (cached?.has(name) === true) return cached.get(name);
  const own = dictionaryOf(resolver, entry.reference).get(key);
  let found: Found | undefined = present(resolver, own) ? { value: own } : undefined;
  if (found === undefined) {
    const visited: TreeNode[] = [];
    for (let node = entry.parent; node !== undefined; node = node.parent) {
      const inheritedValue = cache?.ancestors.get(node);
      if (inheritedValue?.has(name) === true) {
        found = inheritedValue.get(name);
        break;
      }
      visited.push(node);
      const value = dictionaryOf(resolver, node.reference).get(key);
      if (present(resolver, value)) {
        found = { value, from: node.reference };
        break;
      }
    }
    if (cache !== undefined) {
      for (const node of visited) {
        let values = cache.ancestors.get(node);
        if (values === undefined) {
          values = new Map();
          cache.ancestors.set(node, values);
        }
        values.set(name, found);
      }
    }
  }
  if (cache !== undefined) {
    const values = cached ?? new Map<string, Found | undefined>();
    values.set(name, found);
    cache.pages.set(entry, values);
  }
  return found;
};

const effectiveBox = (resolver: ObjectResolver, found: Found, where: string): EffectiveBox => {
  const corners = rectangle(resolver, found.value, where);
  return found.from === undefined ? { rect: corners, explicit: true } : { rect: corners, explicit: true, inheritedFrom: found.from };
};

export const effectiveBoxes = (resolver: ObjectResolver, entry: PageEntry, cache?: InheritedCache): EffectiveBoxes => {
  const page = label(entry.reference);
  const media = inherited(resolver, entry, { key: MEDIA_BOX, cache });
  // Table 30, MediaBox: "(Required; inheritable)".
  if (media === undefined) throw new ParseError(`page ${page} has no MediaBox, on itself or on an ancestor`, 0);
  const mediaBox = effectiveBox(resolver, media, `the MediaBox of page ${page}`);
  const crop = inherited(resolver, entry, { key: CROP_BOX, cache });
  // Table 30, CropBox: "Default value: the value of MediaBox"; BleedBox, TrimBox and ArtBox: "Default value: the value of CropBox". Those three are not inheritable.
  const cropBox = crop === undefined ? { rect: mediaBox.rect, explicit: false } : effectiveBox(resolver, crop, `the CropBox of page ${page}`);
  const own = dictionaryOf(resolver, entry.reference);
  const production = (name: 'BleedBox' | 'TrimBox' | 'ArtBox'): EffectiveBox => {
    const value = own.get(pdfName(name).bytes);
    return present(resolver, value) ? effectiveBox(resolver, { value }, `the ${name} of page ${page}`) : { rect: cropBox.rect, explicit: false };
  };
  const rotate = inherited(resolver, entry, { key: ROTATE, cache });
  const unit = own.get(USER_UNIT);
  const userUnit = present(resolver, unit) ? unit : undefined;
  return {
    MediaBox: mediaBox,
    CropBox: cropBox,
    BleedBox: production('BleedBox'),
    TrimBox: production('TrimBox'),
    ArtBox: production('ArtBox'),
    // Table 30, Rotate: "(Optional; inheritable) ... Default value: 0"; UserUnit: "(Optional; PDF 1.6) ... Default value: 1.0".
    rotate: rotate === undefined ? 0 : numberValue(resolver.deref(rotate.value), `the Rotate of page ${page}`),
    userUnit: userUnit === undefined ? 1 : numberValue(resolver.deref(userUnit), `the UserUnit of page ${page}`),
  };
};

export const effectiveResources = (resolver: ObjectResolver, entry: PageEntry, cache?: InheritedCache): PdfDictionaryEntries | undefined => {
  const found = inherited(resolver, entry, { key: RESOURCES, cache });
  if (found === undefined) return undefined;
  const value = resolver.deref(found.value);
  if (value?.kind !== 'dictionary') throw new ParseError(`the Resources of page ${label(entry.reference)} is not a dictionary`, 0);
  return value.entries;
};

const pageDictionary = (objects: PageObjects, reference: PdfReference): PdfDictionaryEntries => {
  const value = objects.get(reference);
  if (value.kind !== 'dictionary') throw new ParseError(`page ${label(reference)} is not a dictionary`, 0);
  return value.entries;
};

const rounded = (box: PdfRect): number[] => box.map(length => Number(formatLength(length, DEFAULT_FRACTION_DIGITS)));

// Writer policy, as for created pages: a box has non-zero area and every box other than MediaBox lies within MediaBox.
const checkBox = (name: BoxName, corners: PdfRect, mediaBox: EffectiveBox['rect']): void => {
  const [left = 0, bottom = 0, right = 0, top = 0] = rounded(corners);
  if (left >= right || bottom >= top) throw new ValidationError(`the ${name} has zero area after rounding; pdfwright requires page boxes with non-zero area`);
  if (name === 'MediaBox') return;
  const [mediaLeft, mediaBottom, mediaRight, mediaTop] = mediaBox;
  if (left < mediaLeft || bottom < mediaBottom || right > mediaRight || top > mediaTop) {
    throw new ValidationError(`the ${name} extends beyond the MediaBox; pdfwright requires every page box to lie within it`);
  }
};

const setBox = (objects: PageObjects, entry: PageEntry, [name, corners]: readonly [BoxName, PdfRect | undefined]): void => {
  const dictionary = pageDictionary(objects, entry.reference);
  const key = pdfName(name).bytes;
  if (corners === undefined) {
    // Table 30, MediaBox: "(Required; inheritable)"; removing the page's own value is refused when no ancestor supplies one.
    if (name === 'MediaBox') {
      let supplied = false;
      for (let node = entry.parent; node !== undefined; node = node.parent) {
        if (dictionaryOf(objects, node.reference).has(key)) {
          supplied = true;
          break;
        }
      }
      if (!supplied) throw new ValidationError(`page ${label(entry.reference)} inherits no MediaBox, so its own cannot be removed`);
    }
    dictionary.delete(key);
  } else {
    const normalized = rect(...corners);
    checkBox(name, normalized, effectiveBoxes(objects, entry).MediaBox.rect);
    // ISO 32000-1:2008, 7.9.5: "A rectangle shall be written as an array of four numbers".
    dictionary.set(key, pdfArray(normalized.map(length => pdfReal(length))));
  }
  objects.set(entry.reference, { kind: 'dictionary', entries: dictionary });
};

const copied = (value: PdfObject | undefined): PdfObject | undefined => (value === undefined ? undefined : cloneObject(value));

export const createLoadedPage = (context: ContentContext, entry: PageEntry, index: number): LoadedPage => {
  const resolver = context.objects;
  return {
    index,
    reference: entry.reference,
    boxes: () => effectiveBoxes(resolver, entry),
    resources: () => {
      const resources = effectiveResources(resolver, entry);
      return parsedDictionaryEntries(resources === undefined ? [] : [...resources.entries()].map(([key, value]) => [key, cloneDirect(value)] as const));
    },
    setBox: (name, corners) => {
      setBox(resolver, entry, [name, corners]);
    },
    appendContent: (content, options) => {
      appendPageContent(context, entry, { content, isolate: options?.isolate ?? true });
    },
    addResource: (category, value, options) =>
      addPageResource(context, entry, options?.prefix === undefined ? { category, value } : { category, value, prefix: options.prefix }),
    lastModified: () => copied(resolver.deref(dictionaryOf(resolver, entry.reference).get(LAST_MODIFIED))),
    setLastModified: date => {
      const dictionary = pageDictionary(resolver, entry.reference);
      // Table 30, LastModified: "(Required if PieceInfo is present; optional otherwise; PDF 1.3)".
      if (date === undefined && dictionary.has(PIECE_INFO)) {
        throw new ValidationError(`page ${label(entry.reference)} has PieceInfo, which requires LastModified`);
      }
      if (date === undefined) dictionary.delete(LAST_MODIFIED);
      else dictionary.set(LAST_MODIFIED, pdfDateObject(date));
      resolver.set(entry.reference, { kind: 'dictionary', entries: dictionary });
    },
    pieceInfo: () => copied(resolver.deref(dictionaryOf(resolver, entry.reference).get(PIECE_INFO))),
  };
};

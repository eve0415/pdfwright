import type { InspectWarning } from '../../content/inspectWarning.ts';
import type { ColorSelectEvent, ColorSpaceUse, PaintContext, PaintEvent, TextShowEvent } from '../../content/interpreter.ts';
import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { LoadedDocument } from '../../document/loadDocument.ts';
import type { Found, InheritedCache } from '../../document/loadedPage.ts';
import type { PdfDictionaryEntries } from '../../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../../object/pdfObject.ts';
import type { AlternateSummary, ColorantKind, SpaceColorant } from './colorSpaceColorants.ts';

import { interpretPage } from '../../content/interpreter.ts';
import { unreadable } from '../../content/unreadable.ts';
import { internalsOf } from '../../document/documentInternals.ts';
import { createInheritedCache, inherited } from '../../document/loadedPage.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { dictionaryOf, latin1, numberOf } from '../../font/fontValues.ts';
import { FontCache, pageResourcesOwner } from '../../font/loadFont.ts';
import { pdfName } from '../../object/pdfObject.ts';
import { walkResources } from '../../resourceGraph/walkResources.ts';

import { colorSpaceColorants } from './colorSpaceColorants.ts';

const RESOURCES = pdfName('Resources').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SHADING = pdfName('Shading').bytes;
const PATTERN = pdfName('Pattern').bytes;
const PATTERN_TYPE = pdfName('PatternType').bytes;
const SEPARATION_INFO = pdfName('SeparationInfo').bytes;
const DEVICE_COLORANT = pdfName('DeviceColorant').bytes;

/** How a painting operation reached a colorant: the operation, and whether it happened in a pattern, a Type 3 glyph procedure or a printable annotation appearance. */
export type PaintedBy = 'fill' | 'stroke' | 'text' | 'image' | 'image-mask' | 'inline-image' | 'shading' | 'pattern' | 'type3-glyph' | 'annotation';

/** Executed content that set the colorant's space as the current colour space without a visible mark: no later painting operator, text in render mode 3 or at alpha 0, or a path that only clips. */
export type SelectedBy = 'colour-space-only' | 'invisible-text' | 'clip-only';

/** Why a colorant is named without being painted there. */
export type DeclaredOnlyReason =
  /** Named in a reachable resource dictionary and never painted on the page. */
  | 'resources'
  /** Painted or selected only inside a soft mask's group: 11.7.3 substitutes the alternate space there. */
  | 'soft-mask'
  /** Set inside a d1 glyph procedure, where 8.6.8 says colour operators are ignored. */
  | 'd1-glyph'
  /** Set inside an uncoloured tiling pattern's cell, where colour operators are likewise ignored. */
  | 'uncoloured-pattern'
  /** In the appearance of an annotation that does not print (Table 165). */
  | 'annotation-not-printed'
  /** Listed in an NChannel space's Colorants dictionary without being a component of the space (Table 71). */
  | 'nchannel-colorants'
  /** Named by the page's SeparationInfo (14.11.4). */
  | 'separation-info';

export interface ColorantUse {
  /** The colorant name as bytes, with #xx escapes decoded. */
  readonly name: Uint8Array;
  readonly kind: ColorantKind;
  /** Empty when no painting operator reached the colorant. A colorant painted anywhere on the page is painted, whatever else declares it. */
  readonly painted: readonly PaintedBy[];
  readonly selected: readonly SelectedBy[];
  /** Every reason that applies, including for a painted colorant, except `resources`, which is given only for a colorant not painted. */
  readonly declared: readonly DeclaredOnlyReason[];
  /** The distinct alternate definitions the colorant appears with, so that one colorant defined two ways can be found. */
  readonly alternates: readonly AlternateSummary[];
}

export interface PageColorants {
  readonly page: number;
  /** Sorted by name bytes. */
  readonly colorants: readonly ColorantUse[];
  /** False when some content, resource or colour space could not be read or interpreted. */
  readonly complete: boolean;
  readonly warnings: readonly InspectWarning[];
}

export interface ListColorantsOptions {
  /** 0-based indexes of the pages to inspect; all pages when absent. */
  readonly pages?: readonly number[];
}

const PAINTED_ORDER: readonly PaintedBy[] = [
  'fill',
  'stroke',
  'text',
  'image',
  'image-mask',
  'inline-image',
  'shading',
  'pattern',
  'type3-glyph',
  'annotation',
];
const SELECTED_ORDER: readonly SelectedBy[] = ['colour-space-only', 'invisible-text', 'clip-only'];
const DECLARED_ORDER: readonly DeclaredOnlyReason[] = [
  'resources',
  'soft-mask',
  'd1-glyph',
  'uncoloured-pattern',
  'annotation-not-printed',
  'nchannel-colorants',
  'separation-info',
];

// 9.3.6, Table 106: render modes 0, 2, 4 and 6 fill glyphs.
const FILLING_MODES = new Set([0, 2, 4, 6]);

const PROCESS_NAMES = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);

interface Use {
  readonly name: Uint8Array;
  readonly kind: ColorantKind;
  readonly painted: Set<PaintedBy>;
  readonly selected: Set<SelectedBy>;
  readonly declared: Set<DeclaredOnlyReason>;
  readonly alternates: Map<string, AlternateSummary>;
  /** Selected by a colour-space operator where colours take effect. */
  chosen: boolean;
  /** Named in a reachable resource dictionary. */
  inResources: boolean;
}

/** Where a paint or selection counts: on the page, only in a soft mask, or only in an annotation that does not print. */
type Place = 'page' | 'soft-mask' | 'annotation-not-printed';

const placeOf = ({ sources }: PaintContext): Place => {
  if (sources.some(source => source.kind === 'soft-mask')) return 'soft-mask';
  const [outer] = sources;
  return outer?.kind === 'annotation' && !outer.printable ? 'annotation-not-printed' : 'page';
};

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const isPatternSpace = ({ space }: ColorSpaceUse): boolean => {
  const family = space?.kind === 'array' ? space.items[0] : space;
  return family?.kind === 'name' && latin1(family.bytes) === 'Pattern';
};

const OPERATION: Readonly<Record<Exclude<PaintEvent['kind'], 'fill-stroke' | 'clip'>, PaintedBy>> = {
  fill: 'fill',
  stroke: 'stroke',
  text: 'text',
  image: 'image',
  'image-mask': 'image-mask',
  'inline-image': 'inline-image',
  'inline-image-mask': 'image-mask',
  shading: 'shading',
};

// Whether the direct space at an index is painted by stroking: fill-stroke paints its first space by filling and its second by stroking; text fills before it strokes.
const strokesAt = (event: PaintEvent, index: number): boolean => {
  if (event.kind === 'fill-stroke') return index === 1;
  if (event.kind === 'text') return index > 0 || !FILLING_MODES.has(event.state.renderMode);
  return event.kind === 'stroke';
};

// The operation that painted with the direct space at an index.
const operationAt = (event: PaintEvent, index: number): PaintedBy => {
  if (event.kind === 'fill-stroke') return index === 0 ? 'fill' : 'stroke';
  if (event.kind === 'clip') return 'fill';
  return OPERATION[event.kind];
};

const contextPainters = ({ sources }: PaintContext): PaintedBy[] => {
  const painters: PaintedBy[] = [];
  if (sources.some(source => source.kind === 'tiling-pattern')) painters.push('pattern');
  if (sources.some(source => source.kind === 'type3-glyph')) painters.push('type3-glyph');
  if (sources[0]?.kind === 'annotation') painters.push('annotation');
  return painters;
};

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

class PageScan {
  private readonly document: DocumentInternals;
  private readonly uses = new Map<string, Use>();
  private readonly spaces = new Map<PdfObject, readonly SpaceColorant[]>();
  readonly warnings: InspectWarning[] = [];
  private readonly reported = new Set<string>();
  complete = true;

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  warn(warning: InspectWarning, incomplete: boolean): void {
    const key = `${warning.code} ${warning.detail}`;
    if (!this.reported.has(key)) this.warnings.push(warning);
    this.reported.add(key);
    if (incomplete) this.complete = false;
  }

  // An object that cannot be read is reported and read as absent; the handlers run inside content interpretation, which a thrown error would stop.
  private read(value: PdfObject | undefined): PdfObject | undefined {
    try {
      return value?.kind === 'reference' ? this.document.objects.deref(value) : value;
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      this.warn({ code: 'content-unreadable', detail: `an object cannot be read: ${error.message}` }, true);
      return undefined;
    }
  }

  private colorantsOf(space: PdfObject | undefined): readonly SpaceColorant[] {
    if (space === undefined) return [];
    const known = this.spaces.get(space);
    if (known !== undefined) return known;
    let colorants: readonly SpaceColorant[] = [];
    try {
      const result = colorSpaceColorants(this.document.objects, space);
      for (const warning of result.warnings) this.warn(warning, warning.code === 'colorspace-unreadable');
      ({ colorants } = result);
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      this.warn({ code: 'colorspace-unreadable', detail: `a colour space cannot be read: ${error.message}` }, true);
    }
    this.spaces.set(space, colorants);
    return colorants;
  }

  private use(name: Uint8Array, kind: ColorantKind): Use {
    const key = hex(name);
    let use = this.uses.get(key);
    if (use === undefined) {
      use = { name, kind, painted: new Set(), selected: new Set(), declared: new Set(), alternates: new Map(), chosen: false, inResources: false };
      this.uses.set(key, use);
    }
    return use;
  }

  // Applies a mark to each colorant of a space; colorants an NChannel space only lists are declared as such whatever the mark.
  each(space: PdfObject | undefined, mark: (use: Use) => void): void {
    for (const colorant of this.colorantsOf(space)) {
      const use = this.use(colorant.name, colorant.kind);
      if (colorant.alternate !== undefined) use.alternates.set(colorant.alternate.definition, colorant.alternate);
      if (colorant.component) mark(use);
      else use.declared.add('nchannel-colorants');
    }
  }

  // Where a paint or selection does not count for the page, its colorants are declared for that reason.
  private placed(place: Place, space: PdfObject | undefined, mark: (use: Use) => void): void {
    if (place === 'page') {
      this.each(space, mark);
      return;
    }
    this.each(space, use => {
      use.declared.add(place);
    });
  }

  paint(event: PaintEvent): void {
    const place = placeOf(event.context);
    const painters = contextPainters(event.context);
    // Text, and the painting a Type 3 glyph procedure does for its glyph, marks nothing at alpha 0.
    const glyph = event.kind === 'text' || event.context.sources.some(source => source.kind === 'type3-glyph');
    const { fillAlpha, strokeAlpha, group } = event.state;
    for (const [index, space] of event.colorSpaces.entries()) {
      // A path that only clips paints nothing; the base of a Pattern space it was built in is read with the space.
      if (event.kind === 'clip') {
        this.placed(place, space.space, use => {
          use.selected.add('clip-only');
        });
        continue;
      }
      if (isPatternSpace(space)) continue;
      const owner = event.spaceOf[index] ?? index;
      const operation = operationAt(event, owner);
      if (glyph && (strokesAt(event, owner) ? strokeAlpha : fillAlpha) * group.alpha === 0) {
        this.placed(place, space.space, use => {
          use.selected.add('invisible-text');
        });
        continue;
      }
      const by: PaintedBy[] = owner === index ? [operation, ...painters] : [operation, 'pattern', ...painters];
      this.placed(place, space.space, use => {
        for (const painter of by) use.painted.add(painter);
      });
    }
  }

  select(event: ColorSelectEvent): void {
    const place = placeOf(event.context);
    const { colour } = event.context;
    const mark = (use: Use): void => {
      if (colour === 'used') use.chosen = true;
      else use.declared.add(colour);
    };
    this.placed(place, event.use.space, mark);
    // A shading pattern chosen where colours are ignored names its shading's space (8.7.4.1).
    const pattern = dictionaryOf(event.use.pattern?.value);
    if (colour !== 'used' && numberOf(this.read(pattern?.get(PATTERN_TYPE))) === 2) {
      const shading = dictionaryOf(this.read(pattern?.get(SHADING)));
      this.placed(place, this.read(shading?.get(COLOR_SPACE)), mark);
    }
  }

  // 9.3.6, Table 106: render mode 3 paints nothing and mode 7 only adds the glyphs to the clipping path.
  text(event: TextShowEvent): void {
    const mode = event.state.renderMode;
    if (event.string.length === 0 || (mode !== 3 && mode !== 7)) return;
    const reason: SelectedBy = mode === 3 ? 'invisible-text' : 'clip-only';
    this.placed(placeOf(event.context), event.state.fill.space, use => {
      use.selected.add(reason);
    });
  }

  // 7.8.3: the colour spaces a resource dictionary names: ColorSpace resources, image XObjects' spaces, shadings' spaces and shading patterns' spaces.
  resources(resources: PdfDictionaryEntries): void {
    // Each entry is read apart, so that one that cannot be read hides no other.
    const values = (category: Uint8Array): PdfObject[] =>
      [...(dictionaryOf(this.read(resources.get(category)))?.entries() ?? [])].flatMap(([, value]) => {
        const object = this.read(value);
        return object === undefined ? [] : [object];
      });
    const declare = (space: PdfObject | undefined): void => {
      this.each(space, use => {
        use.inResources = true;
      });
    };
    for (const space of values(COLOR_SPACE)) declare(space);
    for (const xObject of values(XOBJECT)) if (xObject.kind === 'stream') declare(this.read(xObject.dictionary.get(COLOR_SPACE)));
    for (const shading of values(SHADING)) declare(this.read(dictionaryOf(shading)?.get(COLOR_SPACE)));
    for (const pattern of values(PATTERN)) {
      const shading = dictionaryOf(this.read(dictionaryOf(pattern)?.get(SHADING)));
      declare(this.read(shading?.get(COLOR_SPACE)));
    }
  }

  // 14.11.4, Table 364: DeviceColorant is "The name of the device colorant to be used in rendering this separation", a name or a string; ColorSpace "An array defining a Separation or DeviceN colour space".
  separationInfo(page: PdfDictionaryEntries | undefined): void {
    const { objects } = this.document;
    const info = dictionaryOf(objects.deref(page?.get(SEPARATION_INFO)));
    if (info === undefined) return;
    const colorant = objects.deref(info.get(DEVICE_COLORANT));
    if (colorant?.kind === 'name' || colorant?.kind === 'string') {
      const text = latin1(colorant.bytes);
      let kind: ColorantKind = PROCESS_NAMES.has(text) ? 'process' : 'spot';
      if (text === 'All') kind = 'all';
      else if (text === 'None') kind = 'none';
      this.use(colorant.bytes, kind).declared.add('separation-info');
    }
    this.each(objects.deref(info.get(COLOR_SPACE)), use => {
      use.declared.add('separation-info');
    });
  }

  result(): ColorantUse[] {
    return [...this.uses.values()]
      .map(use => {
        const selected = new Set(use.selected);
        if (use.chosen && use.painted.size === 0 && selected.size === 0) selected.add('colour-space-only');
        const declared = new Set(use.declared);
        if (use.inResources && use.painted.size === 0) declared.add('resources');
        return {
          name: use.name,
          kind: use.kind,
          painted: PAINTED_ORDER.filter(painter => use.painted.has(painter)),
          selected: SELECTED_ORDER.filter(reason => selected.has(reason)),
          declared: DECLARED_ORDER.filter(reason => declared.has(reason)),
          alternates: [...use.alternates.values()],
        };
      })
      .toSorted((left, right) => compareBytes(left.name, right.name));
  }
}

interface Scan {
  readonly document: DocumentInternals;
  readonly fonts: FontCache;
  readonly cache: InheritedCache;
}

const scanResources = ({ document, cache }: Scan, index: number, scan: PageScan): void => {
  const page = document.pages[index];
  if (page === undefined) return;
  let found: Found | undefined = undefined;
  try {
    found = inherited(document.objects, page, { key: RESOURCES, cache });
    scan.separationInfo(dictionaryOf(document.objects.deref(page.reference)));
  } catch (error: unknown) {
    if (!unreadable(error)) throw error;
    scan.warn({ code: 'content-unreadable', detail: `the page cannot be read: ${error.message}` }, true);
  }
  const unread = walkResources(document, page, {
    resources: found?.value,
    owner: pageResourcesOwner(found, page),
    visit: ({ resources }) => {
      try {
        scan.resources(resources);
      } catch (error: unknown) {
        if (!unreadable(error)) throw error;
        scan.warn({ code: 'content-unreadable', detail: `a resource cannot be read: ${error.message}` }, true);
      }
    },
  });
  for (const object of unread) scan.warn({ code: 'content-unreadable', detail: object.reason }, true);
};

const scanPage = (context: Scan, index: number): PageColorants => {
  const scan = new PageScan(context.document);
  const result = interpretPage(context.document, index, {
    fonts: context.fonts,
    inheritance: context.cache,
    annotations: 'all',
    paint: event => {
      scan.paint(event);
    },
    select: event => {
      scan.select(event);
    },
    text: event => {
      scan.text(event);
    },
  });
  for (const warning of result.warnings) scan.warn(warning, false);
  if (!result.complete) scan.complete = false;
  scanResources(context, index, scan);
  return { page: index, colorants: scan.result(), complete: scan.complete, warnings: scan.warnings };
};

/**
 * Lists the colorants of each page: those painting operators reach in content, forms, patterns, Type 3 glyphs, images, shadings and annotation appearances (`painted`), those executed content selects without a visible mark (`selected`), and those named without being executed (`declared`), each with every reason that applies.
 * Tints and geometry are not considered: a colorant painted at tint 0, outside the crop box or wholly clipped away is painted. Damaged content becomes warnings and `complete: false`; a page index that is not a page throws InvalidArgumentError, and content past the interpreter's limits ResourceLimitError.
 */
export const listColorants = (document: LoadedDocument, options: ListColorantsOptions = {}): readonly PageColorants[] => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new InvalidArgumentError('the document was not loaded by loadDocument');
  const pages = options.pages ?? [...parts.pages.keys()];
  for (const index of pages) {
    if (!Number.isInteger(index) || parts.pages[index] === undefined) {
      throw new InvalidArgumentError(`page index ${String(index)} is not a page of this document, which has ${String(parts.pages.length)}`);
    }
  }
  const context: Scan = { document: parts, fonts: new FontCache(parts, undefined), cache: createInheritedCache() };
  return pages.map(index => scanPage(context, index));
};

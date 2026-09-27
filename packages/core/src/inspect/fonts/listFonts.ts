import type { InspectWarningCode } from '../../content/inspectWarning.ts';
import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { LoadedDocument } from '../../document/loadDocument.ts';
import type { Found, InheritedCache } from '../../document/loadedPage.ts';
import type { PageEntry } from '../../document/pageTree.ts';
import type { CMapProvider } from '../../font/cmap/cmapProvider.ts';
import type { CidFontSubtype, FontEncodingSummary, FontModel, FontSubtype, FontWarningCode } from '../../font/fontModel.ts';
import type { PdfDictionaryEntries } from '../../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../../object/pdfObject.ts';
import type { Type3Reading, Type3Summary } from './type3Glyphs.ts';

import { interpretPage } from '../../content/interpreter.ts';
import { unreadable } from '../../content/unreadable.ts';
import { internalsOf } from '../../document/documentInternals.ts';
import { createInheritedCache, inherited } from '../../document/loadedPage.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { dictionaryOf, latin1, numberOf } from '../../font/fontValues.ts';
import { FontCache, fontKey, pageResourcesOwner } from '../../font/loadFont.ts';
import { STANDARD_14 } from '../../font/standard14.ts';
import { md5 } from '../../hash/md5.ts';
import { pdfName } from '../../object/pdfObject.ts';
import { walkResources } from '../../resourceGraph/walkResources.ts';

import { readType3Glyphs } from './type3Glyphs.ts';

const RESOURCES = pdfName('Resources').bytes;
const FONT_DESCRIPTOR = pdfName('FontDescriptor').bytes;
const FONT_NAME = pdfName('FontName').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const CID_SYSTEM_INFO = pdfName('CIDSystemInfo').bytes;
const REGISTRY = pdfName('Registry').bytes;
const ORDERING = pdfName('Ordering').bytes;
const SUPPLEMENT = pdfName('Supplement').bytes;
const FONT_FILES = ['FontFile', 'FontFile2', 'FontFile3'] as const;

/** How a font's glyph programs are stored. A Type 3 font draws its glyphs with content streams in the font dictionary, so embedding does not apply to it. */
export type FontEmbedding =
  | {
      readonly state: 'embedded';
      /** The font descriptor entry that holds the program (ISO 32000-1:2008, Table 126). */
      readonly file: 'FontFile' | 'FontFile2' | 'FontFile3';
      /** The Subtype of a FontFile3 stream: Type1C, CIDFontType0C or OpenType; undefined for the other entries. */
      readonly fileSubtype: Uint8Array | undefined;
      /** False when Table 126 does not allow the program for the font's type, such as a TrueType program under a Type 1 font. */
      readonly matchesFontType: boolean;
    }
  | { readonly state: 'not-embedded'; readonly standard14: boolean }
  /** The descriptor names a program that cannot be read. */
  | { readonly state: 'unreadable'; readonly file: 'FontFile' | 'FontFile2' | 'FontFile3' }
  | { readonly state: 'not-applicable' };

/** Whether the font's name marks it as a subset (ISO 32000-1:2008, 9.6.4). For a Type 3 font, whose glyph set is its CharProcs, the tag is reported without the state. */
export type FontSubset =
  | { readonly state: 'subset'; readonly tag: string }
  | { readonly state: 'not-subset' }
  | { readonly state: 'not-applicable'; readonly tag: string | undefined };

export type FontProblemCode =
  | 'embedding-type-mismatch'
  | 'subset-tag-malformed'
  | 'subset-tag-reused'
  | 'descriptor-missing'
  | 'widths-missing'
  | 'type3-resources-inherited'
  | 'font-unreadable'
  | 'to-unicode-unreadable'
  | 'to-unicode-range-overflow'
  | 'cmap-unavailable';

export interface FontProblem {
  readonly code: FontProblemCode;
  readonly detail: string;
}

/** A Type 0 font's descendant CIDFont and its character collection (ISO 32000-1:2008, Tables 116 and 117). */
export interface FontDescendant {
  readonly subtype: CidFontSubtype;
  readonly reference: PdfReference | undefined;
  readonly registry: Uint8Array | undefined;
  readonly ordering: Uint8Array | undefined;
  readonly supplement: number | undefined;
}

/** One font dictionary of the document. */
export interface FontEntry {
  /** Names the font here and in content interpretation: `objectNumber.generation` for an indirect font dictionary, or `direct:<owner>:<resource name in hexadecimal>` for one written directly in a resource dictionary. */
  readonly key: string;
  readonly reference: PdfReference | undefined;
  readonly subtype: FontSubtype;
  readonly subtypeBytes: Uint8Array;
  /** BaseFont as stored, or for a Type 3 font the descriptor's FontName, which Table 112 does not require. */
  readonly name: Uint8Array | undefined;
  readonly descendant: FontDescendant | undefined;
  /** The font descriptor, a Type 0 font's descendant's, when it is an indirect object; fonts sharing one descriptor are parts of one font, as with the Type 3 fonts Chromium writes for each 256 glyphs of a font. */
  readonly descriptor: PdfReference | undefined;
  readonly embedding: FontEmbedding;
  readonly subset: FontSubset;
  readonly encoding: FontEncodingSummary;
  readonly toUnicode: 'present' | 'absent' | 'unreadable';
  /** What a Type 3 font's glyph procedures paint; undefined for other fonts. */
  readonly type3: Type3Summary | undefined;
  /** 0-based indexes of the pages whose resources reach the font: through forms, patterns, Type 3 fonts, graphics states, soft masks and annotation appearances. */
  readonly pages: readonly number[];
  /** 0-based indexes of the pages whose content shows at least one string with the font: page content, printable annotation appearances, and Type 3 glyph procedures of fonts the page shows. Empty when `shownOn` is false in the options. */
  readonly shownOn: readonly number[];
  readonly problems: readonly FontProblem[];
}

export interface FontInventory {
  /** Ordered by the first page that reaches or shows each font, then by object number, with direct fonts after indirect ones. */
  readonly fonts: readonly FontEntry[];
  /** Objects on the way to fonts that could not be read, by page. */
  readonly unreadable: readonly { readonly page: number; readonly reason: string }[];
}

export interface ListFontsOptions {
  /** Whether to interpret every page's content to fill `shownOn`; default true. False gives an inventory of resources alone. */
  readonly shownOn?: boolean;
  /** Supplies predefined CMaps other than Identity-H and Identity-V, so that their availability is reported. */
  readonly cmapProvider?: CMapProvider;
}

interface Reached {
  readonly model: FontModel;
  readonly pages: Set<number>;
  readonly shownOn: Set<number>;
  /** The resources of the first page that reaches the font, where a Type 3 font without Resources finds its names. */
  readonly pageResources: PdfDictionaryEntries | undefined;
}

// ISO 32000-1:2008, Table 126: the programs each font type's descriptor may hold.
const ACCEPTED: ReadonlyMap<string, readonly string[]> = new Map([
  ['Type1', ['FontFile', 'FontFile3/Type1C', 'FontFile3/OpenType']],
  ['MMType1', ['FontFile', 'FontFile3/Type1C']],
  ['TrueType', ['FontFile2', 'FontFile3/OpenType']],
  ['CIDFontType0', ['FontFile3/CIDFontType0C', 'FontFile3/OpenType']],
  ['CIDFontType2', ['FontFile2', 'FontFile3/OpenType']],
]);

const PROBLEM_OF_WARNING: Readonly<Record<FontWarningCode, FontProblemCode>> = {
  'font-unreadable': 'font-unreadable',
  'cmap-unavailable': 'cmap-unavailable',
  'to-unicode-unreadable': 'to-unicode-unreadable',
  'to-unicode-range-overflow': 'to-unicode-range-overflow',
  'widths-unknown': 'widths-missing',
};

const internals = (document: LoadedDocument): DocumentInternals => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new InvalidArgumentError('the document was not loaded by loadDocument');
  return parts;
};

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const UNREAD = Symbol('unread');

/** Reads the objects of one font entry; an object that cannot be read is reported as a problem of the entry, which is kept. */
class EntryReader {
  private readonly document: DocumentInternals;
  readonly problems: FontProblem[] = [];

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  // undefined for an absent value, UNREAD for one that cannot be read.
  read(value: PdfDirectObject | undefined, what: string): PdfObject | typeof UNREAD | undefined {
    try {
      return this.document.objects.deref(value);
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      this.problems.push({ code: 'font-unreadable', detail: `${what} cannot be read: ${error.message}` });
      return UNREAD;
    }
  }

  object(value: PdfDirectObject | undefined, what: string): PdfObject | undefined {
    const object = this.read(value, what);
    return object === UNREAD ? undefined : object;
  }
}

interface Program {
  readonly embedding: FontEmbedding;
  /** Tells programs apart for the subset tag rule: a digest of the stored program bytes. */
  readonly identity: string | undefined;
}

// Table 122: "At most, only one of the FontFile, FontFile2, and FontFile3 entries shall be present"; the first present is taken.
const programOf = (reader: EntryReader, font: FontModel, descriptor: PdfDictionaryEntries | undefined): Program => {
  const standard14 = font.subtype === 'Type1' && font.baseFont !== undefined && STANDARD_14.has(latin1(font.baseFont));
  for (const file of FONT_FILES) {
    const stream = reader.read(descriptor?.get(pdfName(file).bytes), `the ${file} program`);
    if (stream === UNREAD) return { embedding: { state: 'unreadable', file }, identity: undefined };
    if (stream?.kind !== 'stream') continue;
    const subtype = file === 'FontFile3' ? reader.object(stream.dictionary.get(SUBTYPE), 'the FontFile3 Subtype') : undefined;
    const fileSubtype = subtype?.kind === 'name' ? subtype.bytes : undefined;
    const type = font.subtype === 'Type0' ? font.descendant?.subtype : font.subtype;
    const form = fileSubtype === undefined ? file : `${file}/${latin1(fileSubtype)}`;
    const matchesFontType = ACCEPTED.get(type ?? '')?.includes(form) ?? false;
    return { embedding: { state: 'embedded', file, fileSubtype, matchesFontType }, identity: hex(md5(stream.data)) };
  }
  return { embedding: { state: 'not-embedded', standard14 }, identity: undefined };
};

interface SubsetReading {
  readonly subset: FontSubset;
  /** Whether a plus sign follows six characters that are not all uppercase letters. */
  readonly malformed: boolean;
}

// ISO 32000-1:2008, 9.6.4: the name "shall begin with a tag followed by a plus sign (+). The tag shall consist of exactly six uppercase letters".
const subsetOf = (name: Uint8Array | undefined, type3: boolean): SubsetReading => {
  const text = name === undefined ? '' : latin1(name);
  const tag = text.length > 6 && text[6] === '+' ? text.slice(0, 6) : undefined;
  const valid = tag !== undefined && /^[A-Z]{6}$/u.test(tag);
  const malformed = tag !== undefined && !valid;
  if (type3) return { subset: { state: 'not-applicable', tag: valid ? tag : undefined }, malformed };
  return { subset: valid ? { state: 'subset', tag } : { state: 'not-subset' }, malformed };
};

const descendantOf = (reader: EntryReader, font: FontModel): FontDescendant | undefined => {
  const { descendant } = font;
  if (descendant === undefined) return undefined;
  const info = dictionaryOf(reader.object(descendant.dictionary.get(CID_SYSTEM_INFO), 'the CIDSystemInfo'));
  const registry = reader.object(info?.get(REGISTRY), 'the CIDSystemInfo Registry');
  const ordering = reader.object(info?.get(ORDERING), 'the CIDSystemInfo Ordering');
  return {
    subtype: descendant.subtype,
    reference: descendant.reference,
    registry: registry?.kind === 'string' ? registry.bytes : undefined,
    ordering: ordering?.kind === 'string' ? ordering.bytes : undefined,
    supplement: numberOf(reader.object(info?.get(SUPPLEMENT), 'the CIDSystemInfo Supplement')),
  };
};

interface Described {
  readonly model: FontModel;
  readonly descriptor: PdfDictionaryEntries | undefined;
  readonly program: Program;
  readonly malformed: boolean;
  readonly glyphs: Type3Reading | undefined;
}

const problemsOf = ({ model, descriptor, program, malformed, glyphs }: Described, damage: readonly FontProblem[]): FontProblem[] => {
  const problems: FontProblem[] = [...damage];
  if (program.embedding.state === 'embedded' && !program.embedding.matchesFontType) {
    problems.push({ code: 'embedding-type-mismatch', detail: `${program.embedding.file} is not a program Table 126 allows for this font type` });
  }
  if (malformed) problems.push({ code: 'subset-tag-malformed', detail: 'the name has a plus sign after six characters that are not all uppercase letters' });
  // Table 111, FontDescriptor: "Required except for the standard 14 fonts"; Table 117 requires it of every CIDFont; Table 112 only in Tagged PDF.
  const standard14 = model.baseFont !== undefined && STANDARD_14.has(latin1(model.baseFont)) && model.subtype !== 'Type0';
  const required = model.subtype === 'Type0' ? model.descendant !== undefined : model.subtype !== 'Type3' && !standard14;
  if (descriptor === undefined && required) problems.push({ code: 'descriptor-missing', detail: 'the font has no font descriptor' });
  // Table 112, Resources: "If any glyph descriptions refer to named resources but this dictionary is absent, the names shall be looked up in the resource dictionary of the page on which the font is used."
  if (glyphs?.namesResources === true && glyphs.inheritsPageResources) {
    problems.push({
      code: 'type3-resources-inherited',
      detail: 'the glyph procedures name resources and the font has no Resources, so the page resources are used',
    });
  }
  for (const warning of model.warnings) problems.push({ code: PROBLEM_OF_WARNING[warning.code], detail: warning.detail });
  return problems;
};

interface Built {
  readonly entry: FontEntry;
  readonly identity: string | undefined;
}

const sorted = (pages: ReadonlySet<number>): number[] => [...pages].toSorted((a, b) => a - b);

const buildEntry = (document: DocumentInternals, { model, pages, shownOn, pageResources }: Reached): Built => {
  const reader = new EntryReader(document);
  const holder = model.subtype === 'Type0' ? model.descendant?.dictionary : model.dictionary;
  const descriptorValue = holder?.get(FONT_DESCRIPTOR);
  const descriptor = dictionaryOf(reader.object(descriptorValue, 'the font descriptor'));
  const type3 = model.subtype === 'Type3';
  const fontName = reader.object(descriptor?.get(FONT_NAME), 'the FontName');
  const name = type3 && fontName?.kind === 'name' ? fontName.bytes : model.baseFont;
  const program: Program = type3 ? { embedding: { state: 'not-applicable' }, identity: undefined } : programOf(reader, model, descriptor);
  const { subset, malformed } = subsetOf(name, type3);
  const glyphs = model.type3 === undefined ? undefined : readType3Glyphs(document, model.type3, pageResources);
  const subtypeValue = reader.object(model.dictionary.get(SUBTYPE), 'the Subtype');
  const descendant = descendantOf(reader, model);
  const entry: FontEntry = {
    key: model.key,
    reference: model.reference,
    subtype: model.subtype,
    subtypeBytes: subtypeValue?.kind === 'name' ? subtypeValue.bytes : new Uint8Array(),
    name,
    descendant,
    descriptor: descriptorValue?.kind === 'reference' ? descriptorValue : undefined,
    embedding: program.embedding,
    subset,
    encoding: model.encoding,
    toUnicode: model.toUnicode,
    type3: glyphs === undefined ? undefined : { glyphs: glyphs.glyphs, procedures: glyphs.procedures, coloured: glyphs.coloured },
    pages: sorted(pages),
    shownOn: sorted(shownOn),
    problems: problemsOf({ model, descriptor, program, malformed, glyphs }, reader.problems),
  };
  return { entry, identity: program.identity };
};

// 9.6.4: "different subsets in the same PDF file shall have different tags".
const reusedTags = (built: readonly Built[]): FontEntry[] => {
  const programs = new Map<string, Set<string>>();
  for (const { entry, identity } of built) {
    if (entry.subset.state !== 'subset' || identity === undefined) continue;
    const known = programs.get(entry.subset.tag) ?? new Set<string>();
    known.add(identity);
    programs.set(entry.subset.tag, known);
  }
  return built.map(({ entry, identity }) => {
    const reused = entry.subset.state === 'subset' && identity !== undefined && (programs.get(entry.subset.tag)?.size ?? 0) > 1;
    if (!reused) return entry;
    return {
      ...entry,
      problems: [...entry.problems, { code: 'subset-tag-reused', detail: `other fonts with the tag ${entry.subset.tag} embed different programs` }],
    };
  });
};

const referenceOrder = (entry: FontEntry): readonly [number, number] => [
  entry.reference?.objectNumber ?? Number.POSITIVE_INFINITY,
  entry.reference?.generation ?? 0,
];

const firstPage = (entry: FontEntry): number => Math.min(entry.pages[0] ?? Number.POSITIVE_INFINITY, entry.shownOn[0] ?? Number.POSITIVE_INFINITY);

const order = (left: FontEntry, right: FontEntry): number => {
  const pages = firstPage(left) - firstPage(right);
  if (pages !== 0) return pages;
  const [leftNumber, leftGeneration] = referenceOrder(left);
  const [rightNumber, rightGeneration] = referenceOrder(right);
  if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
  if (leftGeneration !== rightGeneration) return leftGeneration - rightGeneration;
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
};

interface Listing {
  readonly document: DocumentInternals;
  readonly fonts: FontCache;
  readonly cache: InheritedCache;
  readonly found: Map<string, Reached>;
  /** Each page's resource dictionary, by page index. */
  readonly pageResources: (PdfDictionaryEntries | undefined)[];
  readonly problems: { page: number; reason: string }[];
}

// The interpretation warnings that leave pages whose text was not all seen.
const INCOMPLETE: ReadonlySet<InspectWarningCode> = new Set(['content-unreadable', 'content-cycle', 'bad-operands', 'resource-missing']);

const reach = (listing: Listing, index: number, model: FontModel): Reached => {
  let font = listing.found.get(model.key);
  if (font === undefined) {
    font = { model, pages: new Set(), shownOn: new Set(), pageResources: listing.pageResources[index] };
    listing.found.set(model.key, font);
  }
  return font;
};

const walkPage = (listing: Listing, index: number, page: PageEntry): void => {
  const { document, problems } = listing;
  let resources: Found | undefined = undefined;
  try {
    resources = inherited(document.objects, page, { key: RESOURCES, cache: listing.cache });
    listing.pageResources[index] = dictionaryOf(document.objects.deref(resources?.value));
  } catch (error: unknown) {
    if (!unreadable(error)) throw error;
    problems.push({ page: index, reason: `the Resources of the page cannot be read: ${error.message}` });
  }
  const unread = walkResources(document, page, {
    resources: resources?.value,
    owner: pageResourcesOwner(resources, page),
    font: visit => {
      const key = fontKey(visit.value, visit.owner, visit.name);
      try {
        reach(listing, index, listing.fonts.font(visit.value, key)).pages.add(index);
      } catch (error: unknown) {
        if (!unreadable(error)) throw error;
        problems.push({ page: index, reason: `font ${key} cannot be read: ${error.message}` });
      }
    },
  });
  for (const object of unread) problems.push({ page: index, reason: object.reason });
};

// Text of the page, of its printable annotations' appearances, and text a Type 3 glyph procedure shows, which paints the glyph.
const showPage = (listing: Listing, index: number): void => {
  const shown = (font: FontModel | undefined): void => {
    if (font !== undefined) reach(listing, index, font).shownOn.add(index);
  };
  const result = interpretPage(listing.document, index, {
    fonts: listing.fonts,
    inheritance: listing.cache,
    annotations: 'printable',
    text: event => {
      if (event.string.length > 0) shown(event.font);
    },
    paint: event => {
      if (event.kind === 'text' && event.context.sources.some(source => source.kind === 'type3-glyph')) shown(event.state.font);
    },
  });
  for (const warning of result.warnings) if (INCOMPLETE.has(warning.code)) listing.problems.push({ page: index, reason: warning.detail });
};

/**
 * Lists every font dictionary the document's pages reach through their resources, one entry per font dictionary object, with its type, embedding, subset tag, encoding, ToUnicode state, the pages that reach it and the pages that show text with it.
 * Damaged fonts and objects never throw: they become problems and unreadable entries. A value that loadDocument did not return throws InvalidArgumentError; decoded data past the document's limits and content past the interpreter's limits throw ResourceLimitError.
 */
export const listFonts = (document: LoadedDocument, options: ListFontsOptions = {}): FontInventory => {
  const parts = internals(document);
  const listing: Listing = {
    document: parts,
    fonts: new FontCache(parts, options.cmapProvider),
    cache: createInheritedCache(),
    found: new Map(),
    pageResources: [],
    problems: [],
  };
  for (const [index, page] of parts.pages.entries()) walkPage(listing, index, page);
  if (options.shownOn !== false) for (const index of parts.pages.keys()) showPage(listing, index);
  const built: Built[] = [];
  for (const font of listing.found.values()) {
    try {
      built.push(buildEntry(parts, font));
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      listing.problems.push({ page: Math.min(...font.pages, ...font.shownOn), reason: `font ${font.model.key} cannot be read: ${error.message}` });
    }
  }
  return { fonts: reusedTags(built).toSorted(order), unreadable: listing.problems };
};

import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { LoadedDocument } from '../../document/loadDocument.ts';
import type { Found } from '../../document/loadedPage.ts';
import type { CMapProvider } from '../../font/cmap/cmapProvider.ts';
import type { CidFontSubtype, FontEncodingSummary, FontModel, FontSubtype, FontWarningCode } from '../../font/fontModel.ts';
import type { PdfDictionaryEntries } from '../../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfReference } from '../../object/pdfObject.ts';

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
  /** 0-based indexes of the pages whose resources reach the font: through forms, patterns, Type 3 fonts, graphics states, soft masks and annotation appearances. */
  readonly pages: readonly number[];
  readonly problems: readonly FontProblem[];
}

export interface FontInventory {
  /** Ordered by the first page that reaches each font, then by object number, with direct fonts after indirect ones. */
  readonly fonts: readonly FontEntry[];
  /** Objects on the way to fonts that could not be read, by page. */
  readonly unreadable: readonly { readonly page: number; readonly reason: string }[];
}

export interface ListFontsOptions {
  /** Supplies predefined CMaps other than Identity-H and Identity-V, so that their availability is reported. */
  readonly cmapProvider?: CMapProvider;
}

interface Reached {
  readonly value: PdfDirectObject;
  readonly model: FontModel;
  readonly pages: Set<number>;
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

interface Program {
  readonly embedding: FontEmbedding;
  /** Tells programs apart for the subset tag rule: a digest of the stored program bytes. */
  readonly identity: string | undefined;
}

// Table 122: "At most, only one of the FontFile, FontFile2, and FontFile3 entries shall be present"; the first present is taken.
const programOf = (document: DocumentInternals, font: FontModel, descriptor: PdfDictionaryEntries | undefined): Program => {
  const standard14 = font.subtype === 'Type1' && font.baseFont !== undefined && STANDARD_14.has(latin1(font.baseFont));
  for (const file of FONT_FILES) {
    const stream = document.objects.deref(descriptor?.get(pdfName(file).bytes));
    if (stream?.kind !== 'stream') continue;
    const subtype = file === 'FontFile3' ? document.objects.deref(stream.dictionary.get(SUBTYPE)) : undefined;
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

const descendantOf = (document: DocumentInternals, font: FontModel): FontDescendant | undefined => {
  const { descendant } = font;
  if (descendant === undefined) return undefined;
  const info = dictionaryOf(document.objects.deref(descendant.dictionary.get(CID_SYSTEM_INFO)));
  const registry = document.objects.deref(info?.get(REGISTRY));
  const ordering = document.objects.deref(info?.get(ORDERING));
  return {
    subtype: descendant.subtype,
    reference: descendant.reference,
    registry: registry?.kind === 'string' ? registry.bytes : undefined,
    ordering: ordering?.kind === 'string' ? ordering.bytes : undefined,
    supplement: numberOf(document.objects.deref(info?.get(SUPPLEMENT))),
  };
};

interface Described {
  readonly model: FontModel;
  readonly descriptor: PdfDictionaryEntries | undefined;
  readonly program: Program;
  readonly malformed: boolean;
}

const problemsOf = ({ model, descriptor, program, malformed }: Described): FontProblem[] => {
  const problems: FontProblem[] = [];
  if (program.embedding.state === 'embedded' && !program.embedding.matchesFontType) {
    problems.push({ code: 'embedding-type-mismatch', detail: `${program.embedding.file} is not a program Table 126 allows for this font type` });
  }
  if (malformed) problems.push({ code: 'subset-tag-malformed', detail: 'the name has a plus sign after six characters that are not all uppercase letters' });
  // Table 111, FontDescriptor: "Required except for the standard 14 fonts"; Table 117 requires it of every CIDFont; Table 112 only in Tagged PDF.
  const standard14 = model.baseFont !== undefined && STANDARD_14.has(latin1(model.baseFont)) && model.subtype !== 'Type0';
  const required = model.subtype === 'Type0' ? model.descendant !== undefined : model.subtype !== 'Type3' && !standard14;
  if (descriptor === undefined && required) problems.push({ code: 'descriptor-missing', detail: 'the font has no font descriptor' });
  for (const warning of model.warnings) problems.push({ code: PROBLEM_OF_WARNING[warning.code], detail: warning.detail });
  return problems;
};

interface Built {
  readonly entry: FontEntry;
  readonly identity: string | undefined;
}

const buildEntry = (document: DocumentInternals, { value, model, pages }: Reached): Built => {
  const holder = model.subtype === 'Type0' ? model.descendant?.dictionary : model.dictionary;
  const descriptorValue = holder?.get(FONT_DESCRIPTOR);
  const descriptor = dictionaryOf(document.objects.deref(descriptorValue));
  const type3 = model.subtype === 'Type3';
  const fontName = document.objects.deref(descriptor?.get(FONT_NAME));
  const name = type3 && fontName?.kind === 'name' ? fontName.bytes : model.baseFont;
  const program: Program = type3 ? { embedding: { state: 'not-applicable' }, identity: undefined } : programOf(document, model, descriptor);
  const { subset, malformed } = subsetOf(name, type3);
  const subtypeValue = document.objects.deref(model.dictionary.get(SUBTYPE));
  const entry: FontEntry = {
    key: model.key,
    reference: value.kind === 'reference' ? value : undefined,
    subtype: model.subtype,
    subtypeBytes: subtypeValue?.kind === 'name' ? subtypeValue.bytes : new Uint8Array(),
    name,
    descendant: descendantOf(document, model),
    descriptor: descriptorValue?.kind === 'reference' ? descriptorValue : undefined,
    embedding: program.embedding,
    subset,
    encoding: model.encoding,
    toUnicode: model.toUnicode,
    pages: [...pages].toSorted((a, b) => a - b),
    problems: problemsOf({ model, descriptor, program, malformed }),
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

const order = (left: FontEntry, right: FontEntry): number => {
  const pages = (left.pages[0] ?? Number.POSITIVE_INFINITY) - (right.pages[0] ?? Number.POSITIVE_INFINITY);
  if (pages !== 0) return pages;
  const [leftNumber, leftGeneration] = referenceOrder(left);
  const [rightNumber, rightGeneration] = referenceOrder(right);
  if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
  if (leftGeneration !== rightGeneration) return leftGeneration - rightGeneration;
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
};

/**
 * Lists every font dictionary the document's pages reach through their resources, one entry per font dictionary object, with its type, embedding, subset tag, encoding, ToUnicode state and the pages that reach it.
 * Damaged fonts and objects never throw: they become problems and unreadable entries. A value that loadDocument did not return throws InvalidArgumentError; decoded data past the document's limits throws ResourceLimitError.
 */
export const listFonts = (document: LoadedDocument, options: ListFontsOptions = {}): FontInventory => {
  const parts = internals(document);
  const fonts = new FontCache(parts, options.cmapProvider);
  const cache = createInheritedCache();
  const found = new Map<string, Reached>();
  const problems: { page: number; reason: string }[] = [];
  for (const [index, page] of parts.pages.entries()) {
    let resources: Found | undefined = undefined;
    try {
      resources = inherited(parts.objects, page, { key: RESOURCES, cache });
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      problems.push({ page: index, reason: `the Resources of the page cannot be read: ${error.message}` });
    }
    const unread = walkResources(parts, page, {
      resources: resources?.value,
      owner: pageResourcesOwner(resources, page),
      font: visit => {
        const key = fontKey(visit.value, visit.owner, visit.name);
        let font = found.get(key);
        if (font === undefined) {
          try {
            font = { value: visit.value, model: fonts.font(visit.value, key), pages: new Set() };
          } catch (error: unknown) {
            if (!unreadable(error)) throw error;
            problems.push({ page: index, reason: `font ${key} cannot be read: ${error.message}` });
            return;
          }
          found.set(key, font);
        }
        font.pages.add(index);
      },
    });
    for (const object of unread) problems.push({ page: index, reason: object.reason });
  }
  const built: Built[] = [];
  for (const font of found.values()) {
    try {
      built.push(buildEntry(parts, font));
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      problems.push({ page: Math.min(...font.pages), reason: `font ${font.model.key} cannot be read: ${error.message}` });
    }
  }
  return { fonts: reusedTags(built).toSorted(order), unreadable: problems };
};

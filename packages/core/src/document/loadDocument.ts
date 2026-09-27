import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { SaveWarning } from '../save/saveWarning.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { ContentBuilder } from './contentBuilder.ts';
import type { ObjectChange } from './editedObjects.ts';
import type { GroupOptions, PdfGroup } from './group.ts';
import type { ImageOptions, PdfImage } from './image.ts';
import type { LoadedPage } from './loadedPage.ts';
import type { PageEntry } from './pageTree.ts';
import type { DocumentStructure, LoadSession, ReadStructure, SaveBase } from './readStructure.ts';
import type { ResourceNumbers } from './resourceRecord.ts';
import type { Separation, SeparationOptions } from './separation.ts';

import { GenerationMismatchError } from '../error/generationMismatchError.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { cloneDirect } from '../object/cloneObject.ts';
import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { fullRewrite } from '../save/fullRewrite.ts';
import { incrementalSave } from '../save/incrementalSave.ts';
import { locateHeader } from '../xref/locate.ts';

import { createDocumentHandles } from './documentHandles.ts';
import { registerInternals } from './documentInternals.ts';
import { EditedObjects } from './editedObjects.ts';
import { createInheritedCache, createLoadedPage, effectiveResources } from './loadedPage.ts';
import { LoadLog } from './loadLog.ts';
import { enumeratePages } from './pageTree.ts';
import { readFromChain, reconstruct, versionNumber } from './readStructure.ts';

export interface LoadOptions {
  /** Largest decoded size of one stream, in bytes; default 16 MiB. */
  maxDecodedBytes?: number;
  /** Deepest nesting of arrays and dictionaries; default 256. */
  maxNesting?: number;
  /** Most page tree levels from the root through a page; default 256. */
  maxPageTreeDepth?: number;
  /** Most members one object stream may declare; default 1,000,000. */
  maxObjectStreamMembers?: number;
  /** Approximate memory budget for parsed objects, in bytes; default 8 MiB. */
  parsedObjectCacheBytes?: number;
  /** A page tree whose Count disagrees with its leaves: throw ('error', the default) or use the leaves. */
  pageCountMismatch?: 'error' | 'use-leaves';
  /** A reference whose generation differs from its object's in-use entry: throw ('error', the default) or read it as null. */
  generationMismatch?: 'error' | 'null';
  /** A reconstruction that finds differing copies of one object: throw ('refuse-ambiguous', the default) or use the latest copy. */
  recovery?: 'refuse-ambiguous' | 'latest';
}

export interface SaveOptions {
  /** 'auto' (the default) appends an update to an intact file and rewrites any other; 'incremental' and 'full' choose one. */
  mode?: 'auto' | 'incremental' | 'full';
  /** 'derive' (the default) keeps the source identifier and derives a new second string; a pair is written as given. */
  fileIdentifier?: 'derive' | [Uint8Array, Uint8Array];
  /** Fraction digits for new reals; default 5. */
  fractionDigits?: number;
  /** Most entries a full rewrite's classic cross-reference table may hold for object numbers the file does not use; default 100,000. */
  maxTableGapEntries?: number;
  /** Most entries a full rewrite's cross-reference stream may hold for object numbers the file does not use; default 10,000,000. */
  maxGeneratedXrefEntries?: number;
}

export interface LoadedDocument {
  readonly structure: DocumentStructure;
  readonly warnings: readonly LoadWarning[];
  readonly pageCount: number;
  /** The page at a 0-based index; InvalidArgumentError when out of range. */
  page: (index: number) => LoadedPage;
  /** A fresh copy of the object on every call, changes included; null for free and absent objects. */
  get: (reference: PdfReference) => PdfObject;
  /** Replaces an object in use, keeping its number and generation; the value is copied, except a stream's data, which must not change afterwards. */
  set: (reference: PdfReference, value: PdfObject) => void;
  /** Deletes an object in use; saving marks its entry free. */
  delete: (reference: PdfReference) => void;
  /** Adds a new object, numbered above every number the file uses; the value is copied as by set. */
  object: (value: PdfObject) => PdfReference;
  /** A Separation colour space for content appended to this document's pages. */
  separation: (options: SeparationOptions) => Separation;
  /** An image for content appended to this document's pages; its objects are written when content first draws it. */
  image: (options: ImageOptions) => PdfImage;
  /** A transparency group for content appended to this document's pages. */
  group: (options: GroupOptions, render: (content: ContentBuilder) => void) => PdfGroup;
  /** Saves the document with its changes as chunks: views of the source and new buffers. */
  save: (options?: SaveOptions) => SavedPdf;
  /** A fresh copy of the document catalog. */
  catalog: () => PdfDictionaryEntries;
}

const ROOT = pdfName('Root').bytes;
const PAGES = pdfName('Pages').bytes;

const count = (value: number | undefined, fallback: number, name: string): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new InvalidArgumentError(`${name} must be a non-negative integer`);
  return result;
};

const sessionOptions = (options: LoadOptions): LoadSession['options'] => ({
  maxDecodedBytes: count(options.maxDecodedBytes, 16 * 1024 * 1024, 'maxDecodedBytes'),
  maxNesting: count(options.maxNesting, 256, 'maxNesting'),
  maxObjectStreamMembers: count(options.maxObjectStreamMembers, 1_000_000, 'maxObjectStreamMembers'),
  parsedObjectCacheBytes: count(options.parsedObjectCacheBytes, 8 * 1024 * 1024, 'parsedObjectCacheBytes'),
  generationMismatch: options.generationMismatch ?? 'error',
  recovery: options.recovery ?? 'refuse-ambiguous',
});

interface LoadedParts {
  readonly read: ReadStructure;
  readonly warnings: readonly LoadWarning[];
  readonly pages: readonly PageEntry[];
  readonly maxNesting: number;
  readonly maxDecodedBytes: number;
}

const VERSION = pdfName('Version').bytes;

class LoadedPdf implements LoadedDocument {
  private readonly read: DocumentStructure;
  private readonly log: readonly LoadWarning[];
  private readonly objects: EditedObjects;
  private readonly pages: readonly PageEntry[];
  private readonly handles = createDocumentHandles({ fractionDigits: DEFAULT_FRACTION_DIGITS, asciiOnlyColorants: false });
  private readonly placed: ResourceNumbers = { imageNumbers: new Map(), groupNumbers: new Map() };
  private readonly features = { transparency: false };
  private readonly base: SaveBase | undefined;
  private readonly maxNesting: number;

  constructor(parts: LoadedParts) {
    this.base = parts.read.base;
    this.maxNesting = parts.maxNesting;
    this.read = parts.read.structure;
    this.objects = new EditedObjects(parts.read.store);
    this.log = parts.warnings;
    this.pages = parts.pages;
    registerInternals(this, {
      objects: this.objects,
      pages: this.pages,
      structure: this.read,
      base: this.base,
      maxDecodedBytes: parts.maxDecodedBytes,
      maxNesting: parts.maxNesting,
    });
  }

  /** A copy of the structure, so that changing it cannot change what a save writes. */
  get structure(): DocumentStructure {
    const { read } = this;
    return {
      ...read,
      sections: read.sections.map(section => ({ ...section })),
      trailer: parsedDictionaryEntries([...read.trailer.entries()].map(([key, value]) => [key, cloneDirect(value)] as const)),
    };
  }

  /** The warnings so far; objects read after loading can add more. */
  get warnings(): readonly LoadWarning[] {
    return [...this.log];
  }

  separation(options: SeparationOptions): Separation {
    return this.handles.separation(options);
  }

  image(options: ImageOptions): PdfImage {
    return this.handles.image(options);
  }

  group(options: GroupOptions, render: (content: ContentBuilder) => void): PdfGroup {
    return this.handles.group(options, render);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  page(index: number): LoadedPage {
    const entry = this.pages[index];
    if (!Number.isSafeInteger(index) || entry === undefined) {
      throw new InvalidArgumentError(`page index ${String(index)} is outside 0 to ${String(this.pages.length - 1)}`);
    }
    return createLoadedPage(
      {
        objects: this.objects,
        pages: this.pages,
        handles: this.handles,
        placed: this.placed,
        fractionDigits: DEFAULT_FRACTION_DIGITS,
        features: this.features,
      },
      entry,
      index,
    );
  }

  get(reference: PdfReference): PdfObject {
    return this.objects.get(reference);
  }

  set(reference: PdfReference, value: PdfObject): void {
    this.objects.set(reference, value);
  }

  delete(reference: PdfReference): void {
    this.objects.delete(reference);
  }

  object(value: PdfObject): PdfReference {
    return this.objects.add(value);
  }

  // ISO 32000-1:2008, 7.5.2: the catalog Version, "if present, shall be used instead of the version specified in the Header"; a transparency group or soft mask needs PDF 1.4 (11.1).
  private versionChange(changes: Map<number, ObjectChange>, warnings: SaveWarning[]): void {
    const needsTransparency =
      this.features.transparency || this.placed.groupNumbers.size > 0 || [...this.placed.imageNumbers.values()].some(numbers => numbers.mask !== undefined);
    const root = this.read.trailer.get(ROOT);
    if (!needsTransparency || root?.kind !== 'reference') return;
    const catalog = this.get(root);
    if (catalog.kind !== 'dictionary') return;
    const declared = catalog.entries.get(VERSION);
    const effective = Math.max(versionNumber(this.read.headerVersion), declared?.kind === 'name' ? versionNumber(new TextDecoder().decode(declared.bytes)) : 0);
    if (effective >= 14) return;
    catalog.entries.set(VERSION, pdfName('1.4'));
    changes.set(root.objectNumber, { generation: root.generation, value: catalog });
    warnings.push({ code: 'version-raised', detail: 'the catalog Version is set to 1.4 for the transparency the new content uses' });
  }

  save(options: SaveOptions = {}): SavedPdf {
    let mode = options.mode ?? 'auto';
    if (mode === 'auto') mode = this.read.status === 'intact' ? 'incremental' : 'full';
    const changes = new Map(this.objects.changes);
    const warnings: SaveWarning[] = [];
    this.versionChange(changes, warnings);
    const input = {
      store: this.objects.store,
      changes,
      size: this.objects.size,
      structure: this.read,
      base: this.base,
      fractionDigits: options.fractionDigits ?? DEFAULT_FRACTION_DIGITS,
      maxNesting: this.maxNesting,
      maxTableGapEntries: count(options.maxTableGapEntries, 100_000, 'maxTableGapEntries'),
      maxGeneratedXrefEntries: count(options.maxGeneratedXrefEntries, 10_000_000, 'maxGeneratedXrefEntries'),
      fileIdentifier: options.fileIdentifier ?? 'derive',
      warnings,
    };
    return mode === 'full' ? fullRewrite(input) : incrementalSave(input);
  }

  catalog(): PdfDictionaryEntries {
    const root = this.read.trailer.get(ROOT);
    const catalog = root?.kind === 'reference' ? this.get(root) : undefined;
    if (catalog?.kind !== 'dictionary') throw new ParseError('the document catalog is not a dictionary', 0);
    return catalog.entries;
  }
}

/**
 * Reads a PDF from its bytes, held as one array or as the segments of an earlier save, without copying them.
 * Objects are parsed on demand. Damage that common readers tolerate is repaired with a warning; cross-reference data that does not describe the file is rebuilt by scanning it.
 * Encrypted documents throw EncryptedDocumentError.
 */
export const loadDocument = (input: Uint8Array | readonly Uint8Array[], options: LoadOptions = {}): LoadedDocument => {
  const session: LoadSession = { source: new ByteSource(input), log: new LoadLog(), options: sessionOptions(options), names: new Map() };
  const { log } = session;
  const header = locateHeader(session.source);
  if (header !== undefined && header.offset > 0) {
    log.warn({ code: 'junk-before-header', detail: `${String(header.offset)} bytes precede the header`, offset: 0 });
  }
  let read: ReadStructure | undefined = undefined;
  let reason = 'no header';
  if (header !== undefined) {
    try {
      read = readFromChain(session, header);
    } catch (error: unknown) {
      // Only damage leads to a reconstruction; encryption, resource limits, unsupported features and references readers disagree about propagate.
      if (!(error instanceof ParseError) || error instanceof GenerationMismatchError) throw error;
      reason = error.message;
    }
  }
  read ??= reconstruct(session, reason, header ?? { offset: 0, version: '' });
  const { store } = read;
  const warn = (warning: LoadWarning): void => {
    log.warn(warning);
  };
  const root = read.structure.trailer.get(ROOT);
  const catalog = root?.kind === 'reference' ? store.resolve(root.objectNumber, root.generation) : undefined;
  if (catalog?.kind !== 'dictionary') throw new ParseError('the document catalog is not a dictionary', 0);
  const pages = enumeratePages(store, catalog.entries.get(PAGES), {
    pageCountMismatch: options.pageCountMismatch ?? 'error',
    maxPageTreeDepth: count(options.maxPageTreeDepth, 256, 'maxPageTreeDepth'),
    warn,
  });
  // Pages share their ancestors' values, so each page tree node is read once however deep the tree is.
  const inheritance = createInheritedCache();
  for (const entry of pages) {
    // ISO 32000-1:2008, Table 30, Resources: "(Required; inheritable)"; many writers omit it for pages that need no resources, which reads as an empty dictionary.
    if (effectiveResources(store, entry, inheritance) === undefined) {
      warn({
        code: 'resources-missing',
        detail: `page ${String(entry.reference.objectNumber)} has no Resources, on itself or on an ancestor`,
        objectNumber: entry.reference.objectNumber,
      });
    }
  }
  let { status } = read.structure;
  if (status === 'intact' && log.tolerated) status = 'tolerated';
  return new LoadedPdf({
    read: { ...read, structure: { ...read.structure, status } },
    warnings: log.warnings,
    pages,
    maxNesting: session.options.maxNesting,
    maxDecodedBytes: session.options.maxDecodedBytes,
  });
};

import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { ObjectStore } from './objectStore.ts';
import type { DocumentStructure, LoadSession, ReadStructure } from './readStructure.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { locateHeader } from '../xref/locate.ts';
import { COMPRESSED, IN_FILE } from '../xref/objectIndex.ts';

import { LoadLog } from './loadLog.ts';
import { readFromChain, reconstruct } from './readStructure.ts';

export interface LoadOptions {
  /** Largest decoded size of one stream, in bytes; default 16 MiB. */
  maxDecodedBytes?: number;
  /** Deepest nesting of arrays and dictionaries; default 256. */
  maxNesting?: number;
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

export interface LoadedDocument {
  readonly structure: DocumentStructure;
  readonly warnings: readonly LoadWarning[];
  /** A fresh parse of the object on every call; null for free and absent objects. */
  get: (reference: PdfReference) => PdfObject;
  /** A fresh copy of the document catalog. */
  catalog: () => PdfDictionaryEntries;
}

const ROOT = pdfName('Root').bytes;

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

class LoadedPdf implements LoadedDocument {
  readonly structure: DocumentStructure;
  readonly warnings: readonly LoadWarning[];
  private readonly store: ObjectStore;

  constructor(read: ReadStructure, warnings: readonly LoadWarning[]) {
    this.structure = read.structure;
    this.store = read.store;
    this.warnings = warnings;
  }

  get(reference: PdfReference): PdfObject {
    // Resolving first applies the generation rules; the value returned is a fresh parse the caller may change freely.
    const resolved = this.store.resolve(reference.objectNumber, reference.generation);
    const entry = this.store.index.get(reference.objectNumber);
    if (resolved.kind === 'null' || (entry.type !== IN_FILE && entry.type !== COMPRESSED)) return { kind: 'null' };
    return this.store.parse(reference.objectNumber)?.value ?? { kind: 'null' };
  }

  catalog(): PdfDictionaryEntries {
    const root = this.structure.trailer.get(ROOT);
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
      // Only damage leads to a reconstruction; encryption, resource limits and unsupported features propagate.
      if (!(error instanceof ParseError)) throw error;
      reason = error.message;
    }
  }
  read ??= reconstruct(session, reason, header ?? { offset: 0, version: '' });
  let { status } = read.structure;
  if (status === 'intact' && log.tolerated) status = 'tolerated';
  return new LoadedPdf({ store: read.store, structure: { ...read.structure, status } }, log.warnings);
};

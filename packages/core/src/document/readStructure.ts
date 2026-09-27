import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { ByteSource } from '../parse/byteSource.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { HeaderLocation } from '../xref/locate.ts';
import type { SectionChain } from '../xref/sectionChain.ts';
import type { LoadLog } from './loadLog.ts';
import type { StoreContext } from './objectStore.ts';

import { GenerationMismatchError } from '../error/generationMismatchError.ts';
import { ParseError } from '../error/parseError.ts';
import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName } from '../object/pdfObject.ts';
import { refuseEncryption } from '../xref/encryption.ts';
import { locateStartxref } from '../xref/locate.ts';
import { COMPRESSED, IN_FILE, ObjectIndex, validateHeaders } from '../xref/objectIndex.ts';
import { reconstructIndex } from '../xref/recover.ts';
import { readSectionChain, searchOrder } from '../xref/sectionChain.ts';

import { ObjectStore } from './objectStore.ts';

/**
 * How the file's structure was read. `intact`: as written, or with deviations no common reader reports.
 * `tolerated`: with deviations at least one common reader reports. `reconstructed`: the cross-reference data was rebuilt by scanning the file.
 */
export type StructureStatus = 'intact' | 'tolerated' | 'reconstructed';

export interface DocumentStructure {
  readonly status: StructureStatus;
  readonly headerOffset: number;
  readonly headerVersion: string;
  /** Cross-reference sections, newest first; empty when reconstructed. */
  readonly sections: readonly { readonly kind: 'classic' | 'stream'; readonly offset: number; readonly hybridStream?: number }[];
  /** Format of the section startxref names; undefined when reconstructed. */
  readonly lastSectionKind: 'classic' | 'stream' | undefined;
  readonly linearized: boolean;
  /** The effective trailer: the newest section's, or the one a reconstruction chose. */
  readonly trailer: PdfDictionaryEntries;
}

export interface LoadSession {
  readonly source: ByteSource;
  readonly log: LoadLog;
  readonly options: Omit<StoreContext, 'warn' | 'names'> & { readonly recovery: 'refuse-ambiguous' | 'latest' };
  readonly names: Map<string, Uint8Array>;
}

/** Where the newest cross-reference section's trailer is, for copying it into an update; absent when reconstructed. */
export interface SaveBase {
  readonly trailerStart: number;
  readonly trailerEnd: number;
  /** Offset the section chain's offsets are relative to: the header position when they were read relative to it, else 0. */
  readonly shift: number;
  /** Object numbers of the cross-reference streams the chain was read from; a rewrite never writes them. */
  readonly xrefStreams: ReadonlySet<number>;
}

export interface ReadStructure {
  readonly store: ObjectStore;
  readonly structure: DocumentStructure;
  readonly base?: SaveBase;
}

const ROOT = pdfName('Root').bytes;
const SIZE = pdfName('Size').bytes;
const PAGES = pdfName('Pages').bytes;
const LINEARIZED = pdfName('Linearized').bytes;

const contextOf = (session: LoadSession, warn: (warning: LoadWarning) => void): StoreContext => ({ ...session.options, warn, names: session.names });

const logged = (session: LoadSession): StoreContext =>
  contextOf(session, warning => {
    session.log.warn(warning);
  });

const checkEntryLengths = (chain: SectionChain, log: Pick<LoadLog, 'note' | 'warn'>): void => {
  for (const { section } of chain.sections) {
    if (section.kind !== 'classic') continue;
    const irregular = section.entryLengths.filter(length => length !== 20 && length !== 19);
    // 19-byte entries (a lone LF) are read silently by every common reader; other lengths are reported by some.
    if (irregular.length > 0) {
      log.warn({ code: 'xref-entry-length', detail: `cross-reference entries of ${irregular.join(', ')} bytes instead of 20`, offset: section.offset });
    } else if (section.entryLengths.includes(19)) {
      log.note({ code: 'xref-entry-length', detail: 'cross-reference entries of 19 bytes instead of 20', offset: section.offset });
    }
  }
};

const firstObjectIsLinearization = (store: ObjectStore): boolean => {
  let first: number | undefined = undefined;
  let offset = Number.POSITIVE_INFINITY;
  for (const number of store.index.inUse()) {
    const entry = store.index.get(number);
    if (entry.type === IN_FILE && entry.location < offset) {
      offset = entry.location;
      first = number;
    }
  }
  // Annex F: the linearization parameter dictionary is the first indirect object in the file.
  const value = first === undefined ? undefined : store.load(first)?.value;
  return value?.kind === 'dictionary' && value.entries.has(LINEARIZED);
};

const linearized = (store: ObjectStore): boolean => {
  try {
    return firstObjectIsLinearization(store);
  } catch (error: unknown) {
    // The probe reads one object nothing may refer to; a damaged one there is not the linearization dictionary, and it is reported if something reads it.
    if (error instanceof ParseError && !(error instanceof GenerationMismatchError)) return false;
    throw error;
  }
};

const hasCatalog = (store: ObjectStore, trailer: PdfDictionaryEntries): boolean => {
  const root = trailer.get(ROOT);
  if (root?.kind !== 'reference') return false;
  try {
    const catalog = store.resolve(root.objectNumber, root.generation);
    return catalog.kind === 'dictionary' && catalog.entries.has(PAGES);
  } catch (error: unknown) {
    if (error instanceof ParseError && !(error instanceof GenerationMismatchError)) return false;
    throw error;
  }
};

interface ShiftAttempt {
  readonly header: HeaderLocation;
  readonly startxref: number;
  readonly shift: number;
}

// One reading of the section chain, with every offset the file gives moved by `shift`; a ParseError means this reading does not describe the file.
const readWithShift = (session: LoadSession, attempt: ShiftAttempt, warn: (warning: LoadWarning) => void): ReadStructure => {
  const { header, shift } = attempt;
  const chain = readSectionChain(session.source, { startxref: attempt.startxref, shift }, contextOf(session, warn));
  const sections = searchOrder(chain);
  refuseEncryption(sections.map(section => section.trailer));
  checkEntryLengths(chain, {
    warn,
    note: warning => {
      session.log.note(warning);
    },
  });
  const index = ObjectIndex.fromSections(sections, shift);
  for (const number of index.inUse()) {
    const entry = index.get(number);
    if (entry.type === COMPRESSED && index.get(entry.location).type !== IN_FILE) {
      throw new ParseError(`object ${String(number)} names object stream ${String(entry.location)}, which is not in the file`, 0);
    }
  }
  const xrefStreams = new Set(
    sections.flatMap(section =>
      section.kind === 'stream' && 'objectNumber' in section && typeof section.objectNumber === 'number' ? [section.objectNumber] : [],
    ),
  );
  const mismatch = validateHeaders(session.source, index, {
    skip: xrefStreams,
    offsetZero: objectNumber => {
      warn({ code: 'xref-entry-offset-zero', detail: `the in-use entry of object ${String(objectNumber)} has offset 0 and is read as free`, objectNumber });
    },
  });
  if (mismatch !== undefined) throw new ParseError(`object ${String(mismatch.objectNumber)} is not at its cross-reference offset`, mismatch.offset);
  const [newest] = chain.sections;
  const trailer = newest?.section.trailer;
  const store = new ObjectStore(session.source, index, contextOf(session, warn));
  if (trailer === undefined || !hasCatalog(store, trailer)) throw new ParseError('the trailer has no Root that resolves to a document catalog', 0);
  const size = trailer.get(SIZE);
  // ISO 32000-1:2008, Table 15, Size: objects numbered beyond it "shall be ignored"; every common reader keeps them, and so does pdfwright.
  if (size?.kind === 'integer' && index.size > size.value) {
    warn({ code: 'trailer-size-too-small', detail: `trailer Size ${String(size.value)} is not above the highest object number ${String(index.size - 1)}` });
  }
  const structure: DocumentStructure = {
    status: 'intact',
    headerOffset: header.offset,
    headerVersion: header.version,
    sections: chain.sections.map(({ section, hybrid }) =>
      hybrid === undefined ? { kind: section.kind, offset: section.offset } : { kind: section.kind, offset: section.offset, hybridStream: hybrid.offset },
    ),
    lastSectionKind: newest?.section.kind,
    linearized: linearized(store),
    trailer,
  };
  const base = newest === undefined ? undefined : { trailerStart: newest.section.trailerStart, trailerEnd: newest.section.trailerEnd, shift, xrefStreams };
  return base === undefined ? { store, structure } : { store, structure, base };
};

/**
 * Reads the cross-reference sections as written; a ParseError from here means they must be reconstructed.
 * Offsets in a file with bytes before its header are read relative to the header first, then as absolute offsets, and each reading must describe the whole file.
 */
export const readFromChain = (session: LoadSession, header: HeaderLocation): ReadStructure => {
  const startxref = locateStartxref(session.source);
  if (startxref === undefined) throw new ParseError('no startxref', session.source.length);
  const shifts = header.offset > 0 ? [header.offset, 0] : [0];
  for (const [position, shift] of shifts.entries()) {
    try {
      return session.log.attempt(warn => readWithShift(session, { header, startxref: startxref.offset, shift }, warn));
    } catch (error: unknown) {
      if (!(error instanceof ParseError) || error instanceof GenerationMismatchError || position === shifts.length - 1) throw error;
    }
  }
  throw new ParseError('unreadable cross-reference data', startxref.keyword);
};

/** Rebuilds the cross-reference data by scanning the file; ISO 32000-1:2008, Annex C.2 says a reader "may attempt to rebuild the table by scanning all the objects in the file" without defining how, and this follows what common readers do. */
export const reconstruct = (session: LoadSession, reason: string, header: HeaderLocation): ReadStructure => {
  const context = logged(session);
  const reconstruction = reconstructIndex(session.source, context);
  // Encryption is checked on every trailer the scan found before any of them is used.
  refuseEncryption(reconstruction.trailers);
  if (reconstruction.objects === 0) throw new ParseError('not a PDF file: no objects found', 0);
  if (reconstruction.ambiguous.length > 0) {
    const list = reconstruction.ambiguous.join(', ');
    if (session.options.recovery === 'refuse-ambiguous') {
      throw new ParseError(
        `the reconstructed file holds differing or unreadable copies of objects ${list}, and readers disagree about which to use; pass recovery: 'latest' to use the latest readable copies`,
        0,
      );
    }
    for (const objectNumber of reconstruction.ambiguous) {
      session.log.warn({
        code: 'recovery-ambiguous-object',
        detail: `object ${String(objectNumber)} has differing or unreadable copies; the latest readable one is used`,
        objectNumber,
      });
    }
  }
  for (const objectNumber of reconstruction.unreadable) {
    session.log.warn({
      code: 'recovery-unreadable-object',
      detail: `object ${String(objectNumber)} was found but does not parse, so references to it read as null`,
      objectNumber,
    });
  }
  const store = new ObjectStore(session.source, reconstruction.index, context);
  let trailer = reconstruction.trailers.findLast(candidate => hasCatalog(store, candidate));
  if (trailer === undefined) {
    const catalog = reconstruction.catalogs.at(-1);
    if (catalog === undefined) throw new ParseError('no document catalog found', 0);
    trailer = parsedDictionaryEntries([[ROOT, { kind: 'reference', objectNumber: catalog, generation: store.index.get(catalog).generation }]]);
  }
  session.log.warn({
    code: 'xref-reconstructed',
    detail: `cross-reference data reconstructed (${reason}): ${String(reconstruction.objects)} objects, ${String(reconstruction.objectStreams)} object streams`,
  });
  const structure: DocumentStructure = {
    status: 'reconstructed',
    headerOffset: header.offset,
    headerVersion: header.version,
    sections: [],
    lastSectionKind: undefined,
    linearized: linearized(store),
    trailer,
  };
  return { store, structure };
};

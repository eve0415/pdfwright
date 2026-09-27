import type { ObjectChange } from '../document/editedObjects.ts';
import type { ObjectStore } from '../document/objectStore.ts';
import type { DocumentStructure, SaveBase } from '../document/readStructure.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { OriginalValue } from './originalValue.ts';
import type { SaveWarning } from './saveWarning.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { createMd5 } from '../hash/md5.ts';
import { pdfArray, pdfInteger, pdfString } from '../object/pdfObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseAnnotated } from '../parse/parseObject.ts';
import { savedPdf } from '../write/savedPdf.ts';
import { FREE } from '../xref/objectIndex.ts';

import { PdfEmitter } from './emitter.ts';
import { mergeSerialize } from './mergeSerialize.ts';
import { originalValue } from './originalValue.ts';
import { TRAILER_KEYS, copiedTrailerEntries } from './trailerCopy.ts';

export interface SaveInput {
  readonly store: ObjectStore;
  readonly changes: ReadonlyMap<number, ObjectChange>;
  /** One above the highest object number in use or assigned. */
  readonly size: number;
  readonly structure: DocumentStructure;
  readonly base: SaveBase | undefined;
  readonly fractionDigits: number;
  readonly maxNesting: number;
  readonly fileIdentifier: 'derive' | readonly [Uint8Array, Uint8Array];
  /** Warnings found before serialization, such as a raised version. */
  readonly warnings: readonly SaveWarning[];
}

interface Entry {
  readonly objectNumber: number;
  readonly use: 'n' | 'f';
  /** Offset for an in-use entry, next free object number for a free one. */
  readonly field: number;
  readonly generation: number;
}

const quiet = {
  warn: (): void => {
    // The trailer was parsed, with warnings, when the document was loaded.
  },
  names: new Map<string, Uint8Array>(),
};

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

// ISO 32000-1:2008, 7.5.4: "nnnnnnnnnn ggggg n eol", each entry exactly 20 bytes; the end-of-line here is SP LF.
const writeTable = (writer: ByteWriter, entries: readonly Entry[]): void => {
  writer.writeAscii('xref\n');
  for (let index = 0; index < entries.length;) {
    let end = index;
    while (end + 1 < entries.length && entries[end + 1]?.objectNumber === (entries[end]?.objectNumber ?? 0) + 1) end++;
    writer.writeAscii(`${String(entries[index]?.objectNumber ?? 0)} ${String(end - index + 1)}\n`);
    for (let run = index; run <= end; run++) {
      const entry = entries[run];
      if (entry !== undefined) writer.writeAscii(`${pad(entry.field, 10)} ${pad(entry.generation, 5)} ${entry.use} \n`);
    }
    index = end + 1;
  }
};

// ISO 32000-1:2008, 7.5.4: a deleted object's entry is added to the linked list of free entries, and "The entry's generation number shall be incremented by 1"; at 65,535 "it shall never be reused".
const freeEntries = (store: ObjectStore, freed: readonly { objectNumber: number; generation: number }[]): Entry[] => {
  if (freed.length === 0) return [];
  const head = store.index.get(0);
  const previousHead = head.type === FREE ? head.location : 0;
  const entries: Entry[] = [{ objectNumber: 0, use: 'f', field: freed[0]?.objectNumber ?? 0, generation: 65_535 }];
  for (const [index, object] of freed.entries()) {
    entries.push({
      objectNumber: object.objectNumber,
      use: 'f',
      field: freed[index + 1]?.objectNumber ?? previousHead,
      generation: Math.min(object.generation + 1, 65_535),
    });
  }
  return entries;
};

const baseTrailerNode = (input: SaveInput): OriginalValue | undefined => {
  if (input.base === undefined) return undefined;
  const { bytes } = input.store.source.copy(input.base.trailerStart, input.base.trailerEnd);
  return { node: parseAnnotated(new Lexer({ bytes, base: 0, final: true }, 0, quiet), input.maxNesting), bytes };
};

const identifiers = (trailer: PdfDictionaryEntries): readonly [Uint8Array, Uint8Array] | undefined => {
  const id = trailer.get(TRAILER_KEYS.id);
  if (id?.kind !== 'array') return undefined;
  const [first, second] = id.items;
  return first?.kind === 'string' && second?.kind === 'string' ? [first.bytes, second.bytes] : undefined;
};

const idArray = ([first, second]: readonly [Uint8Array, Uint8Array]): PdfDirectObject => pdfArray([pdfString(first, 'hex'), pdfString(second, 'hex')]);

interface Written {
  readonly entries: Entry[];
  readonly freed: { objectNumber: number; generation: number }[];
}

// Writes each changed and new object once, in ascending number, against its parsed original.
const writeObjects = (emitter: PdfEmitter, input: SaveInput, warn: (warning: SaveWarning) => void): Written => {
  const shift = input.base?.shift ?? 0;
  const written: Written = { entries: [], freed: [] };
  for (const objectNumber of [...input.changes.keys()].toSorted((left, right) => left - right)) {
    const change = input.changes.get(objectNumber);
    if (change === undefined) continue;
    if ('deleted' in change) {
      written.freed.push({ objectNumber, generation: change.generation });
      continue;
    }
    written.entries.push({ objectNumber, use: 'n', field: emitter.offset - shift, generation: change.generation });
    const { writer } = emitter;
    writer.writeAscii(`${String(objectNumber)} ${String(change.generation)} obj\n`);
    const original = originalValue(input.store, objectNumber, input.maxNesting);
    mergeSerialize(writer, change.value, { original: original?.node, bytes: original?.bytes ?? new Uint8Array(), fractionDigits: input.fractionDigits, warn });
    writer.writeAscii('\nendobj\n');
  }
  return written;
};

interface TrailerRequest {
  readonly appendStart: number;
  readonly previousSection: number;
  readonly warn: (warning: SaveWarning) => void;
}

// ISO 32000-1:2008, 7.5.6: "The added trailer shall contain all the entries except the Prev entry (if present) from the previous trailer, whether modified or not. In addition, the added trailer dictionary shall contain a Prev entry".
const writeTrailer = (emitter: PdfEmitter, input: SaveInput, request: TrailerRequest): void => {
  const { structure } = input;
  const shift = input.base?.shift ?? 0;
  const trailer = copiedTrailerEntries(structure.trailer, 'classic');
  const previousSize = structure.trailer.get(TRAILER_KEYS.size);
  trailer.set(TRAILER_KEYS.size, pdfInteger(Math.max(previousSize?.kind === 'integer' ? previousSize.value : 0, input.size)));
  trailer.set(TRAILER_KEYS.prev, pdfInteger(request.previousSection - shift));
  trailer.delete(TRAILER_KEYS.id);
  const original = baseTrailerNode(input);
  const context = { original: original?.node, bytes: original?.bytes ?? new Uint8Array(), fractionDigits: input.fractionDigits, warn: request.warn };
  const previous = identifiers(structure.trailer);
  let pair = input.fileIdentifier === 'derive' ? undefined : input.fileIdentifier;
  if (pair === undefined && previous !== undefined) {
    // ISO 32000-1:2008, 14.4: the first identifier "shall not change when the file is incrementally updated"; the second is "a changing identifier based on the file's contents at the time it was last updated".
    const withoutId = new ByteWriter();
    mergeSerialize(withoutId, { kind: 'dictionary', entries: trailer }, context);
    const appended = emitter.writer.toUint8Array().subarray(request.appendStart - (emitter.offset - emitter.writer.length));
    pair = [previous[0], createMd5().update(previous[0]).update(previous[1]).update(appended).update(withoutId.toUint8Array()).digest()];
  }
  if (pair !== undefined) trailer.set(TRAILER_KEYS.id, idArray(pair));
  emitter.writer.writeAscii('trailer\n');
  mergeSerialize(emitter.writer, { kind: 'dictionary', entries: trailer }, context);
};

/**
 * Appends the changes to the source as an incremental update: the source bytes stay as they are, and a classic cross-reference section and trailer follow the changed objects.
 * ISO 32000-1:2008, 7.5.6: "changes shall be appended to the end of the file, leaving its original contents intact."
 */
export const classicIncrementalSave = (input: SaveInput): SavedPdf => {
  const { store, structure } = input;
  const [newest] = structure.sections;
  if (newest === undefined || structure.status === 'reconstructed') {
    throw new InvalidArgumentError(
      'the cross-reference data of this file was reconstructed; an incremental update would inherit sections that readers disagree about',
    );
  }
  const warnings: SaveWarning[] = [...input.warnings];
  const warn = (warning: SaveWarning): void => {
    warnings.push(warning);
  };
  if (input.changes.size === 0) return savedPdf(store.source.segments, { mode: 'incremental', warnings });
  // Annex F, Table F.1, L: "A mismatch indicates that the file is not linearized and shall be treated as ordinary PDF, ignoring linearization information."
  if (structure.linearized) {
    warn({ code: 'linearization-invalidated', detail: 'the update makes the file an ordinary PDF; its linearization data no longer applies' });
  }
  const emitter = new PdfEmitter();
  for (const segment of store.source.segments) emitter.view(segment);
  const last = store.source.byteAt(store.source.length - 1);
  if (last !== 0x0a && last !== 0x0d) emitter.writer.writeByte(0x0a);
  const appendStart = emitter.offset;
  const { entries, freed } = writeObjects(emitter, input, warn);
  const xrefOffset = emitter.offset;
  writeTable(
    emitter.writer,
    [...entries, ...freeEntries(store, freed)].toSorted((left, right) => left.objectNumber - right.objectNumber),
  );
  writeTrailer(emitter, input, { appendStart, previousSection: newest.offset, warn });
  // 7.5.5: the file ends with startxref, the offset of the last cross-reference section, and %%EOF.
  emitter.writer.writeAscii(`\nstartxref\n${String(xrefOffset - (input.base?.shift ?? 0))}\n%%EOF\n`);
  return savedPdf(emitter.finish(), { mode: 'incremental', warnings });
};

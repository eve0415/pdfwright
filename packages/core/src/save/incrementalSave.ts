import type { ObjectChange } from '../document/editedObjects.ts';
import type { ObjectStore } from '../document/objectStore.ts';
import type { DocumentStructure, SaveBase } from '../document/readStructure.ts';
import type { LexContext } from '../parse/lexer.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { OriginalValue } from './originalValue.ts';
import type { SaveWarning } from './saveWarning.ts';
import type { Entry } from './xrefWriter.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { createMd5 } from '../hash/md5.ts';
import { PdfDictionaryEntries, pdfArray, pdfInteger, pdfName } from '../object/pdfObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseAnnotated } from '../parse/parseObject.ts';
import { savedPdf } from '../write/savedPdf.ts';
import { FREE } from '../xref/objectIndex.ts';

import { PdfEmitter } from './emitter.ts';
import { mergeSerialize } from './mergeSerialize.ts';
import { originalValue } from './originalValue.ts';
import { TRAILER_KEYS, copiedTrailerEntries } from './trailerCopy.ts';
import { fieldWidths, idArray, indexRuns, streamData, writeTable } from './xrefWriter.ts';

export interface SaveInput {
  readonly store: ObjectStore;
  readonly changes: ReadonlyMap<number, ObjectChange>;
  /** One above the highest object number in use or assigned. */
  readonly size: number;
  readonly structure: DocumentStructure;
  readonly base: SaveBase | undefined;
  readonly fractionDigits: number;
  readonly maxNesting: number;
  /** Most entries a classic table covering every object number may hold for numbers without an object. */
  readonly maxTableGapEntries: number;
  /** Most entries a cross-reference stream covering every object number may hold for numbers without an object. */
  readonly maxGeneratedXrefEntries: number;
  readonly fileIdentifier: 'derive' | readonly [Uint8Array, Uint8Array];
  /** Warnings found before serialization, such as a raised version. */
  readonly warnings: readonly SaveWarning[];
}

const quiet = (): LexContext => ({
  warn: (): void => {
    // The trailer was parsed, with warnings, when the document was loaded.
  },
  names: new Map<string, Uint8Array>(),
});

// ISO 32000-1:2008, 7.5.4: a deleted object's entry is added to the linked list of free entries, and "The entry's generation number shall be incremented by 1"; at 65,535 "it shall never be reused".
const freeEntries = (store: ObjectStore, freed: readonly { objectNumber: number; generation: number }[]): Entry[] => {
  if (freed.length === 0) return [];
  const head = store.index.get(0);
  const previousHead = head.type === FREE ? head.location : 0;
  const entries: Entry[] = [{ objectNumber: 0, type: 0, field: freed[0]?.objectNumber ?? 0, generation: 65_535 }];
  for (const [index, object] of freed.entries()) {
    entries.push({
      objectNumber: object.objectNumber,
      type: 0,
      field: freed[index + 1]?.objectNumber ?? previousHead,
      generation: Math.min(object.generation + 1, 65_535),
    });
  }
  return entries;
};

const baseTrailerNode = (input: SaveInput): OriginalValue | undefined => {
  if (input.base === undefined) return undefined;
  const { bytes } = input.store.source.copy(input.base.trailerStart, input.base.trailerEnd);
  return { node: parseAnnotated(new Lexer({ bytes, base: 0, final: true }, 0, quiet()), input.maxNesting), bytes };
};

const identifiers = (trailer: PdfDictionaryEntries): readonly [Uint8Array, Uint8Array] | undefined => {
  const id = trailer.get(TRAILER_KEYS.id);
  if (id?.kind !== 'array') return undefined;
  const [first, second] = id.items;
  return first?.kind === 'string' && second?.kind === 'string' ? [first.bytes, second.bytes] : undefined;
};

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
    written.entries.push({ objectNumber, type: 1, field: emitter.offset - shift, generation: change.generation });
    const { writer } = emitter;
    writer.writeAscii(`${String(objectNumber)} ${String(change.generation)} obj\n`);
    const original = originalValue(input.store, objectNumber, input.maxNesting);
    mergeSerialize(writer, change.value, { original: original?.node, bytes: original?.bytes ?? new Uint8Array(), fractionDigits: input.fractionDigits, warn });
    writer.writeAscii('\nendobj\n');
  }
  return written;
};

interface SectionRequest {
  readonly appendStart: number;
  readonly previousSection: number;
  readonly entries: readonly Entry[];
  readonly warn: (warning: SaveWarning) => void;
}

// ISO 32000-1:2008, 7.5.6: "The added trailer shall contain all the entries except the Prev entry (if present) from the previous trailer, whether modified or not. In addition, the added trailer dictionary shall contain a Prev entry".
const trailerEntries = (input: SaveInput, request: SectionRequest, size: number): PdfDictionaryEntries => {
  const { structure } = input;
  const trailer = copiedTrailerEntries(structure.trailer, structure.lastSectionKind ?? 'classic');
  const previousSize = structure.trailer.get(TRAILER_KEYS.size);
  trailer.set(TRAILER_KEYS.size, pdfInteger(Math.max(previousSize?.kind === 'integer' ? previousSize.value : 0, size)));
  trailer.set(TRAILER_KEYS.prev, pdfInteger(request.previousSection - (input.base?.shift ?? 0)));
  trailer.delete(TRAILER_KEYS.id);
  return trailer;
};

interface Identified {
  readonly emitter: PdfEmitter;
  readonly appendStart: number;
  /** Serializes the trailer or stream dictionary as it will be written, without ID. */
  readonly withoutId: () => Uint8Array;
}

// ISO 32000-1:2008, 14.4: the first identifier "shall not change when the file is incrementally updated"; the second is "a changing identifier based on the file's contents at the time it was last updated". A source without ID gets none unless the caller supplies one.
const fileIdentifier = (input: SaveInput, request: Identified): readonly [Uint8Array, Uint8Array] | undefined => {
  if (input.fileIdentifier !== 'derive') return input.fileIdentifier;
  const previous = identifiers(input.structure.trailer);
  if (previous === undefined) return undefined;
  const { emitter } = request;
  const appended = emitter.writer.toUint8Array().subarray(request.appendStart - (emitter.offset - emitter.writer.length));
  return [previous[0], createMd5().update(previous[0]).update(previous[1]).update(appended).update(request.withoutId()).digest()];
};

const writeClassicSection = (emitter: PdfEmitter, input: SaveInput, request: SectionRequest): number => {
  const { offset } = emitter;
  writeTable(emitter.writer, request.entries);
  const trailer = trailerEntries(input, request, input.size);
  const original = baseTrailerNode(input);
  const context = { original: original?.node, bytes: original?.bytes ?? new Uint8Array(), fractionDigits: input.fractionDigits, warn: request.warn };
  const pair = fileIdentifier(input, {
    emitter,
    appendStart: request.appendStart,
    withoutId: () => {
      const writer = new ByteWriter();
      mergeSerialize(writer, { kind: 'dictionary', entries: trailer }, context);
      return writer.toUint8Array();
    },
  });
  if (pair !== undefined) trailer.set(TRAILER_KEYS.id, idArray(pair));
  emitter.writer.writeAscii('trailer\n');
  mergeSerialize(emitter.writer, { kind: 'dictionary', entries: trailer }, context);
  return offset;
};

// ISO 32000-1:2008, 7.5.8: the update's cross-reference information is a new cross-reference stream; 7.5.8.3: "an entry for it shall exist in either a cross-reference stream (usually itself) or in a cross-reference table". It is written unfiltered, with the smallest field widths that hold its values.
const writeStreamSection = (emitter: PdfEmitter, input: SaveInput, request: SectionRequest): number => {
  const { offset } = emitter;
  const number = input.size;
  const shift = input.base?.shift ?? 0;
  const entries = [...request.entries, { objectNumber: number, type: 1, field: offset - shift, generation: 0 } as const].toSorted(
    (left, right) => left.objectNumber - right.objectNumber,
  );
  const widths = fieldWidths(entries);
  const dictionary = new PdfDictionaryEntries([[TRAILER_KEYS.type, pdfName('XRef')]]);
  for (const [key, value] of trailerEntries(input, request, number + 1).entries()) dictionary.set(key, value);
  dictionary.set(TRAILER_KEYS.index, indexRuns(entries));
  dictionary.set(TRAILER_KEYS.w, pdfArray([pdfInteger(1), pdfInteger(widths[0]), pdfInteger(widths[1])]));
  const original = baseTrailerNode(input);
  const context = { original: original?.node, bytes: original?.bytes ?? new Uint8Array(), fractionDigits: input.fractionDigits, warn: request.warn };
  const data = streamData(entries, widths);
  const pair = fileIdentifier(input, {
    emitter,
    appendStart: request.appendStart,
    withoutId: () => {
      const writer = new ByteWriter();
      mergeSerialize(writer, { kind: 'stream', dictionary, data }, context);
      return writer.toUint8Array();
    },
  });
  if (pair !== undefined) dictionary.set(TRAILER_KEYS.id, idArray(pair));
  emitter.writer.writeAscii(`${String(number)} 0 obj\n`);
  mergeSerialize(emitter.writer, { kind: 'stream', dictionary, data }, context);
  emitter.writer.writeAscii('\nendobj');
  return offset;
};

/**
 * Appends the changes to the source as an incremental update in the format of the section startxref names: after a classic section a classic section and trailer, after a cross-reference stream a cross-reference stream.
 * Readers were seen to repair or misread files whose Prev entries link sections of different formats, so the format is never mixed.
 * ISO 32000-1:2008, 7.5.6: "changes shall be appended to the end of the file, leaving its original contents intact."
 */
export const incrementalSave = (input: SaveInput): SavedPdf => {
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
  // Without changes the source is the update; a caller who supplies a file identifier gets an update section that carries it.
  if (input.changes.size === 0 && input.fileIdentifier === 'derive') return savedPdf(store.source.segments, { mode: 'incremental', warnings });
  // Annex F, Table F.1, L: "A mismatch indicates that the file is not linearized and shall be treated as ordinary PDF, ignoring linearization information."
  if (structure.linearized) {
    warn({ code: 'linearization-invalidated', detail: 'the update makes the file an ordinary PDF; its linearization data no longer applies' });
  }
  const emitter = new PdfEmitter();
  for (const segment of store.source.segments) emitter.view(segment);
  const last = store.source.byteAt(store.source.length - 1);
  if (last !== 0x0a && last !== 0x0d) emitter.writer.writeByte(0x0a);
  const appendStart = emitter.offset;
  const written = writeObjects(emitter, input, warn);
  const entries = [...written.entries, ...freeEntries(store, written.freed)].toSorted((left, right) => left.objectNumber - right.objectNumber);
  const request = { appendStart, previousSection: newest.offset, entries, warn };
  const xrefOffset = structure.lastSectionKind === 'stream' ? writeStreamSection(emitter, input, request) : writeClassicSection(emitter, input, request);
  // 7.5.5: the file ends with startxref, the offset of the last cross-reference section, and %%EOF.
  emitter.writer.writeAscii(`\nstartxref\n${String(xrefOffset - (input.base?.shift ?? 0))}\n%%EOF\n`);
  return savedPdf(emitter.finish(), { mode: 'incremental', warnings });
};

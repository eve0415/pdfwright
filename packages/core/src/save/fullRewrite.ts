import type { StoredObject } from '../document/objectStore.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { SavedPdf } from '../write/savedPdf.ts';
import type { SaveInput } from './incrementalSave.ts';
import type { SaveWarning } from './saveWarning.ts';
import type { Entry } from './xrefWriter.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { createMd5 } from '../hash/md5.ts';
import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName } from '../object/pdfObject.ts';
import { isWhitespace } from '../parse/characterClass.ts';
import { savedPdf } from '../write/savedPdf.ts';
import { COMPRESSED, FREE, IN_FILE } from '../xref/objectIndex.ts';

import { PdfEmitter } from './emitter.ts';
import { mergeSerialize } from './mergeSerialize.ts';
import { originalValue } from './originalValue.ts';
import { TRAILER_KEYS, copiedTrailerEntries } from './trailerCopy.ts';
import { fieldWidths, idArray, indexRuns, streamData, writeTable } from './xrefWriter.ts';

const TYPE = pdfName('Type').bytes;
const LINEARIZED = pdfName('Linearized').bytes;
const H = pdfName('H').bytes;
const EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46];
// The longest gap between two unchanged objects that is checked for white space and comments, so that they can be copied as one run.
const MAX_GAP = 4096;

interface CleanObject {
  readonly objectNumber: number;
  readonly generation: number;
  readonly start: number;
  readonly end: number;
}

const typeOf = (value: PdfObject): string => {
  let entries: PdfDictionaryEntries | undefined = undefined;
  if (value.kind === 'stream') entries = value.dictionary;
  else if (value.kind === 'dictionary') ({ entries } = value);
  const type = entries?.get(TYPE);
  return type?.kind === 'name' ? new TextDecoder('latin1').decode(type.bytes) : '';
};

const ignore = (): void => {
  // The values serialized here are new, so nothing is resolved against an original.
};

const identifiers = (trailer: PdfDictionaryEntries): readonly [Uint8Array, Uint8Array] | undefined => {
  const id = trailer.get(TRAILER_KEYS.id);
  if (id?.kind !== 'array') return undefined;
  const [first, second] = id.items;
  return first?.kind === 'string' && second?.kind === 'string' ? [first.bytes, second.bytes] : undefined;
};

/**
 * Writes the whole document again, keeping every object's number and generation and copying the bytes of unchanged objects from the source.
 * Unchanged, cleanly parsed objects are copied in source order, runs of them as single views; changed, new and repaired objects follow in ascending number, serialized against their originals.
 * Object streams whose members did not change are kept as they are; the others are unpacked into top-level objects.
 */
class FullRewriter {
  private readonly input: SaveInput;
  private readonly warnings: SaveWarning[];
  private readonly emitter = new PdfEmitter();
  private readonly entries = new Map<number, Entry>();
  private readonly clean: CleanObject[] = [];
  private readonly rewritten = new Map<number, { generation: number; value: PdfObject }>();
  private readonly dropped = new Set<number>();
  private keptStreams = false;

  constructor(input: SaveInput) {
    this.input = input;
    this.warnings = [...input.warnings];
  }

  private warn(warning: SaveWarning): void {
    this.warnings.push(warning);
  }

  // Annex F: the linearization dictionary is the first object and its H entry gives the offsets of the hint streams; the rewrite does not keep the layout they describe.
  private dropLinearization(): void {
    const { store } = this.input;
    let first: number | undefined = undefined;
    let lowest = Number.POSITIVE_INFINITY;
    for (const number of store.index.inUse()) {
      const entry = store.index.get(number);
      if (entry.type === IN_FILE && entry.location < lowest) {
        lowest = entry.location;
        first = number;
      }
    }
    const value = first === undefined ? undefined : store.load(first)?.value;
    if (first === undefined || value?.kind !== 'dictionary' || !value.entries.has(LINEARIZED)) return;
    this.dropped.add(first);
    const hints = value.entries.get(H);
    const offsets = new Set(
      hints?.kind === 'array' ? hints.items.filter((_, index) => index % 2 === 0).map(item => (item.kind === 'integer' ? item.value : -1)) : [],
    );
    for (const number of store.index.inUse()) {
      const entry = store.index.get(number);
      if (entry.type === IN_FILE && offsets.has(entry.location)) this.dropped.add(number);
    }
    this.warn({
      code: 'linearization-removed',
      detail: 'the linearization dictionary and hint streams are left out, since the rewrite does not keep the layout they describe',
    });
  }

  private reportJunk(): void {
    const { source } = this.input.store;
    const tail = source.copy(source.length - 1024, source.length).bytes;
    let eof = -1;
    for (let position = tail.length - EOF_MARKER.length; position >= 0 && eof < 0; position--) {
      if (EOF_MARKER.every((byte, index) => tail[position + index] === byte)) eof = position + EOF_MARKER.length;
    }
    const trailing = eof >= 0 && tail.subarray(eof).some(byte => !isWhitespace(byte));
    if (this.input.structure.headerOffset > 0 || trailing) {
      this.warn({ code: 'junk-dropped', detail: 'bytes before the header or after the last %%EOF are left out' });
    }
  }

  // An object stream is kept when it is not itself changed and none of the members the index gives it changed; a reconstructed file's object streams are all unpacked.
  private touchedStreams(): Set<number> {
    const { store, changes, structure } = this.input;
    const streams = new Set<number>();
    const touched = new Set<number>();
    for (const number of store.index.inUse()) {
      const entry = store.index.get(number);
      if (entry.type !== COMPRESSED) continue;
      streams.add(entry.location);
      if (changes.has(number) || changes.has(entry.location) || structure.status === 'reconstructed') touched.add(entry.location);
    }
    return touched;
  }

  private place(number: number, object: StoredObject, touched: ReadonlySet<number>): void {
    const { source } = object;
    // Cross-reference streams describe the source's layout and are never written; unpacked object streams are replaced by their members.
    if (typeOf(object.value) === 'XRef' || touched.has(number)) return;
    if (source.kind === 'file' && source.clean) {
      this.clean.push({ objectNumber: number, generation: object.generation, start: source.objectStart, end: source.objectEnd });
    } else this.rewritten.set(number, { generation: object.generation, value: object.value });
  }

  private collect(): void {
    const { store, changes } = this.input;
    const touched = this.touchedStreams();
    const xrefStreams = this.input.base?.xrefStreams ?? new Map<number, number>();
    for (const number of store.index.inUse()) {
      const entry = store.index.get(number);
      // Cross-reference streams describe the source's layout and are never written; an ordinary object that reuses such a number is.
      if (changes.has(number) || this.dropped.has(number) || (entry.type === IN_FILE && xrefStreams.get(number) === entry.location)) continue;
      if (entry.type === COMPRESSED && !touched.has(entry.location)) {
        this.entries.set(number, { objectNumber: number, type: 2, field: entry.location, generation: entry.generation });
        this.keptStreams = true;
        continue;
      }
      // Every object is read, so that one that cannot be read stops the save instead of being skipped.
      const object = entry.type === IN_FILE ? store.parse(number) : store.load(number);
      if (object !== undefined) this.place(number, object, touched);
    }
    for (const [number, change] of changes) if (!('deleted' in change)) this.rewritten.set(number, change);
  }

  private gapIsBlank(from: number, to: number): boolean {
    if (to - from > MAX_GAP) return false;
    const { bytes } = this.input.store.source.copy(from, to);
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index] ?? 0;
      if (isWhitespace(byte)) continue;
      if (byte !== 0x25) return false;
      // ISO 32000-1:2008, 7.2.3: a comment runs to the end of the line.
      while (index < bytes.length && bytes[index] !== 0x0a && bytes[index] !== 0x0d) index++;
    }
    return true;
  }

  private writeRuns(): void {
    const { emitter } = this;
    const { source } = this.input.store;
    const objects = this.clean.toSorted((left, right) => left.start - right.start);
    for (let index = 0; index < objects.length;) {
      const first = objects[index];
      if (first === undefined) break;
      let last = first;
      let next = index + 1;
      while (next < objects.length && this.gapIsBlank(last.end, objects[next]?.start ?? 0)) last = objects[next++] ?? last;
      const runOffset = emitter.offset;
      for (let member = index; member < next; member++) {
        const object = objects[member];
        if (object !== undefined) {
          this.entries.set(object.objectNumber, {
            objectNumber: object.objectNumber,
            type: 1,
            field: runOffset + object.start - first.start,
            generation: object.generation,
          });
        }
      }
      for (const view of source.views(first.start, last.end)) emitter.view(view);
      emitter.writer.writeByte(0x0a);
      index = next;
    }
  }

  private writeRewritten(): void {
    const { emitter, input } = this;
    const warn = (warning: SaveWarning): void => {
      this.warn(warning);
    };
    for (const number of [...this.rewritten.keys()].toSorted((left, right) => left - right)) {
      const object = this.rewritten.get(number);
      if (object === undefined) continue;
      this.entries.set(number, { objectNumber: number, type: 1, field: emitter.offset, generation: object.generation });
      emitter.writer.writeAscii(`${String(number)} ${String(object.generation)} obj\n`);
      const original = originalValue(input.store, number, input.maxNesting);
      mergeSerialize(emitter.writer, object.value, {
        original: original?.node,
        bytes: original?.bytes ?? new Uint8Array(),
        fractionDigits: input.fractionDigits,
        warn,
      });
      emitter.writer.writeAscii('\nendobj\n');
    }
  }

  // ISO 32000-1:2008, 7.5.4: object 0 heads the linked list of free entries and "The last free entry (the tail of the linked list) links back to object number 0".
  private freeEntries(size: number): void {
    const { store, changes } = this.input;
    const free: { objectNumber: number; generation: number }[] = [];
    for (let number = 1; number < size; number++) {
      if (this.entries.has(number)) continue;
      const change = changes.get(number);
      const entry = store.index.get(number);
      let generation = entry.type === FREE ? entry.generation : 0;
      if (change !== undefined || entry.type === IN_FILE) generation = Math.min((change?.generation ?? entry.generation) + 1, 65_535);
      free.push({ objectNumber: number, generation });
    }
    this.entries.set(0, { objectNumber: 0, type: 0, field: free[0]?.objectNumber ?? 0, generation: 65_535 });
    for (const [index, object] of free.entries()) {
      this.entries.set(object.objectNumber, {
        objectNumber: object.objectNumber,
        type: 0,
        field: free[index + 1]?.objectNumber ?? 0,
        generation: object.generation,
      });
    }
  }

  // The trailer: Size, Root, Info and ID first, then the other entries of the source trailer that describe the document rather than a section.
  private trailer(size: number): PdfDictionaryEntries {
    const { structure } = this.input;
    // A reconstruction can adopt a cross-reference stream dictionary as the trailer, whose stream keys are left out like any stream section's.
    const type = structure.trailer.get(TYPE);
    const kind = structure.lastSectionKind ?? (type?.kind === 'name' && new TextDecoder('latin1').decode(type.bytes) === 'XRef' ? 'stream' : 'classic');
    const rest = copiedTrailerEntries(structure.trailer, kind);
    const trailer = parsedDictionaryEntries([[TRAILER_KEYS.size, pdfInteger(size)]]);
    for (const key of [TRAILER_KEYS.root, TRAILER_KEYS.info]) {
      const value = rest.get(key);
      if (value !== undefined) trailer.set(key, value);
    }
    for (const [key, value] of rest.entries()) if (!trailer.has(key)) trailer.set(key, value);
    trailer.delete(TRAILER_KEYS.id);
    return trailer;
  }

  // ISO 32000-1:2008, 14.4: the first identifier stays; the second is derived from the new contents. A source without ID gets none unless the caller supplies one.
  private identifier(trailerWithoutId: Uint8Array): readonly [Uint8Array, Uint8Array] | undefined {
    const { input } = this;
    if (input.fileIdentifier !== 'derive') return input.fileIdentifier;
    const previous = identifiers(input.structure.trailer);
    if (previous === undefined) return undefined;
    const hash = createMd5();
    for (const chunk of this.emitter.finish()) hash.update(chunk);
    return [previous[0], hash.update(trailerWithoutId).digest()];
  }

  private writeCrossReference(): number {
    const { emitter } = this;
    let highest = this.input.size;
    for (const number of this.entries.keys()) highest = Math.max(highest, number + 1);
    const xrefNumber = this.keptStreams ? highest : undefined;
    const size = xrefNumber === undefined ? highest : highest + 1;
    const { offset } = emitter;
    if (xrefNumber !== undefined) this.entries.set(xrefNumber, { objectNumber: xrefNumber, type: 1, field: offset, generation: 0 });
    this.freeEntries(size);
    const entries = [...this.entries.values()].toSorted((left, right) => left.objectNumber - right.objectNumber);
    const trailer = this.trailer(size);
    const serialize = (dictionary: PdfDictionaryEntries): Uint8Array => {
      const writer = new ByteWriter();
      mergeSerialize(
        writer,
        { kind: 'dictionary', entries: dictionary },
        { original: undefined, bytes: new Uint8Array(), fractionDigits: this.input.fractionDigits, warn: ignore },
      );
      return writer.toUint8Array();
    };
    if (xrefNumber === undefined) {
      writeTable(emitter.writer, entries);
      const pair = this.identifier(serialize(trailer));
      if (pair !== undefined) trailer.set(TRAILER_KEYS.id, idArray(pair));
      emitter.writer.writeAscii('trailer\n');
      emitter.writer.writeBytes(serialize(trailer));
      return offset;
    }
    // ISO 32000-1:2008, 7.5.8: kept object streams need type 2 entries, which only a cross-reference stream holds.
    const widths = fieldWidths(entries);
    const dictionary = parsedDictionaryEntries([[TYPE, pdfName('XRef')], ...trailer.entries()]);
    dictionary.set(TRAILER_KEYS.index, indexRuns(entries));
    dictionary.set(TRAILER_KEYS.w, pdfArray([pdfInteger(1), pdfInteger(widths[0]), pdfInteger(widths[1])]));
    const data = streamData(entries, widths);
    const pair = this.identifier(serialize(dictionary));
    if (pair !== undefined) dictionary.set(TRAILER_KEYS.id, idArray(pair));
    emitter.writer.writeAscii(`${String(xrefNumber)} 0 obj\n`);
    mergeSerialize(
      emitter.writer,
      { kind: 'stream', dictionary, data },
      { original: undefined, bytes: new Uint8Array(), fractionDigits: this.input.fractionDigits, warn: ignore },
    );
    emitter.writer.writeAscii('\nendobj');
    return offset;
  }

  write(): SavedPdf {
    const { structure } = this.input;
    if (structure.linearized) this.dropLinearization();
    this.reportJunk();
    this.collect();
    // ISO 32000-1:2008, 7.5.2: a header, then a comment with four bytes of 128 or more, since the file holds binary data.
    this.emitter.writer.writeAscii(`%PDF-${structure.headerVersion === '' ? '1.7' : structure.headerVersion}\n%`);
    this.emitter.writer.writeBytes(Uint8Array.of(0xe2, 0xe3, 0xcf, 0xd3));
    this.emitter.writer.writeByte(0x0a);
    this.writeRuns();
    this.writeRewritten();
    const xrefOffset = this.writeCrossReference();
    // 7.5.5: the file ends with startxref, the offset of the cross-reference section, and %%EOF.
    this.emitter.writer.writeAscii(`\nstartxref\n${String(xrefOffset)}\n%%EOF\n`);
    return savedPdf(this.emitter.finish(), { mode: 'full', warnings: this.warnings });
  }
}

export const fullRewrite = (input: SaveInput): SavedPdf => new FullRewriter(input).write();

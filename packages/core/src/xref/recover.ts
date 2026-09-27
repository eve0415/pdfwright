import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { ParsedIndirectObject } from '../parse/indirectObject.ts';
import type { LexContext } from '../parse/lexer.ts';
import type { DecodedObjectStream, ObjectStreamContext } from './objectStream.ts';
import type { XrefEntry } from './xrefSection.ts';

import { ParseError } from '../error/parseError.ts';
import { deepEqual } from '../object/deepEqual.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { isRegular, isWhitespace } from '../parse/characterClass.ts';
import { parseIndirectObject } from '../parse/indirectObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';

import { refuseEncryption } from './encryption.ts';
import { ObjectIndex } from './objectIndex.ts';
import { decodeObjectStream, parseMember } from './objectStream.ts';

export interface Reconstruction {
  readonly index: ObjectIndex;
  /** Trailer dictionaries and cross-reference stream dictionaries, in file order. */
  readonly trailers: readonly PdfDictionaryEntries[];
  /** Top-level objects that are dictionaries with Type Catalog and a Pages entry, in file order. */
  readonly catalogs: readonly number[];
  /** Object numbers with more than one copy whose values differ, or with a copy that does not parse beside one that does. */
  readonly ambiguous: readonly number[];
  /** Object numbers whose only copies do not parse; they resolve to null. */
  readonly unreadable: readonly number[];
  readonly objects: number;
  readonly objectStreams: number;
}

interface Candidate {
  readonly entry: XrefEntry;
  /** File position that ranks copies: later wins. Object-stream members rank at their stream's position. */
  readonly position: number;
  readonly bytes: Uint8Array;
  /** The parsed value, for comparing copies whose bytes differ. */
  readonly value: () => PdfObject;
}

const OBJ = [0x6f, 0x62, 0x6a];
const TRAILER = [0x74, 0x72, 0x61, 0x69, 0x6c, 0x65, 0x72];
const TYPE = pdfName('Type').bytes;
const PAGES = pdfName('Pages').bytes;

// A context per use, so that interned names do not outlive it.
const quiet = (): LexContext => ({
  warn: (): void => {
    // The scan only locates objects; they are parsed again, with warnings, when used.
  },
  names: new Map(),
});

const typeName = (value: PdfObject): string => {
  let entries: PdfDictionaryEntries | undefined = undefined;
  if (value.kind === 'dictionary') ({ entries } = value);
  else if (value.kind === 'stream') entries = value.dictionary;
  const type = entries?.get(TYPE);
  if (type?.kind !== 'name') return '';
  let text = '';
  for (const byte of type.bytes) text += String.fromCodePoint(byte);
  return text;
};

const matchesAt = (bytes: Uint8Array, position: number, pattern: readonly number[]): boolean =>
  pattern.every((byte, index) => bytes[position + index] === byte);

const indexOfPattern = (bytes: Uint8Array, pattern: readonly number[], from: number): number => {
  for (let position = bytes.indexOf(pattern[0] ?? 0, from); position >= 0; position = bytes.indexOf(pattern[0] ?? 0, position + 1)) {
    if (matchesAt(bytes, position, pattern)) return position;
  }
  return -1;
};

const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];

const lastIndexOfPattern = (bytes: Uint8Array, pattern: readonly number[]): number => {
  for (let position = bytes.lastIndexOf(pattern[0] ?? 0); position >= 0; position = position === 0 ? -1 : bytes.lastIndexOf(pattern[0] ?? 0, position - 1)) {
    if (matchesAt(bytes, position, pattern)) return position;
  }
  return -1;
};

const isBoundary = (byte: number | undefined): boolean => byte === undefined || !isRegular(byte);

const skipDigitsBack = (bytes: Uint8Array, end: number): number => {
  let position = end;
  while (position > 0 && (bytes[position - 1] ?? 0) >= 0x30 && (bytes[position - 1] ?? 0) <= 0x39) position--;
  return position;
};

const skipDigitsForward = (bytes: Uint8Array, start: number): number => {
  let position = start;
  while ((bytes[position] ?? 0) >= 0x30 && (bytes[position] ?? 0) <= 0x39) position++;
  return position;
};

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const skipWhitespaceBack = (bytes: Uint8Array, end: number): number => {
  let position = end;
  while (position > 0 && isWhitespace(bytes[position - 1] ?? 0)) position--;
  return position;
};

// Walks back from the keyword obj over white space, the generation, white space and the object number, which must follow a delimiter, white space or the start of the file.
const headerStart = (bytes: Uint8Array, keyword: number): number | undefined => {
  if (!isBoundary(bytes[keyword + 3])) return undefined;
  const generationEnd = skipWhitespaceBack(bytes, keyword);
  if (generationEnd === keyword) return undefined;
  const generationStart = skipDigitsBack(bytes, generationEnd);
  if (generationStart === generationEnd) return undefined;
  const numberEnd = skipWhitespaceBack(bytes, generationStart);
  if (numberEnd === generationStart) return undefined;
  const numberStart = skipDigitsBack(bytes, numberEnd);
  if (numberStart === numberEnd || !isBoundary(bytes[numberStart - 1])) return undefined;
  return numberStart;
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

class Scanner {
  private readonly source: ByteSource;
  private readonly bytes: Uint8Array;
  private readonly context: ObjectStreamContext;
  readonly candidates = new Map<number, Candidate[]>();
  readonly trailers: PdfDictionaryEntries[] = [];
  readonly catalogs: number[] = [];
  readonly objectStreams: { object: ParsedIndirectObject; position: number }[] = [];
  /** Object numbers of "n g obj" headers whose objects do not parse. */
  readonly unreadable = new Set<number>();

  private readonly lastEndstream: number;

  constructor(source: ByteSource, context: ObjectStreamContext) {
    // A reconstruction scans one contiguous buffer; a source held as several segments is joined for it.
    this.bytes = source.segments.length === 1 ? (source.segments[0] ?? new Uint8Array()) : source.copy(0, source.length).bytes;
    this.lastEndstream = lastIndexOfPattern(this.bytes, ENDSTREAM);
    this.source = new ByteSource(this.bytes);
    this.context = context;
  }

  private add(candidate: Candidate): void {
    const list = this.candidates.get(candidate.entry.objectNumber);
    if (list === undefined) this.candidates.set(candidate.entry.objectNumber, [candidate]);
    else list.push(candidate);
  }

  private parseObjectAt(offset: number): ParsedIndirectObject | undefined {
    try {
      return this.source.parseAt(offset, quiet(), (window, local, context) =>
        parseIndirectObject(window, local, { ...context, maxNesting: this.context.maxNesting, lastEndstream: this.lastEndstream }),
      );
    } catch (error: unknown) {
      // A match that does not parse as an object is not one; the scan goes on after its keyword.
      if (error instanceof ParseError) return undefined;
      throw error;
    }
  }

  private trailerAt(keyword: number): number {
    const lexer = new Lexer({ bytes: this.bytes, base: 0, final: true }, keyword + TRAILER.length, quiet());
    try {
      const value = parseObject(lexer, this.context.maxNesting);
      if (value.kind === 'dictionary') this.trailers.push(value.entries);
      return lexer.position;
    } catch (error: unknown) {
      if (error instanceof ParseError) return keyword + TRAILER.length;
      throw error;
    }
  }

  private object(header: number, keyword: number): number {
    const object = this.parseObjectAt(header);
    if (object === undefined) {
      const digits = this.bytes.subarray(header, skipDigitsForward(this.bytes, header));
      this.unreadable.add(Number(latin1(digits)));
      return keyword + OBJ.length;
    }
    const { objectNumber, generation, value, source } = object;
    this.add({
      entry: { objectNumber, type: 'file', location: header, generation },
      position: header,
      bytes: this.bytes.subarray(source.valueStart, source.valueEnd),
      value: () => value,
    });
    const type = typeName(value);
    if (type === 'XRef' && value.kind === 'stream') this.trailers.push(value.dictionary);
    if (type === 'ObjStm') this.objectStreams.push({ object, position: header });
    if (type === 'Catalog' && value.kind === 'dictionary' && value.entries.has(PAGES)) this.catalogs.push(objectNumber);
    // Scanning resumes after the object, so bytes inside stream data whose extent is known never produce objects; a stream whose Length is indirect has its extent found from endstream.
    return source.objectEnd;
  }

  private afterTrailer(keyword: number): number {
    const isKeyword = isBoundary(this.bytes[keyword - 1]) && isBoundary(this.bytes[keyword + TRAILER.length]);
    return isKeyword ? this.trailerAt(keyword) : keyword + 1;
  }

  private afterObject(keyword: number): number {
    const header = headerStart(this.bytes, keyword);
    return header === undefined ? keyword + 1 : this.object(header, keyword);
  }

  scan(): void {
    const { bytes } = this;
    let nextObj = indexOfPattern(bytes, OBJ, 0);
    let nextTrailer = indexOfPattern(bytes, TRAILER, 0);
    while (nextObj >= 0 || nextTrailer >= 0) {
      const position = nextTrailer >= 0 && (nextObj < 0 || nextTrailer < nextObj) ? this.afterTrailer(nextTrailer) : this.afterObject(nextObj);
      if (nextObj >= 0 && nextObj < position) nextObj = indexOfPattern(bytes, OBJ, position);
      if (nextTrailer >= 0 && nextTrailer < position) nextTrailer = indexOfPattern(bytes, TRAILER, position);
    }
  }

  // Members of every object stream found rank at the stream's position.
  members(): DecodedObjectStream[] {
    const decoded: DecodedObjectStream[] = [];
    for (const { object, position } of this.objectStreams) {
      const stream = decodeObjectStream(object.objectNumber, object.value, this.context);
      decoded.push(stream);
      for (const [index, member] of stream.members.entries()) {
        const entry: XrefEntry = { objectNumber: member.objectNumber, type: 'compressed', location: object.objectNumber, generation: index };
        this.add({
          entry,
          position,
          bytes: stream.data.subarray(member.start, member.end),
          value: () => parseMember(stream, { objectNumber: member.objectNumber, index }, this.context),
        });
      }
    }
    return decoded;
  }
}

const reportExtendsCycles = (streams: readonly DecodedObjectStream[], context: ObjectStreamContext): void => {
  const extending = new Map(streams.map(stream => [stream.objectNumber, stream.extends]));
  for (const stream of streams) {
    const seen = new Set<number>();
    for (let current: number | undefined = stream.objectNumber; current !== undefined; current = extending.get(current)) {
      // ISO 32000-1:2008, 7.5.7, Table 16, Extends: "A given collection consists of a set of streams whose Extends links form a directed acyclic graph."
      if (seen.has(current)) {
        context.warn({
          code: 'objstm-extends-cycle',
          detail: `the Extends links of object stream ${String(stream.objectNumber)} form a cycle`,
          objectNumber: stream.objectNumber,
        });
        break;
      }
      seen.add(current);
    }
  }
};

/**
 * Rebuilds the cross-reference information by scanning the file for "n g obj" headers, trailers and object streams.
 * A later copy of an object outranks an earlier one; copies whose bytes differ are reported as ambiguous, since readers disagree about which one to use.
 */
export const reconstructIndex = (input: ByteSource, context: ObjectStreamContext): Reconstruction => {
  const scanner = new Scanner(input, context);
  scanner.scan();
  // ISO 32000-1:2008, 7.6.1: an Encrypt entry makes the document encrypted, and its object streams cannot be decoded without decrypting them, so encryption is checked first.
  refuseEncryption(scanner.trailers);
  const streams = scanner.members();
  reportExtendsCycles(streams, context);
  const ranked: XrefEntry[] = [];
  const ambiguous: number[] = [];
  for (const [objectNumber, list] of scanner.candidates) {
    const ordered = list.toSorted((left, right) => right.position - left.position);
    const [latest] = ordered;
    if (latest === undefined) continue;
    ranked.push(latest.entry);
    const differs = ordered.some(candidate => !sameBytes(candidate.bytes, latest.bytes) && !deepEqual(candidate.value(), latest.value(), 'strict'));
    if (differs || scanner.unreadable.has(objectNumber)) ambiguous.push(objectNumber);
  }
  const unreadable = [...scanner.unreadable].filter(objectNumber => !scanner.candidates.has(objectNumber));
  return {
    index: ObjectIndex.fromEntries(ranked),
    trailers: scanner.trailers,
    catalogs: scanner.catalogs,
    ambiguous: ambiguous.toSorted((left, right) => left - right),
    unreadable: unreadable.toSorted((left, right) => left - right),
    objects: ranked.length,
    objectStreams: streams.length,
  };
};

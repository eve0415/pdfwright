import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { LexContext, LexWindow, Token } from './lexer.ts';
import type { LoadWarning } from './loadWarning.ts';

import { ParseError } from '../error/parseError.ts';

import { isWhitespace } from './characterClass.ts';
import { Lexer } from './lexer.ts';
import { parseObject } from './parseObject.ts';

/** Where an indirect object's bytes are: absolute offsets in the file. `clean` is false when parsing it raised a warning. */
export interface FileSource {
  readonly kind: 'file';
  readonly objectStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly objectEnd: number;
  readonly stream?: { readonly dictionaryEnd: number; readonly dataStart: number; readonly dataEnd: number };
  readonly clean: boolean;
}

export interface ParsedIndirectObject {
  readonly objectNumber: number;
  readonly generation: number;
  readonly value: PdfObject;
  readonly source: FileSource;
}

export interface IndirectObjectContext extends LexContext {
  readonly maxNesting: number;
  /** Resolves an indirect stream Length (ISO 32000-1:2008, 7.3.10, EXAMPLE 3); undefined when it cannot be resolved. */
  readonly resolveLength?: (objectNumber: number, generation: number) => number | undefined;
  /** Offset of the last endstream keyword in the source, when known, so that a stream starting after it fails at once. */
  readonly lastEndstream?: number | (() => number);
}

const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];

const isKeyword = (token: Token, keyword: string): boolean => token.kind === 'keyword' && token.keyword === keyword;

const matchesAt = (lexer: Lexer, position: number, pattern: readonly number[]): boolean => {
  for (let index = 0; index < pattern.length; index++) {
    if (lexer.atEnd(position + index) || lexer.bytes[position + index] !== pattern[index]) return false;
  }
  return true;
};

// ISO 32000-1:2008, 7.3.10: "The definition of an indirect object in a PDF file shall consist of its object number and generation number (separated by white space), followed by the value of the object bracketed between the keywords obj and endobj."
interface ObjectHeader {
  objectNumber: number;
  generation: number;
}

const readHeader = (lexer: Lexer): ObjectHeader => {
  const { start } = lexer.peek();
  const number = lexer.next();
  const generation = lexer.next();
  const keyword = lexer.next();
  if (number.kind !== 'integer' || generation.kind !== 'integer' || !isKeyword(keyword, 'obj') || number.value < 0 || generation.value < 0) {
    throw new ParseError('expected an object header', lexer.base + start);
  }
  return { objectNumber: number.value, generation: generation.value };
};

// ISO 32000-1:2008, 7.3.8.1: "The keyword stream that follows the stream dictionary shall be followed by an end-of-line marker consisting of either a CARRIAGE RETURN and a LINE FEED or just a LINE FEED, and not by a CARRIAGE RETURN alone."
const dataStartAfter = (lexer: Lexer, keywordEnd: number): number => {
  let position = keywordEnd;
  // Readers skip spaces and tabs a writer put between the keyword and the end-of-line marker.
  while (!lexer.atEnd(position) && (lexer.bytes[position] === 0x20 || lexer.bytes[position] === 0x09)) position++;
  const first = lexer.atEnd(position) ? undefined : lexer.bytes[position];
  if (first !== 0x0a && first !== 0x0d) {
    lexer.warn({ code: 'stream-keyword-eol', detail: 'the keyword stream is not followed by an end-of-line marker' }, keywordEnd);
    return keywordEnd;
  }
  if (position > keywordEnd) {
    lexer.warn({ code: 'stream-keyword-eol', detail: 'white space separates the keyword stream from its end-of-line marker' }, keywordEnd);
  }
  if (first === 0x0a) return position + 1;
  if (!lexer.atEnd(position + 1) && lexer.bytes[position + 1] === 0x0a) return position + 2;
  lexer.warn({ code: 'stream-keyword-cr', detail: 'the keyword stream is followed by a CARRIAGE RETURN alone' }, position);
  return position + 1;
};

// ISO 32000-1:2008, 7.3.8.2, Table 5, Length: "The number of bytes from the beginning of the line following the keyword stream to the last byte just before the keyword endstream. (There may be an additional EOL marker, preceding endstream, that is not included in the count".
const endstreamAfterData = (lexer: Lexer, dataEnd: number): number | undefined => {
  let position = dataEnd;
  if (!lexer.atEnd(position) && lexer.bytes[position] === 0x0d) position++;
  if (!lexer.atEnd(position) && lexer.bytes[position] === 0x0a) position++;
  while (!lexer.atEnd(position) && isWhitespace(lexer.bytes[position] ?? 0)) position++;
  return matchesAt(lexer, position, ENDSTREAM) ? position : undefined;
};

const declaredLength = (dictionary: PdfDictionaryEntries, context: IndirectObjectContext): number | undefined => {
  const length = dictionary.get(Uint8Array.of(0x4c, 0x65, 0x6e, 0x67, 0x74, 0x68));
  if (length?.kind === 'reference') return context.resolveLength?.(length.objectNumber, length.generation);
  return length?.kind === 'integer' && length.value >= 0 ? length.value : undefined;
};

interface StreamExtent {
  dataStart: number;
  dataEnd: number;
  endstreamEnd: number;
}

const ENDOBJ = [0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a];

const followedByEndobj = (lexer: Lexer, endstream: number): boolean => {
  let position = endstream + ENDSTREAM.length;
  while (!lexer.atEnd(position) && isWhitespace(lexer.bytes[position] ?? 0)) position++;
  return matchesAt(lexer, position, ENDOBJ);
};

// Readers recover a stream whose Length is missing or wrong by searching for endstream. Data can contain the bytes "endstream", so of the first two occurrences the one followed by endobj is preferred, else the first; looking no further keeps the search linear when endobj keywords are missing.
const searchEndstream = (lexer: Lexer, dataStart: number, context: IndirectObjectContext): number => {
  const { bytes } = lexer;
  const lastEndstream = typeof context.lastEndstream === 'function' ? context.lastEndstream() : context.lastEndstream;
  if (lastEndstream !== undefined && lexer.base + dataStart > lastEndstream) {
    throw new ParseError('stream data has no endstream keyword', lexer.base + dataStart);
  }
  const found: number[] = [];
  for (let position = bytes.indexOf(ENDSTREAM[0] ?? 0, dataStart); found.length < 2; position = bytes.indexOf(ENDSTREAM[0] ?? 0, position + 1)) {
    if (position < 0) {
      lexer.atEnd(bytes.length);
      break;
    }
    if (matchesAt(lexer, position, ENDSTREAM)) {
      if (followedByEndobj(lexer, position)) return position;
      found.push(position);
    }
  }
  const [first] = found;
  if (first === undefined) throw new ParseError('stream data has no endstream keyword', lexer.base + dataStart);
  return first;
};

interface StreamStart {
  readonly dictionary: PdfDictionaryEntries;
  readonly keywordEnd: number;
}

const streamExtent = (lexer: Lexer, { dictionary, keywordEnd }: StreamStart, context: IndirectObjectContext): StreamExtent => {
  const dataStart = dataStartAfter(lexer, keywordEnd);
  const length = declaredLength(dictionary, context);
  const endstream = length === undefined ? undefined : endstreamAfterData(lexer, dataStart + length);
  if (length !== undefined && endstream !== undefined) return { dataStart, dataEnd: dataStart + length, endstreamEnd: endstream + ENDSTREAM.length };
  const found = searchEndstream(lexer, dataStart, context);
  let dataEnd = found;
  // One end-of-line marker before endstream is not part of the data (Table 5, Length).
  if (dataEnd > dataStart && lexer.bytes[dataEnd - 1] === 0x0a) dataEnd--;
  if (dataEnd > dataStart && lexer.bytes[dataEnd - 1] === 0x0d) dataEnd--;
  const declared = length === undefined ? 'missing or unresolvable' : String(length);
  lexer.warn({ code: 'stream-length-recovered', detail: `stream Length ${declared}, found ${String(dataEnd - dataStart)} bytes before endstream` }, dataStart);
  return { dataStart, dataEnd, endstreamEnd: found + ENDSTREAM.length };
};

// Readers accept an object whose endobj is missing when the next thing is another object, a cross-reference section, a trailer or the end of the file.
const startsNextStructure = (lexer: Lexer, token: Token): boolean => {
  if (token.kind === 'eof' || isKeyword(token, 'xref') || isKeyword(token, 'trailer') || isKeyword(token, 'startxref')) return true;
  if (token.kind !== 'integer') return false;
  const resume = lexer.position;
  lexer.next();
  const generation = lexer.next();
  const keyword = lexer.next();
  lexer.seek(resume);
  return generation.kind === 'integer' && isKeyword(keyword, 'obj');
};

/** Parses the indirect object whose header starts at `local` in `window`. */
export const parseIndirectObject = (window: LexWindow, local: number, context: IndirectObjectContext): ParsedIndirectObject => {
  let objectNumber: number | undefined = undefined;
  let clean = true;
  const lexer = new Lexer(window, local, {
    names: context.names,
    warn: (warning: LoadWarning): void => {
      clean = false;
      context.warn(objectNumber === undefined ? warning : { ...warning, objectNumber });
    },
  });
  lexer.skipWhitespace();
  const objectStart = lexer.position;
  const header = readHeader(lexer);
  ({ objectNumber } = header);
  const { start: valueStart } = lexer.peek();
  const direct = parseObject(lexer, context.maxNesting);
  let value: PdfObject = direct;
  let valueEnd = lexer.position;
  let stream: FileSource['stream'] = undefined;
  const afterValue = lexer.peek();
  if (isKeyword(afterValue, 'stream')) {
    if (direct.kind !== 'dictionary') throw new ParseError('a stream must follow a dictionary', lexer.base + afterValue.start);
    const extent = streamExtent(lexer, { dictionary: direct.entries, keywordEnd: afterValue.end }, context);
    // Data from a copied window is copied out, so that keeping the object does not keep the whole window alive.
    const data = lexer.copied ? lexer.bytes.slice(extent.dataStart, extent.dataEnd) : lexer.bytes.subarray(extent.dataStart, extent.dataEnd);
    value = { kind: 'stream', dictionary: direct.entries, data };
    stream = { dictionaryEnd: lexer.base + valueEnd, dataStart: lexer.base + extent.dataStart, dataEnd: lexer.base + extent.dataEnd };
    lexer.seek(extent.endstreamEnd);
    valueEnd = extent.endstreamEnd;
  }
  const closing = lexer.peek();
  let objectEnd = valueEnd;
  if (isKeyword(closing, 'endobj')) objectEnd = lexer.next().end;
  else if (startsNextStructure(lexer, closing)) lexer.warn({ code: 'missing-endobj', detail: 'the object has no endobj keyword' }, closing.start);
  else throw new ParseError('expected endobj', lexer.base + closing.start);
  const { base } = lexer;
  const extent = {
    kind: 'file',
    objectStart: base + objectStart,
    valueStart: base + valueStart,
    valueEnd: base + valueEnd,
    objectEnd: base + objectEnd,
  } as const;
  const source: FileSource = stream === undefined ? { ...extent, clean } : { ...extent, stream, clean };
  return { ...header, value, source };
};

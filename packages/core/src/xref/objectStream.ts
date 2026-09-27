import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { LexContext } from '../parse/lexer.ts';
import type { XrefContext } from './xrefStream.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { pdfName } from '../object/pdfObject.ts';
import { isWhitespace } from '../parse/characterClass.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';

export interface ObjectStreamMember {
  readonly objectNumber: number;
  /** Span of the member's value in the decoded stream. */
  readonly start: number;
  readonly end: number;
}

export interface DecodedObjectStream {
  readonly objectNumber: number;
  readonly data: Uint8Array;
  /** Members in the order of the stream's header, which is the order of the indices cross-reference entries use. */
  readonly members: readonly ObjectStreamMember[];
  /** The stream this one extends, from its Extends entry. */
  readonly extends?: number;
}

export interface ObjectStreamContext extends XrefContext {
  readonly maxObjectStreamMembers: number;
}

const TYPE = pdfName('Type').bytes;
const N = pdfName('N').bytes;
const FIRST = pdfName('First').bytes;
const EXTENDS = pdfName('Extends').bytes;
const OBJ_STM = 'ObjStm';

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const nonNegative = (value: PdfDirectObject | undefined): number | undefined => (value?.kind === 'integer' && value.value >= 0 ? value.value : undefined);

const readHeader = (data: Uint8Array, count: number, context: LexContext): number[] => {
  const lexer = new Lexer({ bytes: data, base: 0, final: true }, 0, context);
  const pairs: number[] = [];
  for (let index = 0; index < count * 2; index++) {
    const token = lexer.next();
    if (token.kind !== 'integer' || token.value < 0) {
      throw new ParseError(`the object stream header has fewer than ${String(count)} pairs of integers`, token.start);
    }
    pairs.push(token.value);
  }
  return pairs;
};

// The first start in `sorted` greater than `start`, or `fallback`.
const nextStart = (sorted: readonly number[], start: number, fallback: number): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((sorted[middle] ?? 0) <= start) low = middle + 1;
    else high = middle;
  }
  return sorted[low] ?? fallback;
};

const trimmedEnd = (data: Uint8Array, start: number, end: number): number => {
  let trimmed = end;
  while (trimmed > start && isWhitespace(data[trimmed - 1] ?? 0)) trimmed--;
  return trimmed;
};

/** Decodes an object stream and locates its members (ISO 32000-1:2008, 7.5.7, Table 16). */
export const decodeObjectStream = (objectNumber: number, stream: PdfObject, context: ObjectStreamContext): DecodedObjectStream => {
  if (stream.kind !== 'stream') throw new ParseError(`object ${String(objectNumber)} is not an object stream`, 0);
  const { dictionary } = stream;
  const type = dictionary.get(TYPE);
  if (type?.kind !== 'name' || latin1(type.bytes) !== OBJ_STM) throw new ParseError(`object ${String(objectNumber)} is not an object stream`, 0);
  const count = nonNegative(dictionary.get(N));
  const first = nonNegative(dictionary.get(FIRST));
  if (count === undefined || first === undefined) throw new ParseError(`object stream ${String(objectNumber)} has no valid N or First`, 0);
  // House limit, not a PDF rule: a member count above maxObjectStreamMembers is refused rather than read.
  if (count > context.maxObjectStreamMembers) {
    throw new ResourceLimitError(
      `object stream ${String(objectNumber)} declares ${String(count)} members, more than maxObjectStreamMembers (${String(context.maxObjectStreamMembers)})`,
    );
  }
  const data = decodeStream(stream, { maxDecodedBytes: context.maxDecodedBytes, warn: context.warn });
  if (first > data.length) throw new ParseError(`object stream ${String(objectNumber)} has First beyond its data`, 0);
  const pairs = readHeader(data.subarray(0, first), count, context);
  // "A conforming reader shall rely on the First entry in the stream dictionary to locate the first object." and "The offsets shall be in increasing order."
  const starts: number[] = [];
  for (let index = 1; index < pairs.length; index += 2) starts.push(first + (pairs[index] ?? 0));
  const sorted = starts.toSorted((left, right) => left - right);
  if (sorted.some((start, index) => start !== starts[index])) {
    context.warn({ code: 'objstm-offsets-unsorted', detail: `object stream ${String(objectNumber)} lists member offsets out of order`, objectNumber });
  }
  const members = starts.map((start, index) => {
    if (start > data.length) throw new ParseError(`object stream ${String(objectNumber)} places a member beyond its data`, 0);
    const next = nextStart(sorted, start, data.length);
    return { objectNumber: pairs[index * 2] ?? 0, start, end: trimmedEnd(data, start, next) };
  });
  const extended = dictionary.get(EXTENDS);
  const decoded = { objectNumber, data, members };
  return extended?.kind === 'reference' ? { ...decoded, extends: extended.objectNumber } : decoded;
};

/** Parses member `index`, which the cross-reference entry for `objectNumber` names. */
export const parseMember = (stream: DecodedObjectStream, request: { objectNumber: number; index: number }, context: ObjectStreamContext): PdfDirectObject => {
  const member = stream.members[request.index];
  // No guess is safe when the index names a different object.
  if (member?.objectNumber !== request.objectNumber) {
    throw new ParseError(
      `object stream ${String(stream.objectNumber)} does not hold object ${String(request.objectNumber)} at index ${String(request.index)}`,
      0,
    );
  }
  const lexer = new Lexer({ bytes: stream.data.subarray(0, member.end), base: 0, final: true }, member.start, {
    names: context.names,
    warn: warning => {
      context.warn({ ...warning, objectNumber: request.objectNumber });
    },
  });
  const value = parseObject(lexer, context.maxNesting);
  if (lexer.peek().kind !== 'eof') {
    throw new ParseError(`object ${String(request.objectNumber)} in object stream ${String(stream.objectNumber)} has bytes after its value`, lexer.position);
  }
  return value;
};

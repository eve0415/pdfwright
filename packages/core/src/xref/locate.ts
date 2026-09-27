import type { ByteSource } from '../parse/byteSource.ts';
import type { LexContext, LexWindow } from '../parse/lexer.ts';

import { isRegular, isWhitespace } from '../parse/characterClass.ts';
import { Lexer } from '../parse/lexer.ts';

export interface HeaderLocation {
  readonly offset: number;
  readonly version: string;
}

export interface StartxrefLocation {
  /** Offset of the keyword startxref. */
  readonly keyword: number;
  /** The byte offset the keyword gives. */
  readonly offset: number;
}

export interface SectionStart {
  readonly offset: number;
  readonly corrected: boolean;
}

const HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d];
const STARTXREF = [0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66];
const XREF = [0x78, 0x72, 0x65, 0x66];
const HEADER_SEARCH = 1024;
const TRAILER_SEARCH = 4096;
const CORRECTION = 64;

const quiet: LexContext = {
  warn: (): void => {
    // Probing for structure reports nothing; the parse that follows reports what it finds.
  },
  names: new Map(),
};

const matchesAt = (bytes: Uint8Array, position: number, pattern: readonly number[]): boolean =>
  position >= 0 && pattern.every((byte, index) => bytes[position + index] === byte);

const indexOf = (bytes: Uint8Array, pattern: readonly number[], from: number): number => {
  for (let position = bytes.indexOf(pattern[0] ?? 0, from); position >= 0; position = bytes.indexOf(pattern[0] ?? 0, position + 1)) {
    if (matchesAt(bytes, position, pattern)) return position;
  }
  return -1;
};

const lastIndexOf = (bytes: Uint8Array, pattern: readonly number[]): number => {
  for (let position = bytes.lastIndexOf(pattern[0] ?? 0); position >= 0; position = position === 0 ? -1 : bytes.lastIndexOf(pattern[0] ?? 0, position - 1)) {
    if (matchesAt(bytes, position, pattern)) return position;
  }
  return -1;
};

const isDigit = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x30 && byte <= 0x39;

// ISO 32000-1:2008, 7.5.2: "The first line of a PDF file shall be a header consisting of the 5 characters %PDF" followed by a version number.
// Readers also accept a header after leading bytes, so the first 1,024 bytes and then the whole first segment are searched.
export const locateHeader = (source: ByteSource): HeaderLocation | undefined => {
  const head = source.copy(0, HEADER_SEARCH);
  let window: LexWindow = head;
  let position = indexOf(head.bytes, HEADER, 0);
  if (position < 0) {
    window = source.window(0);
    position = indexOf(window.bytes, HEADER, 0);
  }
  if (position < 0) return undefined;
  const { bytes } = window;
  const major = bytes[position + 5];
  const minor = bytes[position + 7];
  const version = isDigit(major) && bytes[position + 6] === 0x2e && isDigit(minor) ? String.fromCodePoint(major ?? 0, 0x2e, minor ?? 0) : '';
  return { offset: window.base + position, version };
};

const readStartxref = (source: ByteSource, keyword: number): StartxrefLocation | undefined =>
  source.parseAt(keyword, quiet, (window, local, context) => {
    const lexer = new Lexer(window, local, context);
    lexer.next();
    const offset = lexer.next();
    return offset.kind === 'integer' && offset.value >= 0 ? { keyword, offset: offset.value } : undefined;
  });

// ISO 32000-1:2008, 7.5.5: "Conforming readers should read a PDF file from its end." The last startxref counts, since linearized and updated files contain earlier ones, and bytes after %%EOF are tolerated.
export const locateStartxref = (source: ByteSource): StartxrefLocation | undefined => {
  const tail = source.copy(source.length - TRAILER_SEARCH, source.length);
  let position = lastIndexOf(tail.bytes, STARTXREF);
  let { base } = tail;
  if (position < 0) {
    const last = source.window(source.length - 1);
    position = lastIndexOf(last.bytes, STARTXREF);
    ({ base } = last);
  }
  if (position < 0) return undefined;
  return readStartxref(source, base + position);
};

// A section starts with the keyword xref or with the header "n g obj" of a cross-reference stream.
const startsSection = (window: LexWindow, local: number): boolean => {
  const { bytes } = window;
  if (local > 0 && isRegular(bytes[local - 1] ?? 0)) return false;
  if (matchesAt(bytes, local, XREF)) return local + 4 >= bytes.length || !isRegular(bytes[local + 4] ?? 0);
  const lexer = new Lexer(window, local, quiet);
  const number = lexer.next();
  const generation = lexer.next();
  const keyword = lexer.next();
  return number.start === local && number.kind === 'integer' && generation.kind === 'integer' && keyword.kind === 'keyword' && keyword.keyword === 'obj';
};

/** Finds the cross-reference section at `offset`, after white space, or else the nearest one within 64 bytes. */
export const sectionStartNear = (source: ByteSource, offset: number): SectionStart | undefined => {
  const copied = source.copy(offset - CORRECTION, offset + 2 * CORRECTION + 64);
  // The copy is probed as if it were the whole file, so a header cut off at its end simply does not match.
  const window: LexWindow = { bytes: copied.bytes, base: copied.base, final: true };
  const local = offset - window.base;
  let start = local;
  while (start < window.bytes.length && isWhitespace(window.bytes[start] ?? 1)) start++;
  if (startsSection(window, start)) return { offset: window.base + start, corrected: false };
  for (let distance = 1; distance <= CORRECTION; distance++) {
    for (const candidate of [local - distance, local + distance]) {
      if (candidate >= 0 && candidate < window.bytes.length && startsSection(window, candidate)) return { offset: window.base + candidate, corrected: true };
    }
  }
  return undefined;
};

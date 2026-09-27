import type { InvalidObjectReason } from '../object/pdfObject.ts';
import type { LoadWarning } from './loadWarning.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { ParseError } from '../error/parseError.ts';

import { isRegular, isWhitespace } from './characterClass.ts';
import { WindowEndError } from './windowEndError.ts';

export type Keyword = 'true' | 'false' | 'null' | 'obj' | 'endobj' | 'stream' | 'endstream' | 'R' | 'xref' | 'trailer' | 'startxref' | 'other';

export type InvalidTokenReason = Exclude<InvalidObjectReason, 'unknown-keyword'> | 'stray-delimiter';

export type Token =
  | { kind: 'integer'; value: number; start: number; end: number }
  | { kind: 'real'; value: number; start: number; end: number }
  | { kind: 'invalid'; reason: InvalidTokenReason; start: number; end: number }
  | { kind: 'name'; bytes: Uint8Array; start: number; end: number }
  | { kind: 'string'; bytes: Uint8Array; encoding: 'literal' | 'hex'; start: number; end: number }
  | { kind: 'arrayOpen' | 'arrayClose' | 'dictionaryOpen' | 'dictionaryClose'; start: number; end: number }
  | { kind: 'keyword'; keyword: Keyword; start: number; end: number }
  | { kind: 'eof'; start: number; end: number };

/** Bytes a lexer reads: `base` is the offset of `bytes[0]` in the source, and `final` says whether the source ends where `bytes` ends. */
export interface LexWindow {
  readonly bytes: Uint8Array;
  readonly base: number;
  readonly final: boolean;
  /** Length of the whole source, so that a position past it ends a non-final window without asking for more bytes. */
  readonly sourceLength?: number;
  /** Whether `bytes` is a copy rather than a view of the source, so that values kept from it must be copied out. */
  readonly copied?: boolean;
}

export interface LexContext {
  readonly warn: (warning: LoadWarning) => void;
  /** Decoded name bytes by their latin1 spelling, so that equal names share one array. */
  readonly names: Map<string, Uint8Array>;
}

const KEYWORDS: ReadonlyMap<string, Keyword> = new Map(
  (['true', 'false', 'null', 'obj', 'endobj', 'stream', 'endstream', 'R', 'xref', 'trailer', 'startxref'] as const).map(keyword => [keyword, keyword]),
);

// ISO 32000-1:2008, 7.3.4.2, Table 3: \n \r \t \b \f \( \) \\.
const ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x28, 0x28],
  [0x29, 0x29],
  [0x5c, 0x5c],
]);

const latin1 = (bytes: Uint8Array, start: number, end: number): string => {
  let text = '';
  for (let index = start; index < end; index++) text += String.fromCodePoint(bytes[index] ?? 0);
  return text;
};

const hexValue = (byte: number | undefined): number => {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
};

const isDigit = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x30 && byte <= 0x39;

const startsNumber = (byte: number): boolean => isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e;

type NumberToken = Extract<Token, { kind: 'integer' | 'real' | 'invalid' }>;

// ISO 32000-1:2008, 7.3.3: "An integer shall be written as one or more decimal digits optionally preceded by a sign." and "A real value shall be written as one or more decimal digits with an optional sign and a leading, trailing, or embedded PERIOD (2Eh) (decimal point)."
const numberToken = (bytes: Uint8Array, start: number, end: number): NumberToken => {
  let index = start;
  if (bytes[index] === 0x2b || bytes[index] === 0x2d) index++;
  let digits = 0;
  let integer = 0;
  while (index < end && isDigit(bytes[index])) {
    integer = integer * 10 + ((bytes[index] ?? 0) - 0x30);
    digits++;
    index++;
  }
  let period = false;
  if (index < end && bytes[index] === 0x2e) {
    period = true;
    index++;
    while (index < end && isDigit(bytes[index])) {
      digits++;
      index++;
    }
  }
  if (index !== end || digits === 0) return { kind: 'invalid', reason: 'malformed-number', start, end };
  if (period) {
    const value = Number(latin1(bytes, start, end));
    if (!Number.isFinite(value)) return { kind: 'invalid', reason: 'real-out-of-range', start, end };
    return { kind: 'real', value: value === 0 ? 0 : value, start, end };
  }
  if (integer > Number.MAX_SAFE_INTEGER) return { kind: 'invalid', reason: 'integer-out-of-range', start, end };
  const value = bytes[start] === 0x2d ? -integer : integer;
  return { kind: 'integer', value: value === 0 ? 0 : value, start, end };
};

export class Lexer {
  readonly bytes: Uint8Array;
  readonly base: number;
  readonly final: boolean;
  readonly copied: boolean;
  private readonly sourceLength: number;
  readonly context: LexContext;
  position: number;
  private peeked: Token | undefined = undefined;
  private second: Token | undefined = undefined;

  constructor(window: LexWindow, start: number, context: LexContext) {
    this.bytes = window.bytes;
    this.base = window.base;
    this.final = window.final;
    this.copied = window.copied === true;
    this.sourceLength = window.sourceLength ?? Number.POSITIVE_INFINITY;
    this.position = start;
    this.context = context;
  }

  /** Returns true at the end of the source and throws WindowEndError at the end of a window that is not. */
  atEnd(position: number): boolean {
    if (position < this.bytes.length) return false;
    if (!this.final && this.base + position < this.sourceLength) throw new WindowEndError();
    return true;
  }

  warn(warning: Omit<LoadWarning, 'offset'>, position: number): void {
    this.context.warn({ ...warning, offset: this.base + position });
  }

  seek(position: number): void {
    this.position = position;
    this.peeked = undefined;
    this.second = undefined;
  }

  /** The next token, without consuming it; `position` stays where it is. */
  peek(): Token {
    if (this.peeked === undefined) {
      const { position } = this;
      this.peeked = this.read();
      this.position = position;
    }
    return this.peeked;
  }

  /** The token after the next one, without consuming either; each token is read once, so its warnings are reported once. */
  peekSecond(): Token {
    const first = this.peek();
    if (this.second === undefined) {
      const { position } = this;
      this.position = first.end;
      this.second = this.read();
      this.position = position;
    }
    return this.second;
  }

  next(): Token {
    const token = this.peek();
    this.peeked = this.second;
    this.second = undefined;
    this.position = token.end;
    return token;
  }

  /** Skips white space and comments; ISO 32000-1:2008, 7.2.3: "A conforming reader shall ignore comments, and treat them as single white-space characters." */
  skipWhitespace(): void {
    const { bytes } = this;
    for (;;) {
      const byte = bytes[this.position];
      if (byte === undefined) {
        this.atEnd(this.position);
        return;
      }
      if (isWhitespace(byte)) this.position++;
      else if (byte === 0x25) {
        let index = this.position + 1;
        while (index < bytes.length && bytes[index] !== 0x0a && bytes[index] !== 0x0d) index++;
        this.atEnd(index);
        this.position = index;
      } else return;
    }
  }

  private regularEnd(start: number): number {
    let index = start;
    while (index < this.bytes.length && isRegular(this.bytes[index] ?? 0)) index++;
    this.atEnd(index);
    return index;
  }

  private read(): Token {
    this.skipWhitespace();
    const start = this.position;
    const byte = this.bytes[start];
    if (byte === undefined) return { kind: 'eof', start, end: start };
    if (isRegular(byte)) {
      const end = this.regularEnd(start);
      if (startsNumber(byte)) return numberToken(this.bytes, start, end);
      return { kind: 'keyword', keyword: KEYWORDS.get(latin1(this.bytes, start, end)) ?? 'other', start, end };
    }
    switch (byte) {
      case 0x2f: {
        return this.readName(start);
      }
      case 0x5b: {
        return { kind: 'arrayOpen', start, end: start + 1 };
      }
      case 0x5d: {
        return { kind: 'arrayClose', start, end: start + 1 };
      }
      case 0x28: {
        return this.readLiteralString(start);
      }
      case 0x3c: {
        if (!this.atEnd(start + 1) && this.bytes[start + 1] === 0x3c) return { kind: 'dictionaryOpen', start, end: start + 2 };
        return this.readHexString(start);
      }
      case 0x3e: {
        if (!this.atEnd(start + 1) && this.bytes[start + 1] === 0x3e) return { kind: 'dictionaryClose', start, end: start + 2 };
        break;
      }
      default: {
        break;
      }
    }
    return { kind: 'invalid', reason: 'stray-delimiter', start, end: start + 1 };
  }

  // ISO 32000-1:2008, 7.3.5, rule a): "A NUMBER SIGN (23h) (#) in a name shall be written by using its 2-digit hexadecimal code (23), preceded by the NUMBER SIGN."
  private readName(start: number): Token {
    const end = this.regularEnd(start + 1);
    const { bytes } = this;
    const decoded: number[] = [];
    for (let index = start + 1; index < end; index++) {
      const byte = bytes[index] ?? 0;
      const high = byte === 0x23 && index + 1 < end ? hexValue(bytes[index + 1]) : -1;
      const low = high >= 0 && index + 2 < end ? hexValue(bytes[index + 2]) : -1;
      if (byte !== 0x23) decoded.push(byte);
      else if (low >= 0) {
        decoded.push(high * 16 + low);
        index += 2;
      } else {
        this.warn({ code: 'malformed-name-escape', detail: 'a NUMBER SIGN in a name is not followed by two hexadecimal digits' }, index);
        decoded.push(byte);
      }
    }
    // ISO 32000-1:2008, 7.3.5 excludes the null character from names, and Annex C, Table C.1 limits a name to 127 bytes; both are kept as read.
    if (decoded.includes(0)) this.warn({ code: 'name-contains-null', detail: 'a name contains a null byte' }, start);
    if (decoded.length > 127) this.warn({ code: 'name-too-long', detail: `a name has ${String(decoded.length)} bytes` }, start);
    const candidate = Uint8Array.from(decoded);
    const key = latin1(candidate, 0, candidate.length);
    let interned = this.context.names.get(key);
    if (interned === undefined) {
      interned = candidate;
      this.context.names.set(key, interned);
    }
    return { kind: 'name', bytes: interned, start, end };
  }

  private unterminated(position: number, start: number, what: string): void {
    if (this.atEnd(position)) throw new ParseError(`unterminated ${what}`, this.base + start);
  }

  // ISO 32000-1:2008, 7.3.4.2 defines literal strings: balanced parentheses, the escapes of Table 3, line continuation and end-of-line normalisation.
  private readLiteralString(start: number): Token {
    const { bytes } = this;
    const output = new ByteWriter();
    let depth = 1;
    let index = start + 1;
    for (;;) {
      this.unterminated(index, start, 'literal string');
      const byte = bytes[index] ?? 0;
      index++;
      if (byte === 0x5c) {
        this.unterminated(index, start, 'literal string');
        index = this.readEscape(index, output, start);
      } else if (byte === 0x0d) {
        // "An end-of-line marker appearing within a literal string without a preceding REVERSE SOLIDUS shall be treated as a byte value of (0Ah), irrespective of whether the end-of-line marker was a CARRIAGE RETURN (0Dh), a LINE FEED (0Ah), or both."
        this.unterminated(index, start, 'literal string');
        if (bytes[index] === 0x0a) index++;
        output.writeByte(0x0a);
      } else {
        // "Balanced pairs of parentheses within a string require no special treatment."
        if (byte === 0x28) depth++;
        else if (byte === 0x29) depth--;
        if (depth === 0) break;
        output.writeByte(byte);
      }
    }
    return { kind: 'string', bytes: output.toUint8Array(), encoding: 'literal', start, end: index };
  }

  private readEscape(position: number, output: ByteWriter, start: number): number {
    const { bytes } = this;
    const letter = bytes[position] ?? 0;
    const simple = ESCAPES.get(letter);
    if (simple !== undefined) {
      output.writeByte(simple);
      return position + 1;
    }
    if (letter >= 0x30 && letter <= 0x37) {
      // "The number ddd may consist of one, two, or three octal digits; high-order overflow shall be ignored."
      let value = 0;
      let index = position;
      while (index < position + 3) {
        this.unterminated(index, start, 'literal string');
        const digit = bytes[index] ?? 0;
        if (digit < 0x30 || digit > 0x37) break;
        value = value * 8 + (digit - 0x30);
        index++;
      }
      output.writeByte(value % 256);
      return index;
    }
    // "The REVERSE SOLIDUS (5Ch) (backslash character) at the end of a line shall be used to indicate that the string continues on the following line. A conforming reader shall disregard the REVERSE SOLIDUS and the end-of-line marker following it"
    if (letter === 0x0d) {
      this.unterminated(position + 1, start, 'literal string');
      return bytes[position + 1] === 0x0a ? position + 2 : position + 1;
    }
    if (letter === 0x0a) return position + 1;
    // "If the character following the REVERSE SOLIDUS is not one of those shown in Table 3, the REVERSE SOLIDUS shall be ignored."
    return position;
  }

  // ISO 32000-1:2008, 7.3.4.3: white space is ignored, and "if there is an odd number of digits—the final digit shall be assumed to be 0."
  private readHexString(start: number): Token {
    const { bytes } = this;
    const output = new ByteWriter();
    let high = -1;
    let index = start + 1;
    for (;;) {
      this.unterminated(index, start, 'hexadecimal string');
      const byte = bytes[index] ?? 0;
      index++;
      if (byte === 0x3e) break;
      if (isWhitespace(byte)) continue;
      const value = hexValue(byte);
      if (value < 0) throw new ParseError('invalid digit in a hexadecimal string', this.base + index - 1);
      if (high < 0) high = value;
      else {
        output.writeByte(high * 16 + value);
        high = -1;
      }
    }
    if (high >= 0) output.writeByte(high * 16);
    return { kind: 'string', bytes: output.toUint8Array(), encoding: 'hex', start, end: index };
  }
}

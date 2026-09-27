import type { LoadWarning } from './loadWarning.ts';

import { isRegular, isWhitespace } from './characterClass.ts';
import { WindowEndError } from './windowEndError.ts';

export type Keyword = 'true' | 'false' | 'null' | 'obj' | 'endobj' | 'stream' | 'endstream' | 'R' | 'xref' | 'trailer' | 'startxref' | 'other';

export type InvalidTokenReason = 'malformed-number' | 'integer-out-of-range' | 'real-out-of-range' | 'stray-delimiter';

export type Token =
  | { kind: 'integer'; value: number; start: number; end: number }
  | { kind: 'real'; value: number; start: number; end: number }
  | { kind: 'invalid'; reason: InvalidTokenReason; start: number; end: number }
  | { kind: 'name'; bytes: Uint8Array; start: number; end: number }
  | { kind: 'arrayOpen' | 'arrayClose' | 'dictionaryOpen' | 'dictionaryClose'; start: number; end: number }
  | { kind: 'keyword'; keyword: Keyword; start: number; end: number }
  | { kind: 'eof'; start: number; end: number };

/** Bytes a lexer reads: `base` is the offset of `bytes[0]` in the source, and `final` says whether the source ends where `bytes` ends. */
export interface LexWindow {
  readonly bytes: Uint8Array;
  readonly base: number;
  readonly final: boolean;
}

export interface LexContext {
  readonly warn: (warning: LoadWarning) => void;
  /** Decoded name bytes by their latin1 spelling, so that equal names share one array. */
  readonly names: Map<string, Uint8Array>;
}

const KEYWORDS: ReadonlyMap<string, Keyword> = new Map(
  (['true', 'false', 'null', 'obj', 'endobj', 'stream', 'endstream', 'R', 'xref', 'trailer', 'startxref'] as const).map(keyword => [keyword, keyword]),
);

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
  readonly context: LexContext;
  position: number;
  private peeked: Token | undefined = undefined;

  constructor(window: LexWindow, start: number, context: LexContext) {
    this.bytes = window.bytes;
    this.base = window.base;
    this.final = window.final;
    this.position = start;
    this.context = context;
  }

  /** Returns true at the end of the source and throws WindowEndError at the end of a window that is not. */
  atEnd(position: number): boolean {
    if (position < this.bytes.length) return false;
    if (!this.final) throw new WindowEndError();
    return true;
  }

  warn(warning: Omit<LoadWarning, 'offset'>, position: number): void {
    this.context.warn({ ...warning, offset: this.base + position });
  }

  seek(position: number): void {
    this.position = position;
    this.peeked = undefined;
  }

  peek(): Token {
    this.peeked ??= this.read();
    return this.peeked;
  }

  next(): Token {
    const token = this.peek();
    this.peeked = undefined;
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
      case 0x3c: {
        if (!this.atEnd(start + 1) && this.bytes[start + 1] === 0x3c) return { kind: 'dictionaryOpen', start, end: start + 2 };
        break;
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
}

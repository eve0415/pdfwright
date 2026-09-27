import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { Lexer, Token } from './lexer.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';

/** A parsed value with the span of its bytes in the lexer's buffer; containers also record their children's spans. */
export interface SourceNode {
  readonly value: PdfDirectObject;
  readonly start: number;
  readonly end: number;
  readonly items?: readonly SourceNode[];
  /** Every entry in source order, duplicates included; `value` uses the last occurrence of a key. */
  readonly entries?: readonly SourceEntry[];
}

export interface SourceEntry {
  readonly key: Uint8Array;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly node: SourceNode;
}

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const fail = (lexer: Lexer, message: string, token: Token): never => {
  throw new ParseError(message, lexer.base + token.start);
};

// ISO 32000-1:2008, 7.3.10: an indirect reference is "the object number, the generation number, and the keyword R". A reference to an object that does not exist resolves to null later, so any two integers are kept.
const referenceAfter = (lexer: Lexer, first: Extract<Token, { kind: 'integer' }>): PdfDirectObject => {
  const second = lexer.peek();
  if (second.kind !== 'integer') return { kind: 'integer', value: first.value };
  lexer.next();
  const keyword = lexer.peek();
  if (keyword.kind === 'keyword' && keyword.keyword === 'R') {
    lexer.next();
    return { kind: 'reference', objectNumber: first.value, generation: second.value };
  }
  lexer.seek(first.end);
  return { kind: 'integer', value: first.value };
};

const invalid = (lexer: Lexer, token: Token, reason: Extract<PdfDirectObject, { kind: 'invalid' }>['reason']): PdfDirectObject => {
  const bytes = lexer.bytes.slice(token.start, token.end);
  lexer.warn({ code: 'invalid-token', detail: `kept the token ${latin1(bytes)} as raw bytes (${reason})` }, token.start);
  return { kind: 'invalid', bytes, reason };
};

const checkDepth = (depth: number, maxNesting: number): void => {
  // House limit, not a PDF rule: nesting deeper than maxNesting is refused so that hostile input cannot exhaust the stack.
  if (depth > maxNesting) throw new ResourceLimitError(`arrays and dictionaries are nested deeper than maxNesting (${String(maxNesting)})`);
};

class DirectObjectParser {
  private readonly lexer: Lexer;
  private readonly maxNesting: number;

  constructor(lexer: Lexer, maxNesting: number) {
    this.lexer = lexer;
    this.maxNesting = maxNesting;
  }

  node(token: Token, depth: number): SourceNode {
    if (token.kind === 'arrayOpen') return this.annotatedArray(token.start, depth + 1);
    if (token.kind === 'dictionaryOpen') return this.annotatedDictionary(token.start, depth + 1);
    const value = this.value(token, depth);
    return { value, start: token.start, end: this.lexer.position };
  }

  value(token: Token, depth: number): PdfDirectObject {
    const { lexer } = this;
    switch (token.kind) {
      case 'integer': {
        return referenceAfter(lexer, token);
      }
      case 'real': {
        return { kind: 'real', value: token.value };
      }
      case 'name': {
        return { kind: 'name', bytes: token.bytes };
      }
      case 'string': {
        return { kind: 'string', bytes: token.bytes, encoding: token.encoding };
      }
      case 'invalid': {
        if (token.reason === 'stray-delimiter') return fail(lexer, 'unexpected delimiter', token);
        return invalid(lexer, token, token.reason);
      }
      case 'keyword': {
        if (token.keyword === 'true' || token.keyword === 'false') return { kind: 'boolean', value: token.keyword === 'true' };
        if (token.keyword === 'null') return { kind: 'null' };
        if (token.keyword === 'other') return invalid(lexer, token, 'unknown-keyword');
        return fail(lexer, `unexpected keyword ${token.keyword}`, token);
      }
      case 'arrayOpen': {
        return this.array(depth + 1);
      }
      case 'dictionaryOpen': {
        return this.dictionary(depth + 1);
      }
      case 'arrayClose': {
        return fail(lexer, 'unexpected end of array', token);
      }
      case 'dictionaryClose': {
        return fail(lexer, 'unexpected end of dictionary', token);
      }
      case 'eof': {
        return fail(lexer, 'unexpected end of data', token);
      }
      default: {
        return fail(lexer, 'unexpected token', token);
      }
    }
  }

  private annotatedArray(start: number, depth: number): SourceNode {
    checkDepth(depth, this.maxNesting);
    const items: SourceNode[] = [];
    for (let token = this.lexer.next(); token.kind !== 'arrayClose'; token = this.lexer.next()) items.push(this.node(token, depth));
    return { value: { kind: 'array', items: items.map(item => item.value) }, start, end: this.lexer.position, items };
  }

  private annotatedDictionary(start: number, depth: number): SourceNode {
    checkDepth(depth, this.maxNesting);
    const entries: SourceEntry[] = [];
    this.entries((key, token) => {
      entries.push({ key: key.bytes, keyStart: key.start, keyEnd: key.end, node: this.node(token, depth) });
    });
    const value = parsedDictionaryEntries(entries.map(({ key, node }) => [key, node.value] as const));
    return { value: { kind: 'dictionary', entries: value }, start, end: this.lexer.position, entries };
  }

  private entries(read: (key: Extract<Token, { kind: 'name' }>, token: Token) => void): void {
    const { lexer } = this;
    const seen = new Set<Uint8Array>();
    for (let key = lexer.next(); key.kind !== 'dictionaryClose'; key = lexer.next()) {
      if (key.kind === 'eof') fail(lexer, 'unexpected end of data', key);
      if (key.kind !== 'name') return fail(lexer, 'a dictionary key must be a name', key);
      const token = lexer.next();
      if (token.kind === 'dictionaryClose') fail(lexer, 'a dictionary key has no value', token);
      if (seen.has(key.bytes)) lexer.warn({ code: 'duplicate-key', detail: `duplicate dictionary key /${latin1(key.bytes)}` }, key.start);
      seen.add(key.bytes);
      read(key, token);
    }
    return undefined;
  }

  // ISO 32000-1:2008, 7.3.6: "An array shall be written as a sequence of objects enclosed in SQUARE BRACKETS (using LEFT SQUARE BRACKET (5Bh) and RIGHT SQUARE BRACKET (5Dh))."
  private array(depth: number): PdfDirectObject {
    checkDepth(depth, this.maxNesting);
    const items: PdfDirectObject[] = [];
    for (let token = this.lexer.next(); token.kind !== 'arrayClose'; token = this.lexer.next()) items.push(this.value(token, depth));
    return { kind: 'array', items };
  }

  // ISO 32000-1:2008, 7.3.7: "The first element of each entry is the key and the second element is the value. The key shall be a name".
  // "Multiple entries in the same dictionary shall not have the same key." When they do, the last one is used and a warning names it.
  private dictionary(depth: number): PdfDirectObject {
    checkDepth(depth, this.maxNesting);
    const entries: [Uint8Array, PdfDirectObject][] = [];
    this.entries((key, token) => {
      entries.push([key.bytes, this.value(token, depth)]);
    });
    return { kind: 'dictionary', entries: parsedDictionaryEntries(entries) };
  }
}

/** Parses one direct object at the lexer's position; names are interned by the lexer, so equal keys share one array. */
export const parseObject = (lexer: Lexer, maxNesting: number): PdfDirectObject => new DirectObjectParser(lexer, maxNesting).value(lexer.next(), 0);

/** Parses one direct object like parseObject and records the byte span of every value, for copying unchanged parts verbatim. */
export const parseAnnotated = (lexer: Lexer, maxNesting: number): SourceNode => new DirectObjectParser(lexer, maxNesting).node(lexer.next(), 0);

import { RefusalError } from './xmlRefusal.ts';

/** A range of the decoded text, as UTF-16 code unit offsets: start inclusive, end exclusive. */
export interface XmlSpan {
  readonly start: number;
  readonly end: number;
}

export interface XmlAttribute {
  /** The qualified name as written, prefix included. */
  readonly name: string;
  /** The value with references expanded and white space normalized. */
  readonly value: string;
  /** From the first character of the name to the closing quote. */
  readonly span: XmlSpan;
}

export type XmlToken =
  | { readonly kind: 'start'; readonly name: string; readonly attributes: readonly XmlAttribute[]; readonly selfClosing: boolean; readonly span: XmlSpan }
  | { readonly kind: 'end'; readonly name: string; readonly span: XmlSpan }
  | { readonly kind: 'text'; readonly text: string; readonly span: XmlSpan }
  | { readonly kind: 'cdata'; readonly text: string; readonly span: XmlSpan }
  | { readonly kind: 'comment'; readonly span: XmlSpan }
  | { readonly kind: 'pi'; readonly target: string; readonly content: string; readonly span: XmlSpan };

/** Why text is not read: a DOCTYPE declaration, an entity other than the five predefined ones, a limit, or text that is not well-formed XML. */
export type XmlRefusal = 'doctype' | 'undefined-entity' | 'too-deep' | 'too-many-attributes' | 'invalid-character' | 'not-well-formed';

export type XmlTokens =
  | { readonly ok: true; readonly tokens: readonly XmlToken[] }
  | { readonly ok: false; readonly reason: XmlRefusal; readonly offset: number };

export interface XmlLimits {
  /** Deepest element nesting; default 64. */
  readonly maxDepth: number;
  /** Most attributes on one element; default 256. */
  readonly maxAttributes: number;
}

const DEFAULT_LIMITS: XmlLimits = { maxDepth: 64, maxAttributes: 256 };

// XML 1.0 (Fifth Edition), 2.2, production [2] Char: tab, line feed, carriage return, and the scalar values from U+0020 other than surrogates, U+FFFE and U+FFFF.
const INVALID_CHARACTER = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u;
// XML 1.0, 2.3, productions [4] and [4a], widened to every character from U+0080, since a name only has to be matched against its closing tag and namespace declarations.
const NAME = /[A-Za-z_:\u0080-\u{10FFFF}][\w.:\u0080-\u{10FFFF}-]*/uy;
const SPACE = /[ \t\r\n]*/uy;
// XML 1.0, 4.6: the five predefined entities.
const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['apos', "'"],
  ['quot', '"'],
]);

const isCharacter = (code: number): boolean => !INVALID_CHARACTER.test(String.fromCodePoint(code));

// XML 1.0, 4.1, production [66] CharRef: '&#' [0-9]+ ';' | '&#x' [0-9a-fA-F]+ ';', so any number of leading zeros, and the number must name a Char.
const characterReference = (name: string): number | undefined => {
  const decimal = /^#(\d+)$/u.exec(name);
  if (decimal !== null) return Number(decimal[1]);
  const hex = /^#x([\dA-Fa-f]+)$/u.exec(name);
  return hex === null ? undefined : Number.parseInt(hex[1] ?? '', 16);
};

/** Expands character and predefined entity references in `raw`, whose first character is at `offset` of the text. */
const expandReferences = (raw: string, offset: number): string => {
  let result = '';
  let from = 0;
  for (let at = raw.indexOf('&'); at !== -1; at = raw.indexOf('&', from)) {
    result += raw.slice(from, at);
    const end = raw.indexOf(';', at);
    if (end === -1) throw new RefusalError('not-well-formed', offset + at);
    const name = raw.slice(at + 1, end);
    const code = characterReference(name);
    if (code === undefined) {
      const replacement = PREDEFINED.get(name);
      if (replacement === undefined) throw new RefusalError(/^[A-Za-z_:]/u.test(name) ? 'undefined-entity' : 'not-well-formed', offset + at);
      result += replacement;
    } else {
      if (code > 0x10ffff || !isCharacter(code)) throw new RefusalError('invalid-character', offset + at);
      result += String.fromCodePoint(code);
    }
    from = end + 1;
  }
  return result + raw.slice(from);
};

// XML 1.0, 2.11: every CR LF pair and every CR not followed by LF reads as LF.
const normalizeLineEnds = (text: string): string => text.replaceAll(/\r\n?/gu, '\n');

class Tokenizer {
  private readonly text: string;
  private readonly limits: XmlLimits;
  private readonly tokens: XmlToken[] = [];
  private readonly open: string[] = [];
  private position = 0;
  private rootClosed = false;
  private rootSeen = false;

  constructor(text: string, limits: XmlLimits) {
    this.text = text;
    this.limits = limits;
  }

  private match(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.position;
    const found = pattern.exec(this.text);
    if (found === null) return undefined;
    this.position = pattern.lastIndex;
    return found[0];
  }

  private expect(literal: string): void {
    if (!this.text.startsWith(literal, this.position)) throw new RefusalError('not-well-formed', this.position);
    this.position += literal.length;
  }

  private name(): string {
    const name = this.match(NAME);
    if (name === undefined || name === '') throw new RefusalError('not-well-formed', this.position);
    return name;
  }

  private until(terminator: string): number {
    const end = this.text.indexOf(terminator, this.position);
    if (end === -1) throw new RefusalError('not-well-formed', this.position);
    return end;
  }

  private attribute(): XmlAttribute {
    const start = this.position;
    const name = this.name();
    this.match(SPACE);
    this.expect('=');
    this.match(SPACE);
    const quote = this.text[this.position];
    if (quote !== '"' && quote !== "'") throw new RefusalError('not-well-formed', this.position);
    this.position++;
    const end = this.until(quote);
    const raw = this.text.slice(this.position, end);
    if (raw.includes('<')) throw new RefusalError('not-well-formed', this.position + raw.indexOf('<'));
    // XML 1.0, 3.3.3: each literal white space character of an attribute value reads as a space.
    const value = expandReferences(raw.replaceAll(/\r\n|[\t\n\r]/gu, ' '), this.position);
    this.position = end + 1;
    return { name, value, span: { start, end: this.position } };
  }

  private startTag(): void {
    const start = this.position;
    if (this.rootClosed) throw new RefusalError('not-well-formed', start);
    this.position++;
    const name = this.name();
    const attributes: XmlAttribute[] = [];
    for (;;) {
      const space = this.match(SPACE) ?? '';
      if (this.text.startsWith('/>', this.position) || this.text.startsWith('>', this.position)) break;
      if (space === '') throw new RefusalError('not-well-formed', this.position);
      const attribute = this.attribute();
      // XML 1.0, 3.1, well-formedness constraint Unique Att Spec.
      if (attributes.some(other => other.name === attribute.name)) throw new RefusalError('not-well-formed', attribute.span.start);
      attributes.push(attribute);
      if (attributes.length > this.limits.maxAttributes) throw new RefusalError('too-many-attributes', attribute.span.start);
    }
    const selfClosing = this.text.startsWith('/>', this.position);
    this.position += selfClosing ? 2 : 1;
    this.tokens.push({ kind: 'start', name, attributes, selfClosing, span: { start, end: this.position } });
    this.rootSeen = true;
    if (selfClosing) {
      if (this.open.length === 0) this.rootClosed = true;
      return;
    }
    this.open.push(name);
    if (this.open.length > this.limits.maxDepth) throw new RefusalError('too-deep', start);
  }

  private endTag(): void {
    const start = this.position;
    this.position += 2;
    const name = this.name();
    this.match(SPACE);
    this.expect('>');
    // XML 1.0, 3, well-formedness constraint Element Type Match.
    if (this.open.pop() !== name) throw new RefusalError('not-well-formed', start);
    if (this.open.length === 0) this.rootClosed = true;
    this.tokens.push({ kind: 'end', name, span: { start, end: this.position } });
  }

  private markup(): void {
    const start = this.position;
    const { text } = this;
    if (text.startsWith('<!--', start)) {
      this.position += 4;
      const end = this.until('-->');
      // XML 1.0, 2.5: two hyphens in a row may not occur inside a comment.
      if (text.slice(this.position, end).includes('--')) throw new RefusalError('not-well-formed', start);
      this.position = end + 3;
      this.tokens.push({ kind: 'comment', span: { start, end: this.position } });
    } else if (text.startsWith('<![CDATA[', start)) {
      if (this.open.length === 0) throw new RefusalError('not-well-formed', start);
      this.position += 9;
      const end = this.until(']]>');
      const data = normalizeLineEnds(text.slice(this.position, end));
      this.position = end + 3;
      this.tokens.push({ kind: 'cdata', text: data, span: { start, end: this.position } });
    } else if (text.startsWith('<!DOCTYPE', start)) {
      // A document type declaration can declare entities, including external ones; none is read.
      throw new RefusalError('doctype', start);
    } else if (text.startsWith('<?', start)) {
      this.position += 2;
      const target = this.name();
      const end = this.until('?>');
      const content = text.slice(this.position, end).replace(/^[ \t\r\n]+/u, '');
      this.position = end + 2;
      this.tokens.push({ kind: 'pi', target, content, span: { start, end: this.position } });
    } else if (text.startsWith('</', start)) this.endTag();
    else if (text.startsWith('<!', start)) throw new RefusalError('not-well-formed', start);
    else this.startTag();
  }

  private characterData(): void {
    const start = this.position;
    const end = this.text.indexOf('<', start);
    this.position = end === -1 ? this.text.length : end;
    const raw = this.text.slice(start, this.position);
    // XML 1.0, 2.8 and 2.1: only white space (and a leading byte-order mark) may stand outside the root element.
    if (this.open.length === 0) {
      const blank = start === 0 ? raw.replace(/^\u{FEFF}/u, '') : raw;
      if (!/^[ \t\r\n]*$/u.test(blank)) throw new RefusalError('not-well-formed', start);
      return;
    }
    if (raw.includes(']]>')) throw new RefusalError('not-well-formed', start + raw.indexOf(']]>'));
    this.tokens.push({ kind: 'text', text: expandReferences(normalizeLineEnds(raw), start), span: { start, end: this.position } });
  }

  run(): readonly XmlToken[] {
    const invalid = INVALID_CHARACTER.exec(this.text);
    if (invalid !== null) throw new RefusalError('invalid-character', invalid.index);
    while (this.position < this.text.length) {
      if (this.text[this.position] === '<') this.markup();
      else this.characterData();
    }
    if (this.open.length > 0 || !this.rootSeen) throw new RefusalError('not-well-formed', this.text.length);
    return this.tokens;
  }
}

/**
 * Tokenizes XML text without validating it and without a document type: a DOCTYPE declaration is refused, so no entity is ever declared, and only the five predefined entities and character references are expanded.
 * Element nesting and attributes per element are limited; the scan is a loop over the text, never recursion.
 * The text must hold one root element, with only white space, comments and processing instructions around it.
 */
export const tokenizeXml = (text: string, limits: XmlLimits = DEFAULT_LIMITS): XmlTokens => {
  try {
    return { ok: true, tokens: new Tokenizer(text, limits).run() };
  } catch (error: unknown) {
    if (error instanceof RefusalError) return { ok: false, reason: error.reason, offset: error.offset };
    throw error;
  }
};

export type XmlEncoding = 'utf8' | 'utf-16be' | 'utf-16le' | 'utf-32be' | 'utf-32le';

export type DecodedXml = { readonly ok: true; readonly text: string; readonly encoding: XmlEncoding } | { readonly ok: false; readonly reason: 'undecodable' };

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean => prefix.every((byte, index) => bytes[index] === byte);

// XML 1.0, Appendix F.1: a byte-order mark, or else the bytes of "<" in each encoding, tell the encoding; anything else reads as UTF-8.
const detectEncoding = (bytes: Uint8Array): XmlEncoding => {
  if (startsWith(bytes, [0x00, 0x00, 0xfe, 0xff]) || startsWith(bytes, [0x00, 0x00, 0x00, 0x3c])) return 'utf-32be';
  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) || startsWith(bytes, [0x3c, 0x00, 0x00, 0x00])) return 'utf-32le';
  if (startsWith(bytes, [0xfe, 0xff]) || startsWith(bytes, [0x00, 0x3c, 0x00, 0x3f])) return 'utf-16be';
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0x3c, 0x00, 0x3f, 0x00])) return 'utf-16le';
  return 'utf8';
};

// The WHATWG Encoding Standard defines no UTF-32 decoder, and TextDecoder('utf-32') throws on every runtime, so UTF-32 is decoded here.
const decodeUtf32 = (bytes: Uint8Array, bigEndian: boolean): string | undefined => {
  if (bytes.length % 4 !== 0) return undefined;
  let text = '';
  for (let index = 0; index < bytes.length; index += 4) {
    const [first = 0, second = 0, third = 0, fourth = 0] = bigEndian ? bytes.subarray(index, index + 4) : bytes.subarray(index, index + 4).toReversed();
    const code = ((first * 256 + second) * 256 + third) * 256 + fourth;
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
    text += String.fromCodePoint(code);
  }
  return text;
};

/**
 * Decodes XML bytes as UTF-8, UTF-16 or UTF-32, by a leading byte-order mark or the encoding of the first "<", and refuses bytes that are not valid in that encoding.
 * A byte-order mark stays in the text as U+FEFF, so that offsets in the text map back to the bytes and unchanged text encodes back to the same bytes.
 */
export const decodeXml = (bytes: Uint8Array): DecodedXml => {
  const encoding = detectEncoding(bytes);
  if (encoding === 'utf-32be' || encoding === 'utf-32le') {
    const text = decodeUtf32(bytes, encoding === 'utf-32be');
    return text === undefined ? { ok: false, reason: 'undecodable' } : { ok: true, text, encoding };
  }
  try {
    return { ok: true, text: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes), encoding };
  } catch (error: unknown) {
    if (error instanceof TypeError) return { ok: false, reason: 'undecodable' };
    throw error;
  }
};

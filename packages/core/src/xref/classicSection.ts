import type { ByteSource } from '../parse/byteSource.ts';
import type { IndirectObjectContext } from '../parse/indirectObject.ts';
import type { Token } from '../parse/lexer.ts';
import type { XrefEntry, XrefSection } from './xrefSection.ts';

import { ParseError } from '../error/parseError.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';

import { MAX_GENERATION, MAX_OBJECT_NUMBER } from './xrefSection.ts';

export interface ClassicSection extends XrefSection {
  readonly kind: 'classic';
  /** The distinct entry lengths found, end-of-line included; ISO 32000-1:2008, 7.5.4 requires 20. */
  readonly entryLengths: readonly number[];
}

const isKeyword = (token: Token, keyword: string): boolean => token.kind === 'keyword' && token.keyword === keyword;

const entryType = (lexer: Lexer, token: Token): 'free' | 'file' | undefined => {
  if (token.kind !== 'keyword' || token.keyword !== 'other' || token.end - token.start !== 1) return undefined;
  const letter = lexer.bytes[token.start];
  if (letter === 0x6e) return 'file';
  return letter === 0x66 ? 'free' : undefined;
};

// ISO 32000-1:2008, 7.5.4: "Each cross-reference section shall begin with a line containing the keyword xref. Following this line shall be one or more cross-reference subsections".
// Entries are read as tokens rather than fixed 20-byte slices, so entries with other line ends parse too; their lengths are reported.
const parseSection = (lexer: Lexer, maxNesting: number): ClassicSection => {
  lexer.skipWhitespace();
  const offset = lexer.base + lexer.position;
  if (!isKeyword(lexer.next(), 'xref')) throw new ParseError('expected the keyword xref', offset);
  const entries: XrefEntry[] = [];
  const lengths = new Set<number>();
  let previousStart: number | undefined = undefined;
  for (let token = lexer.next(); !isKeyword(token, 'trailer'); token = lexer.next()) {
    const count = lexer.next();
    if (token.kind !== 'integer' || count.kind !== 'integer' || token.value < 0 || count.value < 0 || token.value + count.value - 1 > MAX_OBJECT_NUMBER) {
      throw new ParseError('malformed cross-reference subsection header', lexer.base + token.start);
    }
    if (previousStart !== undefined) lengths.add(token.start - previousStart);
    previousStart = undefined;
    for (let index = 0; index < count.value; index++) {
      const location = lexer.next();
      const generation = lexer.next();
      const type = entryType(lexer, lexer.next());
      if (
        location.kind !== 'integer' ||
        generation.kind !== 'integer' ||
        type === undefined ||
        location.value < 0 ||
        generation.value < 0 ||
        generation.value > MAX_GENERATION
      ) {
        throw new ParseError('malformed cross-reference entry', lexer.base + location.start);
      }
      if (previousStart !== undefined) lengths.add(location.start - previousStart);
      previousStart = location.start;
      entries.push({ objectNumber: token.value + index, type, location: location.value, generation: generation.value });
    }
    lexer.skipWhitespace();
  }
  if (previousStart !== undefined) {
    // The last entry ends where the keyword trailer starts; the lexer is just past that keyword.
    lengths.add(lexer.position - 'trailer'.length - previousStart);
  }
  const trailerToken = lexer.peek();
  const trailer = parseObject(lexer, maxNesting);
  if (trailer.kind !== 'dictionary') throw new ParseError('the trailer is not a dictionary', lexer.base + trailerToken.start);
  return {
    kind: 'classic',
    offset,
    entries,
    trailer: trailer.entries,
    trailerStart: lexer.base + trailerToken.start,
    trailerEnd: lexer.base + lexer.position,
    entryLengths: [...lengths].toSorted((left, right) => left - right),
  };
};

/** Reads the classic cross-reference section whose keyword xref is at `offset`, after any white space. */
export const readClassicSection = (source: ByteSource, offset: number, context: IndirectObjectContext): ClassicSection =>
  source.parseAt(offset, context, (window, local, lexContext) => {
    const lexer = new Lexer(window, local, lexContext);
    return parseSection(lexer, context.maxNesting);
  });

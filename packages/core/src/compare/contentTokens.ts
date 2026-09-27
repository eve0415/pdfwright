import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LexContext, Token } from '../parse/lexer.ts';

import { inlineImageData } from '../content/inlineImageData.ts';
import { ParseError } from '../error/parseError.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';

const quiet = (): LexContext => ({
  warn: (): void => {
    // Content is compared, not validated; malformed operands compare by their bytes.
  },
  names: new Map(),
});

const hex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
};

// Operands compare by value: numbers by value whether integer or real, names and strings by their decoded bytes, dictionaries regardless of key order.
const canonical = (value: PdfDirectObject): string => {
  switch (value.kind) {
    case 'integer':
    case 'real': {
      return `n${String(typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator))}`;
    }
    case 'name': {
      return `/${hex(value.bytes)}`;
    }
    case 'string': {
      return `(${hex(value.bytes)})`;
    }
    case 'invalid': {
      return `?${hex(value.bytes)}`;
    }
    case 'array': {
      return `[${value.items.map(item => canonical(item)).join(' ')}]`;
    }
    case 'dictionary': {
      const entries = [...value.entries.entries()].map(([key, item]) => `/${hex(key)} ${canonical(item)}`);
      return `<<${entries.toSorted().join(' ')}>>`;
    }
    case 'boolean': {
      return value.value ? 'true' : 'false';
    }
    case 'reference': {
      return `r${String(value.objectNumber)}.${String(value.generation)}`;
    }
    case 'null': {
      return 'null';
    }
    default: {
      return 'null';
    }
  }
};

const operatorText = (lexer: Lexer, token: Token): string => new TextDecoder('latin1').decode(lexer.bytes.subarray(token.start, token.end));

/**
 * Splits content into operations, each its operands followed by its operator, as canonical text that ignores white space, comments and number spellings; operations compare as exact text.
 * ISO 32000-1:2008, 7.8.2: "A content stream is a PDF stream object whose data consists of a sequence of instructions describing the graphical elements to be painted on a page."
 * Throws ParseError for operands that cannot be read, such as an unterminated string.
 */
export const contentOperations = (bytes: Uint8Array, maxNesting: number): string[] => {
  const lexer = new Lexer({ bytes, base: 0, final: true }, 0, quiet());
  const operations: string[] = [];
  let operands: string[] = [];
  let imageParameters: PdfDirectObject[] = [];
  for (let token = lexer.peek(); token.kind !== 'eof'; token = lexer.peek()) {
    if (token.kind === 'keyword' && token.keyword !== 'true' && token.keyword !== 'false' && token.keyword !== 'null') {
      lexer.next();
      const operator = operatorText(lexer, token);
      if (operator === 'ID') operands.push(`ID${hex(inlineImageData(lexer, imageParameters))}`);
      operations.push(`${operands.join(' ')} ${operator}`);
      operands = [];
      imageParameters = [];
    } else if (token.kind === 'invalid' || token.kind === 'arrayClose' || token.kind === 'dictionaryClose') {
      lexer.next();
      operands.push(`?${hex(bytes.subarray(token.start, token.end))}`);
    } else {
      const value = parseObject(lexer, maxNesting);
      operands.push(canonical(value));
      imageParameters.push(value);
    }
  }
  if (operands.length > 0) operations.push(operands.join(' '));
  return operations;
};

export type ContentOperations = { readonly ok: true; readonly operations: readonly string[] } | { readonly ok: false; readonly reason: string };

/** The operations of decoded content, or why they cannot be read; resource limits propagate. */
export const readOperations = (bytes: Uint8Array, maxNesting: number): ContentOperations => {
  try {
    return { ok: true, operations: contentOperations(bytes, maxNesting) };
  } catch (error: unknown) {
    if (error instanceof ParseError) return { ok: false, reason: error.message };
    throw error;
  }
};

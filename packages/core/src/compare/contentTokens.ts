import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LexContext, Token } from '../parse/lexer.ts';

import { ParseError } from '../error/parseError.ts';
import { isWhitespace } from '../parse/characterClass.ts';
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

const inlineParameter = (values: readonly PdfDirectObject[], names: readonly string[]): PdfDirectObject | undefined => {
  for (let index = 0; index + 1 < values.length; index += 2) {
    const key = values[index];
    if (key?.kind === 'name' && names.includes(new TextDecoder('latin1').decode(key.bytes))) return values[index + 1];
  }
  return undefined;
};

const COMPONENTS = new Map([
  ['G', 1],
  ['DeviceGray', 1],
  ['RGB', 3],
  ['DeviceRGB', 3],
  ['CMYK', 4],
  ['DeviceCMYK', 4],
  ['I', 1],
  ['Indexed', 1],
]);

const imageComponents = (mask: PdfDirectObject | undefined, space: PdfDirectObject | undefined): number | undefined => {
  if (mask?.kind === 'boolean' && mask.value) return 1;
  return space?.kind === 'name' ? COMPONENTS.get(new TextDecoder('latin1').decode(space.bytes)) : undefined;
};

const imageBits = (mask: PdfDirectObject | undefined, bits: PdfDirectObject | undefined): number | undefined => {
  if (bits?.kind === 'integer') return bits.value;
  return mask?.kind === 'boolean' && mask.value ? 1 : undefined;
};

// ISO 32000-1:2008, 8.9.3 pads each sample row to a byte boundary; 8.9.7, Table 93 gives inline image width, height, bits, colour space and filter keys.
const unfilteredImageLength = (parameters: readonly PdfDirectObject[]): number | undefined => {
  if (parameters.length % 2 !== 0 || inlineParameter(parameters, ['F', 'Filter']) !== undefined) return undefined;
  const width = inlineParameter(parameters, ['W', 'Width']);
  const height = inlineParameter(parameters, ['H', 'Height']);
  const mask = inlineParameter(parameters, ['IM', 'ImageMask']);
  const bits = inlineParameter(parameters, ['BPC', 'BitsPerComponent']);
  const space = inlineParameter(parameters, ['CS', 'ColorSpace']);
  const components = imageComponents(mask, space);
  const perComponent = imageBits(mask, bits);
  if (width?.kind !== 'integer' || height?.kind !== 'integer' || components === undefined || perComponent === undefined) return undefined;
  if (width.value <= 0 || height.value <= 0 || ![1, 2, 4, 8, 16].includes(perComponent)) return undefined;
  const rowBits = width.value * components * perComponent;
  const length = Math.ceil(rowBits / 8) * height.value;
  return Number.isSafeInteger(rowBits) && Number.isSafeInteger(length) ? length : undefined;
};

const exactInlineEnd = (bytes: Uint8Array, start: number, length: number): number | undefined => {
  if (start + length >= bytes.length) return undefined;
  let end = start + length;
  while (end < bytes.length && isWhitespace(bytes[end] ?? 0)) end++;
  return end > start + length && bytes[end] === 0x45 && bytes[end + 1] === 0x49 && (end + 2 >= bytes.length || isWhitespace(bytes[end + 2] ?? 0))
    ? end + 2
    : undefined;
};

// ISO 32000-1:2008, 8.9.7: "Unless the image uses ASCIIHexDecode or ASCII85Decode as one of its filters, the ID operator shall be followed by a single white-space character, and the next character shall be interpreted as the first byte of image data."
const inlineImageData = (lexer: Lexer, parameters: readonly PdfDirectObject[]): string => {
  const { bytes } = lexer;
  const start = lexer.position + (isWhitespace(bytes[lexer.position] ?? 0) ? 1 : 0);
  const length = unfilteredImageLength(parameters);
  const exact = length === undefined ? undefined : exactInlineEnd(bytes, start, length);
  if (exact !== undefined && length !== undefined) {
    lexer.seek(exact);
    return hex(bytes.subarray(start, start + length));
  }
  for (let position = start; position + 1 < bytes.length; position++) {
    if (
      bytes[position] === 0x45 &&
      bytes[position + 1] === 0x49 &&
      isWhitespace(bytes[position - 1] ?? 0x20) &&
      (position + 2 >= bytes.length || isWhitespace(bytes[position + 2] ?? 0x20))
    ) {
      lexer.seek(position + 2);
      return hex(bytes.subarray(start, Math.max(start, position - 1)));
    }
  }
  lexer.seek(bytes.length);
  return hex(bytes.subarray(start));
};

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
      if (operator === 'ID') operands.push(`ID${inlineImageData(lexer, imageParameters)}`);
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

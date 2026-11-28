import { ParseError } from '@pdfwright/core';

/** One CR-terminated text line, or the binary colour and alpha planes of a raster, with the byte offset where it starts in the native data. */
export type NativeRecord =
  | { readonly kind: 'line'; readonly text: string; readonly offset: number }
  | { readonly kind: 'rasterData'; readonly color: Uint8Array; readonly alpha: Uint8Array; readonly offset: number };

const decoder = new TextDecoder();
const RASTER_SIZE = /\]\s+0 0\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+8\s+\d+\s+1\s+/u;
const BEGIN_DATA = /^%%BeginData: (\d+)$/u;

/** Reads CR records while treating the colour and alpha planes following `XI\n` as binary. */
export const tokenizeNative = (bytes: Uint8Array): Array<NativeRecord> => {
  const records: Array<NativeRecord> = [];
  let position = 0;
  let rasterPixels: number | undefined;
  while (position < bytes.length) {
    const start = position;
    while (position < bytes.length && bytes[position] !== 13) {
      position++;
    }
    if (position >= bytes.length) {
      throw new ParseError('native line is missing its closing CR', start);
    }
    const line = decoder.decode(bytes.subarray(start, position));
    records.push({ kind: 'line', text: line, offset: start });
    position++;
    const dimensions = RASTER_SIZE.exec(line);
    if (dimensions !== null) {
      rasterPixels = Number(dimensions[1]) * Number(dimensions[2]);
    }
    const begin = BEGIN_DATA.exec(line);
    if (begin === null) {
      continue;
    }
    const count = Number(begin[1]);
    if (!Number.isSafeInteger(count) || count < 3 || rasterPixels === undefined) {
      throw new ParseError('invalid raster data count', start);
    }
    if (bytes[position] !== 88 || bytes[position + 1] !== 73 || bytes[position + 2] !== 10) {
      throw new ParseError('raster data must start with XI LF', position);
    }
    const colorStart = position + 3;
    const alphaStart = colorStart + count - 3;
    const end = alphaStart + rasterPixels;
    if (end > bytes.length) {
      throw new ParseError('truncated raster data', bytes.length);
    }
    records.push({ kind: 'rasterData', color: bytes.slice(colorStart, alphaStart), alpha: bytes.slice(alphaStart, end), offset: position });
    position = end;
  }
  return records;
};

// PostScript Language Reference, 3.2.2: the escapes that stand for a control character.
const LETTER_ESCAPES: ReadonlyMap<string, number> = new Map([
  ['n', 10],
  ['r', 13],
  ['t', 9],
  ['b', 8],
  ['f', 12],
]);
const encoder = new TextEncoder();
// A name's bytes are UTF-8, and a byte order mark at their start is part of the name.
const nameDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

const octalDigit = (character: string): number | undefined => {
  const code = character.charCodeAt(0) - 48;
  return code >= 0 && code <= 7 ? code : undefined;
};

const appendUtf8 = (bytes: Array<number>, text: string): void => {
  for (const byte of encoder.encode(text)) {
    bytes.push(byte);
  }
};

/** Unescapes one PostScript literal string used for a name in native data; `offset` locates the line holding it for a `ParseError`. */
export const parseNativeLiteral = (literal: string, offset: number): string => {
  if (!literal.startsWith('(') || !literal.endsWith(')')) {
    throw new ParseError('expected a PostScript literal string', offset);
  }
  const end = literal.length - 1;
  if (!literal.includes('\\')) {
    return literal.slice(1, end);
  }
  // An octal escape codes one byte of the name rather than a character, so the name is rebuilt as bytes.
  const bytes: Array<number> = [];
  let run = 1;
  for (let index = 1; index < end; index++) {
    if (literal.charAt(index) !== '\\') {
      continue;
    }
    appendUtf8(bytes, literal.slice(run, index));
    index++;
    // A backslash before the final parenthesis escapes it, so nothing closes the string.
    if (index === end) {
      throw new ParseError('unterminated PostScript literal string', offset);
    }
    // PostScript Language Reference, 3.2.2: \ddd is one to three octal digits with high-order overflow ignored, \n, \r, \t, \b and \f are control characters, a backslash before a line feed is dropped with it, and a backslash before any other character is dropped.
    let code = 0;
    let digits = 0;
    let digit = octalDigit(literal.charAt(index));
    while (digit !== undefined && digits < 3) {
      code = code * 8 + digit;
      digits++;
      index++;
      digit = octalDigit(literal.charAt(index));
    }
    if (digits > 0) {
      bytes.push(code % 256);
      run = index;
      index--;
      continue;
    }
    const escaped = literal.charAt(index);
    const letter = LETTER_ESCAPES.get(escaped);
    if (letter !== undefined) {
      bytes.push(letter);
    }
    run = letter !== undefined || escaped === '\n' ? index + 1 : index;
  }
  appendUtf8(bytes, literal.slice(run, end));
  return nameDecoder.decode(Uint8Array.from(bytes));
};

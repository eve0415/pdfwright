import { ParseError } from '@pdfwright/core';

/** One CR-terminated text line, or the binary colour and alpha planes of a raster, with the byte offset where it starts in the native data. */
export type NativeRecord =
  | { readonly kind: 'line'; readonly text: string; readonly offset: number }
  | { readonly kind: 'rasterData'; readonly color: Uint8Array; readonly alpha: Uint8Array; readonly offset: number };

const decoder = new TextDecoder();
const RASTER_SIZE = /\]\s+0 0\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+8\s+\d+\s+1\s+/u;
const BEGIN_DATA = /^%%BeginData: (\d+)$/u;

const octalDigit = (code: number | undefined): number | undefined => (code !== undefined && code >= 48 && code <= 55 ? code - 48 : undefined);

interface Line {
  readonly text: string;
  /** The offset of the CR that ends the line. */
  readonly end: number;
}

// PostScript Language Reference, 3.2.2: inside a literal string, a backslash before an end-of-line marker (CR, LF or CR LF) is dropped with it, so a string may run on past the CR that would end a native line.
// An octal escape codes one byte, so a byte above 127 that an escape codes is written as itself here and decodes as UTF-8 together with the raw bytes beside it; a lower byte keeps its escape, since it may be a parenthesis or a backslash.
const continuedLine = (bytes: Uint8Array, start: number): Line => {
  const kept: Array<number> = [];
  let depth = 0;
  let position = start;
  let byte = bytes[position];
  while (byte !== undefined && byte !== 13) {
    if (depth > 0 && byte === 92) {
      const next = bytes[position + 1];
      let code = 0;
      let digits = 0;
      let digit = octalDigit(next);
      while (digit !== undefined && digits < 3) {
        code = code * 8 + digit;
        digits++;
        digit = octalDigit(bytes[position + 1 + digits]);
      }
      if (next === 13 || next === 10) {
        position += next === 13 && bytes[position + 2] === 10 ? 3 : 2;
      } else if (code % 256 > 127) {
        kept.push(code % 256);
        position += 1 + digits;
      } else if (next !== undefined && next > 127) {
        // A backslash before a character without an escape is dropped.
        kept.push(next);
        position += 2;
      } else {
        // An escape is kept whole, so an escaped parenthesis or backslash neither opens nor closes the string.
        kept.push(byte);
        if (next !== undefined) {
          kept.push(next);
        }
        position += 2;
      }
    } else {
      if (byte === 40) {
        depth++;
      } else if (byte === 41 && depth > 0) {
        depth--;
      }
      kept.push(byte);
      position++;
    }
    byte = bytes[position];
  }
  if (byte === undefined) {
    throw new ParseError('native line is missing its closing CR', start);
  }
  return { text: decoder.decode(Uint8Array.from(kept)), end: position };
};

/** Reads CR records while treating the colour and alpha planes following `XI\n` as binary. */
export const tokenizeNative = (bytes: Uint8Array): Array<NativeRecord> => {
  const records: Array<NativeRecord> = [];
  let position = 0;
  let rasterPixels: number | undefined;
  while (position < bytes.length) {
    const start = position;
    const cr = bytes.indexOf(13, start);
    if (cr === -1) {
      throw new ParseError('native line is missing its closing CR', start);
    }
    const plain = bytes.subarray(start, cr);
    const { text: line, end: lineEnd } = plain.includes(92) ? continuedLine(bytes, start) : { text: decoder.decode(plain), end: cr };
    records.push({ kind: 'line', text: line, offset: start });
    position = lineEnd + 1;
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
    let digit = octalDigit(literal.charCodeAt(index));
    while (digit !== undefined && digits < 3) {
      code = code * 8 + digit;
      digits++;
      index++;
      digit = octalDigit(literal.charCodeAt(index));
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

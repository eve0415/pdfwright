import { ParseError } from '@pdfwright/core';

/** One CR-terminated text line, or the binary colour and alpha planes of a raster, with the byte offset where it starts in the native data. */
export type NativeRecord =
  | { readonly kind: 'line'; readonly text: string; readonly offset: number }
  | { readonly kind: 'rasterData'; readonly color: Uint8Array; readonly alpha: Uint8Array; readonly offset: number };

const decoder = new TextDecoder();
const RASTER_SIZE = /\]\s+0 0\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+8\s+\d+\s+1\s+/u;
const BEGIN_DATA = /^%%BeginData: (\d+)$/u;

/** Reads CR records while treating the colour and alpha planes following `XI\n` as binary. */
export const tokenizeNative = (bytes: Uint8Array): NativeRecord[] => {
  const records: NativeRecord[] = [];
  let position = 0;
  let rasterPixels: number | undefined = undefined;
  while (position < bytes.length) {
    const start = position;
    while (position < bytes.length && bytes[position] !== 13) position++;
    if (position >= bytes.length) throw new ParseError('native line is missing its closing CR', start);
    const line = decoder.decode(bytes.subarray(start, position));
    records.push({ kind: 'line', text: line, offset: start });
    position++;
    const dimensions = RASTER_SIZE.exec(line);
    if (dimensions !== null) rasterPixels = Number(dimensions[1]) * Number(dimensions[2]);
    const begin = BEGIN_DATA.exec(line);
    if (begin === null) continue;
    const count = Number(begin[1]);
    if (!Number.isSafeInteger(count) || count < 3 || rasterPixels === undefined) throw new ParseError('invalid raster data count', start);
    if (bytes[position] !== 88 || bytes[position + 1] !== 73 || bytes[position + 2] !== 10) throw new ParseError('raster data must start with XI LF', position);
    const colorStart = position + 3;
    const alphaStart = colorStart + count - 3;
    const end = alphaStart + rasterPixels;
    if (end > bytes.length) throw new ParseError('truncated raster data', bytes.length);
    records.push({ kind: 'rasterData', color: bytes.slice(colorStart, alphaStart), alpha: bytes.slice(alphaStart, end), offset: position });
    position = end;
  }
  return records;
};

/** Unescapes one PostScript literal string used for a name in native data; `offset` locates the line holding it for a `ParseError`. */
export const parseNativeLiteral = (literal: string, offset: number): string => {
  if (!literal.startsWith('(') || !literal.endsWith(')')) throw new ParseError('expected a PostScript literal string', offset);
  let result = '';
  for (let index = 1; index < literal.length - 1; index++) {
    const character = literal[index];
    if (character === '\\') {
      index++;
      const escaped = literal[index];
      if (escaped === undefined) throw new ParseError('truncated PostScript string escape', offset);
      result += escaped;
    } else {
      result += character;
    }
  }
  return result;
};

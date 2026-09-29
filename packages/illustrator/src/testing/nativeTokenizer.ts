export type NativeRecord =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'rasterData'; readonly color: Uint8Array; readonly alpha: Uint8Array };

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
    if (position >= bytes.length) throw new Error('native line is missing CR');
    const line = decoder.decode(bytes.subarray(start, position));
    records.push({ kind: 'line', text: line });
    position++;
    const dimensions = RASTER_SIZE.exec(line);
    if (dimensions !== null) rasterPixels = Number(dimensions[1]) * Number(dimensions[2]);
    const begin = BEGIN_DATA.exec(line);
    if (begin === null) continue;
    const count = Number(begin[1]);
    if (!Number.isSafeInteger(count) || count < 3 || rasterPixels === undefined) throw new Error('invalid raster data count');
    if (bytes[position] !== 88 || bytes[position + 1] !== 73 || bytes[position + 2] !== 10) throw new Error('raster data must start with XI LF');
    const colorStart = position + 3;
    const alphaStart = colorStart + count - 3;
    const end = alphaStart + rasterPixels;
    if (end > bytes.length) throw new Error('truncated raster data');
    records.push({ kind: 'rasterData', color: bytes.slice(colorStart, alphaStart), alpha: bytes.slice(alphaStart, end) });
    position = end;
  }
  return records;
};

/** Unescapes one PostScript literal string used for a name in native data. */
export const parseNativeLiteral = (literal: string): string => {
  if (!literal.startsWith('(') || !literal.endsWith(')')) throw new Error('expected PostScript literal string');
  let result = '';
  for (let index = 1; index < literal.length - 1; index++) {
    const character = literal[index];
    if (character === '\\') {
      index++;
      const escaped = literal[index];
      if (escaped === undefined) throw new Error('truncated PostScript string escape');
      result += escaped;
    } else {
      result += character;
    }
  }
  return result;
};

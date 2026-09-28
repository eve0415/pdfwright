import type {
  Artboard,
  ClipGroup,
  Fill,
  Group,
  IllustratorDocument,
  Item,
  Layer,
  Paint,
  PathGeometry,
  PathItem,
  Point,
  RasterItem,
  SpotColor,
  Stroke,
} from '../model/illustratorDocument.ts';
import type { NativeRecord } from './nativeTokenizer.ts';
import type { PdfDate } from '@pdfwright/core';

import { parseNativeLiteral, tokenizeNative } from './nativeTokenizer.ts';

export interface NativeReadResult {
  readonly document: IllustratorDocument;
  readonly header: ReadonlyMap<string, string>;
  readonly unknownBlocks: readonly string[];
}

interface Cursor {
  peek: () => NativeRecord | undefined;
  peekOffset: (offset: number) => NativeRecord | undefined;
  takeLine: () => string;
  takeData: () => Extract<NativeRecord, { kind: 'rasterData' }>;
  done: () => boolean;
}

const cursorFrom = (records: readonly NativeRecord[]): Cursor => {
  let index = 0;
  return {
    peek: () => records[index],
    peekOffset: offset => records[index + offset],
    takeLine: () => {
      const record = records[index++];
      if (record?.kind !== 'line') throw new Error('expected native text line');
      return record.text;
    },
    takeData: () => {
      const record = records[index++];
      if (record?.kind !== 'rasterData') throw new Error('expected raster payload');
      return record;
    },
    done: () => index >= records.length,
  };
};

const peekLine = (cursor: Cursor): string | undefined => {
  const record = cursor.peek();
  return record?.kind === 'line' ? record.text : undefined;
};

const expectLine = (cursor: Cursor, expected: string): void => {
  const actual = cursor.takeLine();
  if (actual !== expected) throw new Error(`expected native line ${expected}, got ${actual}`);
};

const numbers = (text: string): number[] => text.split(' ').map(Number);
const point = (values: readonly number[]): Point => {
  const [x, y] = values;
  if (x === undefined || y === undefined) throw new Error('native point is missing coordinates');
  return [x, y];
};

const parseGeometry = (cursor: Cursor): PathGeometry => {
  const first = cursor.takeLine();
  const firstTokens = first.split(' ');
  if (firstTokens.at(-1) !== 'm') throw new Error('native path must start with m');
  const start = point(numbers(firstTokens.slice(0, 2).join(' ')));
  const segments: PathGeometry['segments'][number][] = [];
  while (!cursor.done()) {
    const line = peekLine(cursor);
    if (line === undefined) break;
    const tokens = line.split(' ');
    const operator = tokens.at(-1);
    if (operator === 'L' || operator === 'l') {
      cursor.takeLine();
      const coordinates = numbers(tokens.slice(0, 2).join(' '));
      segments.push({ kind: 'line', to: point(coordinates), anchor: operator === 'l' ? 'smooth' : 'corner' });
    } else if (operator === 'C' || operator === 'c') {
      cursor.takeLine();
      const coordinates = numbers(tokens.slice(0, 6).join(' '));
      segments.push({
        kind: 'curve',
        control1: point(coordinates.slice(0, 2)),
        control2: point(coordinates.slice(2, 4)),
        to: point(coordinates.slice(4, 6)),
        anchor: operator === 'c' ? 'smooth' : 'corner',
      });
    } else break;
  }
  return { start, segments };
};

const parsePaint = (line: string): Paint => {
  const process = /^(\S+) (\S+) (\S+) (\S+) [kK]$/u.exec(line);
  if (process !== null) return { kind: 'process', cmyk: [Number(process[1]), Number(process[2]), Number(process[3]), Number(process[4])] };
  const spot = /^(\S+) (\S+) (\S+) (\S+) (\(.*\)) (\S+) [xX]$/u.exec(line);
  if (spot === null) throw new Error(`unsupported native paint: ${line}`);
  const color: SpotColor = { name: parseNativeLiteral(spot[5] ?? ''), alternate: [Number(spot[1]), Number(spot[2]), Number(spot[3]), Number(spot[4])] };
  return { kind: 'spot', spot: color, tint: 1 - Number(spot[6]) };
};

const parsePath = (cursor: Cursor): PathItem => {
  const count = cursor.takeLine();
  if (!/^\d+ As$/u.test(count)) throw new Error('path anchor count is missing');
  let fill: Fill | undefined = undefined;
  let strokePaint: Paint | undefined = undefined;
  let overprintStroke = false;
  if (/^[01] O$/u.test(peekLine(cursor) ?? '')) {
    const overprint = cursor.takeLine() === '1 O';
    fill = { paint: parsePaint(cursor.takeLine()), overprint };
  }
  if (/^[01] R$/u.test(peekLine(cursor) ?? '')) {
    overprintStroke = cursor.takeLine() === '1 R';
    strokePaint = parsePaint(cursor.takeLine());
  }
  expectLine(cursor, '0 1 0 0 0 Xy');
  const strokeState = cursor.takeLine();
  const width = /^0 J 0 j (\S+) w 10 M \[\]0 d$/u.exec(strokeState);
  if (width === null) throw new Error('unsupported native stroke state');
  expectLine(cursor, '0 XR');
  const geometry = parseGeometry(cursor);
  const operator = cursor.takeLine();
  if (operator !== 'f' && operator !== 's' && operator !== 'b') throw new Error('unsupported native path operator');
  const stroke: Stroke | undefined = strokePaint === undefined ? undefined : { paint: strokePaint, width: Number(width[1]), overprint: overprintStroke };
  if (fill !== undefined && stroke !== undefined) return { kind: 'path', geometry, fill, stroke };
  if (fill !== undefined) return { kind: 'path', geometry, fill };
  if (stroke !== undefined) return { kind: 'path', geometry, stroke };
  throw new Error('native path has no paint');
};

const skipArtDictionary = (cursor: Cursor): void => {
  expectLine(cursor, '%_/ArtDictionary :');
  while (peekLine(cursor) !== '%_;') cursor.takeLine();
  expectLine(cursor, '%_;');
  expectLine(cursor, '%_');
};

const parseRaster = (cursor: Cursor): RasterItem => {
  let spotPaint: Paint | undefined = undefined;
  if (peekLine(cursor) === '0 O') {
    cursor.takeLine();
    spotPaint = parsePaint(cursor.takeLine());
  }
  expectLine(cursor, '0 1 0 0 0 Xy');
  expectLine(cursor, '0 J 0 j 1 w 10 M []0 d');
  expectLine(cursor, '0 XR');
  expectLine(cursor, '%AI5_File:');
  expectLine(cursor, '%AI5_BeginRaster');
  const source = cursor.takeLine();
  if (source !== '() 0 XG' && source !== '() 1 XG') throw new Error('unsupported raster source');
  const colorDeclaration = cursor.takeLine();
  const matrix = /^\[ (\S+) 0 0 (\S+) (\S+) (\S+) \] (\d+) (\d+) [03] Xh$/u.exec(cursor.takeLine());
  if (matrix === null) throw new Error('unsupported native raster matrix');
  const width = Number(matrix[5]);
  const height = Number(matrix[6]);
  const scaleX = Number(matrix[1]);
  const scaleY = Number(matrix[2]);
  const x = Number(matrix[3]);
  const y = Number(matrix[4]) - scaleY * height;
  cursor.takeLine();
  if (!/^%%BeginData: \d+$/u.test(cursor.takeLine())) throw new Error('raster data count is missing');
  const data = cursor.takeData();
  expectLine(cursor, '%%EndData');
  expectLine(cursor, 'XH');
  expectLine(cursor, '%AI17_Begin_Content_if_version_gt:24 17');
  expectLine(cursor, '72 72 Xr');
  expectLine(cursor, '%AI17_End_Versioned_Content');
  expectLine(cursor, '%AI5_EndRaster');
  const ending = cursor.takeLine();
  skipArtDictionary(cursor);
  const bounds = { x, y, width: scaleX * width, height: scaleY * height };
  if (colorDeclaration === '/DeviceCMYK XN' && ending === 'N') {
    return { kind: 'raster', width, height, bounds, color: { space: 'cmyk', samples: data.color }, alpha: data.alpha };
  }
  if (spotPaint?.kind !== 'spot' || ending !== 'F') throw new Error('unsupported native spot raster');
  return { kind: 'raster', width, height, bounds, color: { space: 'spot', spot: spotPaint.spot, samples: data.color }, alpha: data.alpha };
};

const isClipPath = (cursor: Cursor): boolean => {
  const line = peekLine(cursor);
  if (line === undefined || !/^\d+ As$/u.test(line)) return false;
  const next = cursor.peekOffset(1);
  return next?.kind === 'line' && next.text.endsWith(' m');
};

const isLayerTrailer = (line: string | undefined): boolean => /^0 \S+ 0 2 0 Xy$/u.test(line ?? '');

const finishClip = (cursor: Cursor, items: readonly Item[]): ClipGroup => {
  cursor.takeLine();
  const clip = parseGeometry(cursor);
  expectLine(cursor, 'h');
  expectLine(cursor, 'W');
  expectLine(cursor, 'n');
  expectLine(cursor, 'Q');
  expectLine(cursor, '9 () XW');
  return { kind: 'clipGroup', clip, items };
};

const finishGroup = (cursor: Cursor, items: readonly Item[]): Group => {
  expectLine(cursor, 'U');
  let opacity = 1;
  let isolated = false;
  const trailer = /^0 (\S+) ([01]) 0 0 Xy$/u.exec(peekLine(cursor) ?? '');
  if (trailer !== null) {
    cursor.takeLine();
    opacity = Number(trailer[1]);
    isolated = trailer[2] === '1';
    expectLine(cursor, '0 0 Xd');
    expectLine(cursor, '6 () XW');
  }
  return { kind: 'group', items, opacity, isolated };
};

const parseItems = (cursor: Cursor, ending: 'layer' | 'group' | 'clip'): Item[] => {
  const items: Item[] = [];
  while (!cursor.done()) {
    const line = peekLine(cursor);
    if (line === undefined) throw new Error('unexpected raster bytes in layer');
    if ((ending === 'layer' && (line === 'LB' || isLayerTrailer(line))) || (ending === 'group' && line === 'U') || (ending === 'clip' && isClipPath(cursor))) {
      break;
    }
    if (line === '0 Ae') {
      cursor.takeLine();
      const opening = cursor.takeLine();
      if (opening === 'q') items.push(finishClip(cursor, parseItems(cursor, 'clip')));
      else if (opening === 'u') items.push(finishGroup(cursor, parseItems(cursor, 'group')));
      else throw new Error('unknown native group opener');
    } else if (/^\d+ As$/u.test(line)) {
      items.push(parsePath(cursor));
    } else if (line === '0 O' || line === '0 1 0 0 0 Xy') {
      items.push(parseRaster(cursor));
    } else {
      throw new Error(`unknown native layer operator: ${line}`);
    }
  }
  return items;
};

const parseLayer = (records: readonly NativeRecord[]): Layer => {
  const cursor = cursorFrom(records);
  expectLine(cursor, '%AI5_BeginLayer');
  const lb = cursor.takeLine().split(' ');
  if (
    lb.length !== 15 ||
    lb[14] !== 'Lb' ||
    lb[6] !== lb[0] ||
    lb[1] !== '1' ||
    lb[2] !== '1' ||
    lb[3] !== '1' ||
    lb[4] !== '0' ||
    lb[5] !== '0' ||
    lb[11] !== '0' ||
    lb[12] !== '50' ||
    lb[13] !== '0'
  ) {
    throw new Error('unobserved layer state, possibly locked');
  }
  const nameLine = cursor.takeLine();
  if (!nameLine.endsWith(' Ln')) throw new Error('layer name is missing');
  const name = parseNativeLiteral(nameLine.slice(0, -3));
  expectLine(cursor, '0 AE');
  skipArtDictionary(cursor);
  expectLine(cursor, '0 A');
  if (lb[0] === '0') expectLine(cursor, '1 Xw');
  expectLine(cursor, '0 Xw');
  const items = parseItems(cursor, 'layer');
  let opacity = 1;
  if (isLayerTrailer(peekLine(cursor))) {
    opacity = Number(cursor.takeLine().split(' ')[1]);
    expectLine(cursor, '0 0 Xd');
    expectLine(cursor, '7 () XW');
  }
  expectLine(cursor, 'LB');
  expectLine(cursor, '%AI5_EndLayer--');
  return { name, visible: lb[0] === '1', locked: false, opacity, color: [Number(lb[8]), Number(lb[9]), Number(lb[10])], items };
};

const parseHeader = (records: readonly NativeRecord[]): Map<string, string> => {
  const header = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== 'line') continue;
    if (record.text === '%%EndComments') break;
    const colon = record.text.indexOf(':');
    if (colon > 0) header.set(record.text.slice(0, colon), record.text.slice(colon + 1).trimStart());
    else if (record.text.startsWith('%AI5_FileFormat ')) header.set('%AI5_FileFormat', record.text.slice('%AI5_FileFormat '.length));
  }
  return header;
};

const parseArtboard = (records: readonly NativeRecord[], header: ReadonlyMap<string, string>): Artboard => {
  const crop = numbers(header.get('%AI3_Cropmarks') ?? '');
  const [, cropBottom = 0, width, cropTop] = crop;
  const height = cropTop === 0 ? -cropBottom : cropTop;
  if (width === undefined || height === undefined) throw new Error('artboard cropmarks are missing');
  const lines = records.flatMap(record => (record.kind === 'line' ? [record.text] : []));
  const nameLine = lines.find(line => line.endsWith('/UnicodeString (Name) ,'));
  const nameMatch = /^%_(\(.*\)) \/UnicodeString \(Name\) ,$/u.exec(nameLine ?? '');
  const defaultName = lines.includes('%_1 /Bool (IsArtboardDefaultName) ,');
  const name = nameMatch === null || defaultName ? undefined : parseNativeLiteral(nameMatch[1] ?? '');
  const bleed = ['Left', 'Right', 'Top', 'Bottom'].map(side => {
    const line = lines.find(value => value.endsWith(`/Real (Bleed${side}Value) ,`));
    return line === undefined ? 0 : Number(line.split(' ')[0]?.slice(2));
  });
  const [left = 0, right = 0, top = 0, bottom = 0] = bleed;
  const artboard: Artboard = { width, height, bleed: { left, right, top, bottom } };
  return name === undefined ? artboard : { ...artboard, name };
};

/** Reads the supported native layer grammar; the full PDF page date supplies lost seconds and zone. */
export const readNative = (native: Uint8Array, lastModified: PdfDate): NativeReadResult => {
  const records = tokenizeNative(native);
  const header = parseHeader(records);
  const layers: Layer[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record?.kind !== 'line' || record.text !== '%AI5_BeginLayer') continue;
    const end = records.findIndex((entry, position) => position > index && entry.kind === 'line' && entry.text === '%AI5_EndLayer--');
    if (end === -1) throw new Error('native layer is unterminated');
    layers.push(parseLayer(records.slice(index, end + 1)));
    index = end;
  }
  const titleLine = header.get('%%Title') ?? '()';
  const document: IllustratorDocument = { artboard: parseArtboard(records, header), layers, lastModified, title: parseNativeLiteral(titleLine) };
  return { document, header, unknownBlocks: [] };
};

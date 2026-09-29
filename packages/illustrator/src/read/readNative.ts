import type {
  Artboard,
  ClipGroup,
  Fill,
  FillRule,
  Group,
  IllustratorDocument,
  Item,
  Layer,
  Paint,
  PathGeometry,
  PathItem,
  Point,
  RasterItem,
  Segment,
  SpotColor,
  Stroke,
  Subpath,
} from '../model/illustratorDocument.ts';
import type { NativeOrigin } from '../native/nativeOrigin.ts';
import type { NativeRecord } from './nativeTokenizer.ts';
import type { PdfDate } from '@pdfwright/core';

import { ParseError, UnsupportedFeatureError } from '@pdfwright/core';

import { formatNativeNumber } from '../native/formatNativeNumber.ts';

import { parseNativeLiteral, tokenizeNative } from './nativeTokenizer.ts';

export interface NativeReadResult {
  readonly document: IllustratorDocument;
  readonly nativeOrigin: NativeOrigin;
  readonly header: ReadonlyMap<string, string>;
  readonly unknownBlocks: readonly string[];
}

interface LineRecord {
  readonly text: string;
  readonly offset: number;
}

interface Cursor {
  peek: () => NativeRecord | undefined;
  peekOffset: (offset: number) => NativeRecord | undefined;
  takeRecord: () => LineRecord;
  takeLine: () => string;
  takeData: () => Extract<NativeRecord, { kind: 'rasterData' }>;
  done: () => boolean;
  /** Byte offset of the next record, or of the last record once every record is taken. */
  at: () => number;
  /** Converts a native y coordinate to the model's, undoing the native origin's shift. */
  modelY: (nativeY: number, offset: number) => number;
}

const unsupported = (message: string, offset: number): UnsupportedFeatureError => new UnsupportedFeatureError(`${message} at native byte ${String(offset)}`);

const cursorFrom = (records: readonly NativeRecord[], modelY: Cursor['modelY']): Cursor => {
  let index = 0;
  const at = (): number => records[index]?.offset ?? records.at(-1)?.offset ?? 0;
  const takeRecord = (): LineRecord => {
    const offset = at();
    const record = records[index++];
    if (record?.kind !== 'line') throw unsupported('expected a native text line', offset);
    return record;
  };
  return {
    peek: () => records[index],
    peekOffset: offset => records[index + offset],
    takeRecord,
    takeLine: () => takeRecord().text,
    takeData: () => {
      const offset = at();
      const record = records[index++];
      if (record?.kind !== 'rasterData') throw unsupported('expected a raster payload', offset);
      return record;
    },
    done: () => index >= records.length,
    at,
    modelY,
  };
};

const peekLine = (cursor: Cursor): string | undefined => {
  const record = cursor.peek();
  return record?.kind === 'line' ? record.text : undefined;
};

const expectLine = (cursor: Cursor, expected: string): void => {
  const { text, offset } = cursor.takeRecord();
  if (text !== expected) throw unsupported(`expected native line ${expected}, got ${text}`, offset);
};

const real = (token: string | undefined, offset: number): number => {
  const value = Number(token);
  if (token === undefined || token === '' || !Number.isFinite(value)) throw new ParseError(`expected a native number, got ${token ?? 'nothing'}`, offset);
  return value;
};

const numbers = (tokens: readonly string[], offset: number): number[] => tokens.map(token => real(token, offset));

const modelPoint = (cursor: Cursor, values: readonly number[], offset: number): Point => {
  const [x, y] = values;
  if (x === undefined || y === undefined) throw new ParseError('native point is missing coordinates', offset);
  return [x, cursor.modelY(y, offset)];
};

const parseSubpath = (cursor: Cursor): Subpath => {
  const first = cursor.takeRecord();
  const firstTokens = first.text.split(' ');
  if (firstTokens.at(-1) !== 'm') throw unsupported(`native path must start with m, got ${first.text}`, first.offset);
  const start = modelPoint(cursor, numbers(firstTokens.slice(0, 2), first.offset), first.offset);
  const segments: Segment[] = [];
  while (!cursor.done()) {
    const line = peekLine(cursor);
    if (line === undefined) break;
    const offset = cursor.at();
    const tokens = line.split(' ');
    const operator = tokens.at(-1);
    if (operator === 'L' || operator === 'l') {
      cursor.takeLine();
      const coordinates = numbers(tokens.slice(0, 2), offset);
      segments.push({ kind: 'line', to: modelPoint(cursor, coordinates, offset), anchor: operator === 'l' ? 'smooth' : 'corner' });
    } else if (operator === 'C' || operator === 'c') {
      cursor.takeLine();
      const coordinates = numbers(tokens.slice(0, 6), offset);
      segments.push({
        kind: 'curve',
        control1: modelPoint(cursor, coordinates.slice(0, 2), offset),
        control2: modelPoint(cursor, coordinates.slice(2, 4), offset),
        to: modelPoint(cursor, coordinates.slice(4, 6), offset),
        anchor: operator === 'c' ? 'smooth' : 'corner',
      });
    } else break;
  }
  return { start, segments };
};

const parsePaint = ({ text, offset }: LineRecord): Paint => {
  const process = /^(\S+) (\S+) (\S+) (\S+) [kK]$/u.exec(text);
  if (process !== null) {
    return { kind: 'process', cmyk: [real(process[1], offset), real(process[2], offset), real(process[3], offset), real(process[4], offset)] };
  }
  const spot = /^(\S+) (\S+) (\S+) (\S+) (\(.*\)) (\S+) [xX]$/u.exec(text);
  if (spot === null) throw unsupported(`unsupported native paint ${text}`, offset);
  const color: SpotColor = {
    name: parseNativeLiteral(spot[5] ?? '', offset),
    alternate: [real(spot[1], offset), real(spot[2], offset), real(spot[3], offset), real(spot[4], offset)],
  };
  return { kind: 'spot', spot: color, tint: 1 - real(spot[6], offset) };
};

interface PaintState {
  lockState: { value: boolean };
  // Shared across nesting like lockState, because the writer tracks the XR state across a whole layer.
  fillRuleState: { value: FillRule };
  fillPaint: Paint | undefined;
  strokePaint: Paint | undefined;
  overprintFill: boolean;
  overprintStroke: boolean;
  strokeWidth: number;
}

const isFillPaint = (line: string): boolean => line.endsWith(' k') || line.endsWith(' x');
const isStrokePaint = (line: string): boolean => line.endsWith(' K') || line.endsWith(' X');

// A line that selects the fill rule reports it; any other line reports undefined.
const fillRuleOf = (line: string): FillRule | undefined => {
  if (line === '0 XR') return 'nonzero';
  if (line === '1 XR') return 'evenodd';
  return undefined;
};

const readPathState = (cursor: Cursor, state: PaintState): void => {
  while (!cursor.done()) {
    const line = peekLine(cursor);
    if (line === undefined) break;
    const offset = cursor.at();
    const width = /^0 J 0 j (\S+) w 10 M \[\]0 d$/u.exec(line);
    const shortWidth = /^(\S+) w$/u.exec(line);
    const rule = fillRuleOf(line);
    if (/^[01] O$/u.test(line)) state.overprintFill = cursor.takeLine() === '1 O';
    else if (/^[01] R$/u.test(line)) state.overprintStroke = cursor.takeLine() === '1 R';
    else if (isFillPaint(line)) state.fillPaint = parsePaint(cursor.takeRecord());
    else if (isStrokePaint(line)) state.strokePaint = parsePaint(cursor.takeRecord());
    else if (rule !== undefined) {
      state.fillRuleState.value = rule;
      cursor.takeLine();
    } else if (/^0 \S+ [01] \S+ 0 Xy$/u.test(line) || /^[01] D$/u.test(line)) cursor.takeLine();
    else if (width === null) {
      if (shortWidth === null) break;
      state.strokeWidth = real(shortWidth[1], offset);
      cursor.takeLine();
    } else {
      state.strokeWidth = real(width[1], offset);
      cursor.takeLine();
    }
  }
};

interface PathObject {
  readonly subpath: Subpath;
  readonly operator: LineRecord;
}

const parsePathObject = (cursor: Cursor, state: PaintState): PathObject => {
  const count = cursor.takeRecord();
  if (!/^\d+ As$/u.test(count.text)) throw unsupported('path anchor count is missing', count.offset);
  readPathState(cursor, state);
  const subpath = parseSubpath(cursor);
  return { subpath, operator: cursor.takeRecord() };
};

const paintedPath = (geometry: PathGeometry, { text: operator, offset }: LineRecord, state: PaintState): PathItem => {
  if (operator !== 'f' && operator !== 's' && operator !== 'b') throw unsupported(`unsupported native path operator ${operator}`, offset);
  const fill: Fill | undefined =
    (operator === 'f' || operator === 'b') && state.fillPaint !== undefined ? { paint: state.fillPaint, overprint: state.overprintFill } : undefined;
  const stroke: Stroke | undefined =
    (operator === 's' || operator === 'b') && state.strokePaint !== undefined
      ? { paint: state.strokePaint, width: state.strokeWidth, overprint: state.overprintStroke }
      : undefined;
  const locked = state.lockState.value;
  if (fill !== undefined && stroke !== undefined) return { kind: 'path', locked, geometry, fill, stroke };
  if (fill !== undefined) return { kind: 'path', locked, geometry, fill };
  if (stroke !== undefined) return { kind: 'path', locked, geometry, stroke };
  throw unsupported('native path has no paint', offset);
};

const parsePath = (cursor: Cursor, state: PaintState): PathItem => {
  const object = parsePathObject(cursor, state);
  return paintedPath({ subpaths: [object.subpath], fillRule: state.fillRuleState.value }, object.operator, state);
};

// Follows 0 Ae and *u; every member of the compound path ends with the same paint operator.
const parseCompoundPath = (cursor: Cursor, state: PaintState): PathItem => {
  const objects: PathObject[] = [];
  while (peekLine(cursor) !== '*U') objects.push(parsePathObject(cursor, state));
  const closing = cursor.at();
  expectLine(cursor, '*U');
  const [first] = objects;
  if (first === undefined) throw unsupported('compound path has no members', closing);
  const mismatch = objects.find(object => object.operator.text !== first.operator.text);
  if (mismatch !== undefined) throw unsupported('compound path members end with different operators', mismatch.operator.offset);
  return paintedPath({ subpaths: objects.map(object => object.subpath), fillRule: state.fillRuleState.value }, first.operator, state);
};

const skipArtDictionary = (cursor: Cursor): void => {
  expectLine(cursor, '%_/ArtDictionary :');
  while (!cursor.done() && peekLine(cursor) !== '%_;') cursor.takeLine();
  expectLine(cursor, '%_;');
  expectLine(cursor, '%_');
};

const parseRaster = (cursor: Cursor, state: PaintState): RasterItem => {
  let spotPaint: Paint | undefined = undefined;
  if (peekLine(cursor) === '0 O') {
    cursor.takeLine();
    spotPaint = parsePaint(cursor.takeRecord());
    state.fillPaint = spotPaint;
  }
  if (peekLine(cursor) === '0 1 0 0 0 Xy') cursor.takeLine();
  if (peekLine(cursor) === '0 J 0 j 1 w 10 M []0 d') cursor.takeLine();
  if (peekLine(cursor) === '0 XR') {
    cursor.takeLine();
    state.fillRuleState.value = 'nonzero';
  }
  expectLine(cursor, '%AI5_File:');
  expectLine(cursor, '%AI5_BeginRaster');
  const source = cursor.takeRecord();
  if (!/^\(.*\) [01] XG$/u.test(source.text)) throw unsupported('unsupported raster source', source.offset);
  const colorDeclaration = cursor.takeLine();
  const matrixLine = cursor.takeRecord();
  const matrix = /^\[ (\S+) 0 0 (\S+) (\S+) (\S+) \] (\d+) (\d+) [03] Xh$/u.exec(matrixLine.text);
  if (matrix === null) throw unsupported('unsupported native raster matrix', matrixLine.offset);
  const at = matrixLine.offset;
  const width = real(matrix[5], at);
  const height = real(matrix[6], at);
  const scaleX = real(matrix[1], at);
  const scaleY = real(matrix[2], at);
  const x = real(matrix[3], at);
  // The matrix places the raster's top edge; the model keeps its bottom edge.
  const y = cursor.modelY(real(matrix[4], at), at) - scaleY * height;
  cursor.takeLine();
  const count = cursor.takeRecord();
  if (!/^%%BeginData: \d+$/u.test(count.text)) throw unsupported('raster data count is missing', count.offset);
  const data = cursor.takeData();
  expectLine(cursor, '%%EndData');
  expectLine(cursor, 'XH');
  expectLine(cursor, '%AI17_Begin_Content_if_version_gt:24 17');
  expectLine(cursor, '72 72 Xr');
  expectLine(cursor, '%AI17_End_Versioned_Content');
  expectLine(cursor, '%AI5_EndRaster');
  const ending = cursor.takeRecord();
  skipArtDictionary(cursor);
  const bounds = { x, y, width: scaleX * width, height: scaleY * height };
  if (colorDeclaration === '/DeviceCMYK XN' && ending.text === 'N') {
    return { kind: 'raster', locked: state.lockState.value, width, height, bounds, color: { space: 'cmyk', samples: data.color }, alpha: data.alpha };
  }
  if (spotPaint?.kind !== 'spot' || ending.text !== 'F') throw unsupported('unsupported native spot raster', ending.offset);
  return {
    kind: 'raster',
    locked: state.lockState.value,
    width,
    height,
    bounds,
    color: { space: 'spot', spot: spotPaint.spot, samples: data.color },
    alpha: data.alpha,
  };
};

// A clipping path is one path object, or a compound path opened by 0 Ae and *u, whose first object ends with h and W rather than a paint operator.
const isClipPath = (cursor: Cursor): boolean => {
  const line = peekLine(cursor);
  const opener = cursor.peekOffset(1);
  const compound = line === '0 Ae' && opener?.kind === 'line' && opener.text === '*u';
  if (!compound && (line === undefined || !/^\d+ As$/u.test(line))) return false;
  for (let offset = compound ? 2 : 1; offset < 10_000; offset++) {
    const record = cursor.peekOffset(offset);
    if (record?.kind !== 'line') return false;
    if (record.text === 'f' || record.text === 's' || record.text === 'b') return false;
    if (record.text === 'h') {
      const next = cursor.peekOffset(offset + 1);
      return next?.kind === 'line' && next.text === 'W';
    }
  }
  return false;
};

const isLayerTrailer = (line: string | undefined): boolean => /^0 \S+ 0 2 0 Xy$/u.test(line ?? '');

const parseClipObject = (cursor: Cursor, state: PaintState): Subpath => {
  const count = cursor.takeRecord();
  if (!/^\d+ As$/u.test(count.text)) throw unsupported('clipping path anchor count is missing', count.offset);
  for (let line = peekLine(cursor) ?? ''; /^\S+ w$/u.test(line) || fillRuleOf(line) !== undefined; line = peekLine(cursor) ?? '') {
    state.fillRuleState.value = fillRuleOf(cursor.takeLine()) ?? state.fillRuleState.value;
  }
  const subpath = parseSubpath(cursor);
  expectLine(cursor, 'h');
  expectLine(cursor, 'W');
  expectLine(cursor, 'n');
  return subpath;
};

// Reads the clipping path that follows a clip group's items, through the group's closing Q and XW.
const finishClip = (cursor: Cursor, state: PaintState): PathGeometry => {
  const subpaths: Subpath[] = [];
  if (peekLine(cursor) === '0 Ae') {
    expectLine(cursor, '0 Ae');
    expectLine(cursor, '*u');
    while (peekLine(cursor) !== '*U') subpaths.push(parseClipObject(cursor, state));
    expectLine(cursor, '*U');
  } else subpaths.push(parseClipObject(cursor, state));
  expectLine(cursor, 'Q');
  expectLine(cursor, '9 () XW');
  return { subpaths, fillRule: state.fillRuleState.value };
};

const finishGroup = (cursor: Cursor, items: readonly Item[], locked: boolean): Group => {
  expectLine(cursor, 'U');
  let opacity = 1;
  let isolated = false;
  const offset = cursor.at();
  const trailer = /^0 (\S+) ([01]) 0 0 Xy$/u.exec(peekLine(cursor) ?? '');
  if (trailer !== null) {
    cursor.takeLine();
    opacity = real(trailer[1], offset);
    isolated = trailer[2] === '1';
    expectLine(cursor, '0 0 Xd');
    expectLine(cursor, '6 () XW');
  }
  return { kind: 'group', locked, items, opacity, isolated };
};

const consumeItemState = (cursor: Cursor, state: PaintState, line: string): boolean => {
  if (line === '0 A' || line === '1 A') {
    state.lockState.value = cursor.takeLine() === '1 A';
    return true;
  }
  if (line === '%_/ArtDictionary :') {
    skipArtDictionary(cursor);
    return true;
  }
  if (line === '0 Ap' || line === '1 Ap') {
    cursor.takeLine();
    return true;
  }
  return false;
};

const parseItems = (cursor: Cursor, ending: 'layer' | 'group' | 'clip', state: PaintState): Item[] => {
  const items: Item[] = [];
  while (!cursor.done()) {
    const line = peekLine(cursor);
    const offset = cursor.at();
    if (line === undefined) throw unsupported('unexpected raster bytes in layer', offset);
    if ((ending === 'layer' && (line === 'LB' || isLayerTrailer(line))) || (ending === 'group' && line === 'U') || (ending === 'clip' && isClipPath(cursor))) {
      break;
    }
    if (consumeItemState(cursor, state, line)) continue;
    if (line === '%AI5_BeginLayer') throw unsupported('sublayers are unsupported', offset);
    if (line === '0 Ae') {
      cursor.takeLine();
      const opening = cursor.takeRecord();
      const locked = state.lockState.value;
      if (opening.text === 'q') {
        const clipped = parseItems(cursor, 'clip', { ...state });
        const clip: ClipGroup = { kind: 'clipGroup', locked, clip: finishClip(cursor, state), items: clipped };
        items.push(clip);
      } else if (opening.text === 'u') items.push(finishGroup(cursor, parseItems(cursor, 'group', { ...state }), locked));
      else if (opening.text === '*u') items.push(parseCompoundPath(cursor, state));
      else throw unsupported(`unknown native group opener ${opening.text}`, opening.offset);
    } else if (/^\d+ As$/u.test(line)) {
      items.push(parsePath(cursor, state));
    } else if (line === '0 O' || line === '0 1 0 0 0 Xy' || line === '%AI5_File:') {
      items.push(parseRaster(cursor, state));
    } else {
      throw unsupported(`unknown native layer operator ${line}`, offset);
    }
  }
  return items;
};

const parseLayer = (records: readonly NativeRecord[], modelY: Cursor['modelY']): Layer => {
  const cursor = cursorFrom(records, modelY);
  expectLine(cursor, '%AI5_BeginLayer');
  const lbLine = cursor.takeRecord();
  const lb = lbLine.text.split(' ');
  if (
    lb.length !== 15 ||
    lb[14] !== 'Lb' ||
    lb[6] !== lb[0] ||
    lb[1] !== '1' ||
    (lb[2] !== '0' && lb[2] !== '1') ||
    lb[3] !== '1' ||
    lb[4] !== '0' ||
    lb[5] !== '0' ||
    lb[11] !== '0' ||
    lb[12] !== '50' ||
    lb[13] !== '0'
  ) {
    throw unsupported(`unsupported layer state ${lbLine.text}`, lbLine.offset);
  }
  const nameLine = cursor.takeRecord();
  if (!nameLine.text.endsWith(' Ln')) throw unsupported('layer name is missing', nameLine.offset);
  const name = parseNativeLiteral(nameLine.text.slice(0, -3), nameLine.offset);
  const activation = cursor.takeRecord();
  if (activation.text !== '0 AE' && activation.text !== '1 AE') throw unsupported('layer activation is missing', activation.offset);
  skipArtDictionary(cursor);
  expectLine(cursor, lb[2] === '0' ? '1 A' : '0 A');
  if (lb[0] === '0') expectLine(cursor, '1 Xw');
  let itemLock = lb[2] === '0';
  if (peekLine(cursor) === '0 A') {
    cursor.takeLine();
    itemLock = false;
  }
  expectLine(cursor, '0 Xw');
  const items = parseItems(cursor, 'layer', {
    lockState: { value: itemLock },
    fillRuleState: { value: 'nonzero' },
    fillPaint: undefined,
    strokePaint: undefined,
    overprintFill: false,
    overprintStroke: false,
    strokeWidth: 1,
  });
  let opacity = 1;
  if (isLayerTrailer(peekLine(cursor))) {
    const trailer = cursor.takeRecord();
    opacity = real(trailer.text.split(' ')[1], trailer.offset);
    expectLine(cursor, '0 0 Xd');
    expectLine(cursor, '7 () XW');
  }
  expectLine(cursor, 'LB');
  expectLine(cursor, '%AI5_EndLayer--');
  const color: readonly [number, number, number] = [real(lb[8], lbLine.offset), real(lb[9], lbLine.offset), real(lb[10], lbLine.offset)];
  return { name, visible: lb[0] === '1', locked: lb[2] === '0', opacity, color, items };
};

const parseHeader = (records: readonly NativeRecord[]): Map<string, LineRecord> => {
  const header = new Map<string, LineRecord>();
  for (const record of records) {
    if (record.kind !== 'line') continue;
    if (record.text === '%%EndComments') break;
    const colon = record.text.indexOf(':');
    if (colon > 0) header.set(record.text.slice(0, colon), { text: record.text.slice(colon + 1).trimStart(), offset: record.offset });
    else if (record.text.startsWith('%AI5_FileFormat ')) {
      header.set('%AI5_FileFormat', { text: record.text.slice('%AI5_FileFormat '.length), offset: record.offset });
    }
  }
  return header;
};

interface NativeFrame {
  readonly width: number;
  readonly height: number;
  readonly origin: NativeOrigin;
  readonly modelY: Cursor['modelY'];
}

// Native numbers keep at most 15 significant digits; see formatNativeNumber.
const NATIVE_LIMIT = 1e15;

// %AI3_Cropmarks gives the artboard as left, bottom, right, top in native coordinates; the writer's two origins put its lower-left or upper-left corner at 0 0.
const nativeFrame = (header: ReadonlyMap<string, LineRecord>): NativeFrame => {
  const crop = header.get('%AI3_Cropmarks');
  if (crop === undefined) throw new UnsupportedFeatureError('native header has no %AI3_Cropmarks');
  const [left, bottom, right, top, ...rest] = numbers(crop.text.split(' '), crop.offset);
  if (left !== 0 || bottom === undefined || right === undefined || top === undefined || rest.length > 0 || right <= 0) {
    throw unsupported(`unsupported artboard cropmarks ${crop.text}`, crop.offset);
  }
  if (bottom === 0 && top > 0) return { width: right, height: top, origin: 'artboard-bottom-left', modelY: y => y };
  if (top !== 0 || bottom >= 0) throw unsupported(`unsupported artboard cropmarks ${crop.text}`, crop.offset);
  const height = -bottom;
  // The writer moves every y down by the artboard height and rounds the result to native precision, so the read rounds the restored value the same way.
  const modelY = (y: number, offset: number): number => {
    const shifted = y + height;
    if (Math.abs(shifted) >= NATIVE_LIMIT) throw new ParseError('native coordinate is out of range', offset);
    return Number(formatNativeNumber(shifted));
  };
  return { width: right, height, origin: 'artboard-top-left', modelY };
};

const parseArtboard = (records: readonly NativeRecord[], frame: NativeFrame): Artboard => {
  const lines = records.flatMap(record => (record.kind === 'line' ? [record] : []));
  const nameLine = lines.find(line => line.text.endsWith('/UnicodeString (Name) ,'));
  const nameMatch = /^%_(\(.*\)) \/UnicodeString \(Name\) ,$/u.exec(nameLine?.text ?? '');
  const defaultName = lines.some(line => line.text === '%_1 /Bool (IsArtboardDefaultName) ,');
  const name = nameMatch === null || defaultName ? undefined : parseNativeLiteral(nameMatch[1] ?? '', nameLine?.offset ?? 0);
  const bleed = ['Left', 'Right', 'Top', 'Bottom'].map(side => {
    const line = lines.find(value => value.text.endsWith(`/Real (Bleed${side}Value) ,`));
    return line === undefined ? 0 : real(line.text.split(' ')[0]?.slice(2), line.offset);
  });
  const [left = 0, right = 0, top = 0, bottom = 0] = bleed;
  const artboard: Artboard = { width: frame.width, height: frame.height, bleed: { left, right, top, bottom } };
  return name === undefined ? artboard : { ...artboard, name };
};

const unknownSetupBlocks = (records: readonly NativeRecord[]): string[] => {
  const blocks = new Set<string>();
  let inSetup = false;
  for (const record of records) {
    if (record.kind !== 'line') continue;
    if (record.text === '%%BeginSetup') inSetup = true;
    else if (record.text === '%%EndSetup') inSetup = false;
    else if (inSetup) {
      const marker = /^%AI\d+_Begin\S*/u.exec(record.text)?.[0];
      if (marker !== undefined && marker !== '%AI5_BeginPalette' && marker !== '%AI9_BeginDocumentData') blocks.add(marker);
    }
  }
  return [...blocks];
};

/**
 * Reads the supported native layer grammar into model coordinates under either native origin; the full PDF page date supplies the seconds and zone the native header drops.
 *
 * Malformed bytes, numbers and strings raise `ParseError` with their offset in the native data, and grammar outside what the reader supports raises `UnsupportedFeatureError`.
 */
export const readNative = (native: Uint8Array, lastModified: PdfDate): NativeReadResult => {
  const records = tokenizeNative(native);
  const header = parseHeader(records);
  const frame = nativeFrame(header);
  const layers: Layer[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record?.kind !== 'line' || record.text !== '%AI5_BeginLayer') continue;
    const end = records.findIndex((entry, position) => position > index && entry.kind === 'line' && entry.text === '%AI5_EndLayer--');
    if (end === -1) throw new ParseError('native layer is unterminated', record.offset);
    layers.push(parseLayer(records.slice(index, end + 1), frame.modelY));
    index = end;
  }
  const title = header.get('%%Title');
  const document: IllustratorDocument = {
    artboard: parseArtboard(records, frame),
    layers,
    lastModified,
    title: parseNativeLiteral(title?.text ?? '()', title?.offset ?? 0),
  };
  const values = new Map([...header].map(([key, line]) => [key, line.text]));
  return { document, nativeOrigin: frame.origin, header: values, unknownBlocks: unknownSetupBlocks(records) };
};

import type { Clut } from './iccLut.ts';
import type { Curve, Matrix3 } from './iccTags.ts';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { iccSignature } from './iccSignature.ts';
import { readCurve } from './iccTags.ts';

export interface MultiLut {
  readonly kind: 'lutAtoB' | 'lutBtoA';
  readonly b: readonly Curve[];
  readonly matrix?: { readonly m: Matrix3; readonly offset: readonly [number, number, number] } | undefined;
  readonly m?: readonly Curve[] | undefined;
  readonly clut?: Clut | undefined;
  readonly a?: readonly Curve[] | undefined;
}

interface Parts {
  readonly b: number;
  readonly matrix: number;
  readonly m: number;
  readonly clut: number;
  readonly a: number;
}

const fail = (offset: number): never => {
  throw new InvalidProfileError('invalid ICC multi-process LUT', 'bad-tag-data', { offset });
};

const offsets = (view: DataView, start: number, size: number): Parts => {
  const parts = {
    b: view.getUint32(start + 12),
    matrix: view.getUint32(start + 16),
    m: view.getUint32(start + 20),
    clut: view.getUint32(start + 24),
    a: view.getUint32(start + 28),
  };
  for (const value of Object.values(parts)) if (value !== 0 && (value < 32 || value >= size || value % 4 !== 0)) fail(start);
  if (parts.b === 0 || (parts.a === 0) !== (parts.clut === 0) || (parts.m === 0) !== (parts.matrix === 0)) fail(start);
  return parts;
};

const partLimit = (parts: Parts, current: number, tagEnd: number): number => {
  let end = tagEnd;
  for (const value of [parts.b, parts.matrix, parts.m, parts.clut, parts.a]) if (value > current && value < end) end = value;
  return end;
};

const curves = (bytes: Uint8Array, config: { start: number; relative: number; count: number; end: number }): Curve[] | undefined => {
  if (config.relative === 0) return undefined;
  const result: Curve[] = [];
  let cursor = config.start + config.relative;
  for (let index = 0; index < config.count; index++) {
    const item = readCurve(bytes, cursor, config.end);
    result.push(item.curve);
    // ICC.1:2022, 10.12.2 pads between embedded curves, not after the final curve.
    if (index + 1 < config.count) {
      cursor += Math.ceil(item.consumed / 4) * 4;
      if (cursor > config.end) fail(cursor);
    }
  }
  return result;
};

const matrixPart = (view: DataView, config: { start: number; relative: number; end: number }): MultiLut['matrix'] => {
  if (config.relative === 0) return undefined;
  const at = config.start + config.relative;
  if (config.end - at < 48) fail(at);
  const values = Array.from({ length: 12 }, (_, index) => view.getInt32(at + index * 4) / 65536);
  return {
    m: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[4] ?? 0, values[5] ?? 0, values[6] ?? 0, values[8] ?? 0, values[9] ?? 0, values[10] ?? 0],
    offset: [values[3] ?? 0, values[7] ?? 0, values[11] ?? 0],
  };
};

const clutPart = (
  view: DataView,
  config: { start: number; relative: number; end: number; inputChannels: number; outputChannels: number },
): Clut | undefined => {
  if (config.relative === 0) return undefined;
  // ICC.1:2022, 10.12.3 Table 46: 16 grid bytes, a 1-or-2-byte precision, then interleaved output values.
  const at = config.start + config.relative;
  if (config.end - at < 20) fail(at);
  const gridPoints: number[] = [];
  let count = config.outputChannels;
  for (let index = 0; index < config.inputChannels; index++) {
    const grid = view.getUint8(at + index);
    if (grid < 2) fail(at + index);
    if (count > Math.floor(16_777_216 / grid)) throw new ResourceLimitError('ICC CLUT exceeds 16777216 entries');
    count *= grid;
    gridPoints.push(grid);
  }
  const width = view.getUint8(at + 16);
  if ((width !== 1 && width !== 2) || 20 + count * width > config.end - at) fail(at + 16);
  const values = new Float64Array(count);
  for (let index = 0; index < count; index++) values[index] = width === 1 ? view.getUint8(at + 20 + index) / 255 : view.getUint16(at + 20 + index * 2) / 65535;
  return { gridPoints, inputChannels: config.inputChannels, outputChannels: config.outputChannels, values };
};

export const readMultiLut = (bytes: Uint8Array, start: number, end: number): MultiLut => {
  // ICC.1:2022, 10.12.1 Table 45 and 10.13.1 Table 47: offsets are relative to the tag and zero omits an element.
  if (start < 0 || end > bytes.length || end - start < 32) fail(start);
  const name = iccSignature(bytes, start);
  if (name !== 'mAB ' && name !== 'mBA ') throw new InvalidProfileError('ICC tag must be lutAToBType or lutBToAType', 'tag-type-mismatch', { offset: start });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inputChannels = view.getUint8(start + 8);
  const outputChannels = view.getUint8(start + 9);
  if (inputChannels < 1 || inputChannels > 15 || outputChannels < 1 || outputChannels > 15) fail(start + 8);
  const parts = offsets(view, start, end - start);
  if (inputChannels !== outputChannels && parts.clut === 0) fail(start + 24);
  const aCount = name === 'mAB ' ? inputChannels : outputChannels;
  const bCount = name === 'mAB ' ? outputChannels : inputChannels;
  const mCount = name === 'mAB ' ? outputChannels : inputChannels;
  const b = curves(bytes, { start, relative: parts.b, count: bCount, end: start + partLimit(parts, parts.b, end - start) }) ?? fail(start + 12);
  const matrix = matrixPart(view, { start, relative: parts.matrix, end: start + partLimit(parts, parts.matrix, end - start) });
  const m = curves(bytes, { start, relative: parts.m, count: mCount, end: start + partLimit(parts, parts.m, end - start) });
  const clut = clutPart(view, { start, relative: parts.clut, end: start + partLimit(parts, parts.clut, end - start), inputChannels, outputChannels });
  const a = curves(bytes, { start, relative: parts.a, count: aCount, end: start + partLimit(parts, parts.a, end - start) });
  return { kind: name === 'mAB ' ? 'lutAtoB' : 'lutBtoA', b, matrix, m, clut, a };
};

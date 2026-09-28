import type { Xyz } from './iccStructure.ts';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { iccSignature } from './iccSignature.ts';

export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

export type Curve =
  | { readonly kind: 'identity' }
  | { readonly kind: 'gamma'; readonly gamma: number }
  | { readonly kind: 'table'; readonly values: Float64Array }
  | { readonly kind: 'parametric'; readonly functionType: 0 | 1 | 2 | 3 | 4; readonly params: readonly number[] };

export interface ReadCurve {
  readonly curve: Curve;
  readonly consumed: number;
}

const fixed = (view: DataView, offset: number): number => view.getInt32(offset) / 65536;

const check = (bytes: Uint8Array, offset: number, span: { limit: number; required: number }): void => {
  if (offset < 0 || span.limit > bytes.length || span.limit < offset || span.required > span.limit - offset) {
    throw new InvalidProfileError('truncated ICC tag data', 'bad-tag-data', { offset });
  }
};

const readSampledCurve = (view: DataView, offset: number, limit: number): ReadCurve => {
  // ICC.1:2022, 10.6 Table 35: zero entries are identity, one is u8Fixed8 gamma, and two or more are 16-bit samples.
  check(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset, { limit, required: 12 });
  const count = view.getUint32(offset + 8);
  if (count > Math.floor((limit - offset - 12) / 2)) throw new InvalidProfileError('truncated ICC curve table', 'bad-tag-data', { offset });
  if (count === 0) return { curve: { kind: 'identity' }, consumed: 12 };
  if (count === 1) return { curve: { kind: 'gamma', gamma: view.getUint16(offset + 12) / 256 }, consumed: 14 };
  const values = new Float64Array(count);
  for (let index = 0; index < count; index++) values[index] = view.getUint16(offset + 12 + index * 2) / 65535;
  return { curve: { kind: 'table', values }, consumed: 12 + count * 2 };
};

const readParametricCurve = (view: DataView, offset: number, limit: number): ReadCurve => {
  // ICC.1:2022, 10.18 Tables 67 and 68: function types 0–4 carry 1, 3, 4, 5 and 7 s15Fixed16 parameters.
  if (limit - offset < 12) throw new InvalidProfileError('truncated ICC parametric curve', 'bad-tag-data', { offset });
  const types = [0, 1, 2, 3, 4] as const;
  const counts = [1, 3, 4, 5, 7];
  const encoded = view.getUint16(offset + 8);
  const functionType = types[encoded];
  const count = counts[encoded];
  if (functionType === undefined || count === undefined || limit - offset < 12 + count * 4) {
    throw new InvalidProfileError('invalid ICC parametric curve', 'bad-tag-data', { offset });
  }
  const params = Array.from({ length: count }, (_, index) => fixed(view, offset + 12 + index * 4));
  return { curve: { kind: 'parametric', functionType, params }, consumed: 12 + count * 4 };
};

export const readCurve = (bytes: Uint8Array, offset: number, limit: number): ReadCurve => {
  check(bytes, offset, { limit, required: 8 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = iccSignature(bytes, offset);
  if (kind === 'curv') return readSampledCurve(view, offset, limit);
  if (kind === 'para') return readParametricCurve(view, offset, limit);
  throw new InvalidProfileError('ICC tag must be a curve', 'tag-type-mismatch', { offset });
};

export const readXyz = (bytes: Uint8Array, offset: number, limit: number): Xyz => {
  // ICC.1:2022, 10.31 Table 85: XYZType stores signed s15Fixed16 XYZ values after the eight-byte type header.
  check(bytes, offset, { limit, required: 20 });
  if (iccSignature(bytes, offset) !== 'XYZ ') throw new InvalidProfileError('ICC tag must be XYZType', 'tag-type-mismatch', { offset });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { x: fixed(view, offset + 8), y: fixed(view, offset + 12), z: fixed(view, offset + 16) };
};

export const readSf32 = (bytes: Uint8Array, offset: number, limit: number): Matrix3 => {
  // ICC.1:2022, 10.22 Table 76: s15Fixed16ArrayType stores signed four-byte values after the type header.
  check(bytes, offset, { limit, required: 44 });
  if (iccSignature(bytes, offset) !== 'sf32') throw new InvalidProfileError('ICC tag must be s15Fixed16ArrayType', 'tag-type-mismatch', { offset });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [
    fixed(view, offset + 8),
    fixed(view, offset + 12),
    fixed(view, offset + 16),
    fixed(view, offset + 20),
    fixed(view, offset + 24),
    fixed(view, offset + 28),
    fixed(view, offset + 32),
    fixed(view, offset + 36),
    fixed(view, offset + 40),
  ];
};

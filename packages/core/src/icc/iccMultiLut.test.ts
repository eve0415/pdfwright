import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { gammaCurveTag, matrixLutTag, sampledCurveTag } from '../testing/iccProfileBytes.ts';

import { readMultiLut } from './iccMultiLut.ts';

const identityCurve = (bytes: Uint8Array, offset: number): void => {
  bytes.set(new TextEncoder().encode('curv'), offset);
};

// ICC.1:2022, 10.6: a curveType with no entries is the identity, and one entry is a u8Fixed8 gamma.
const identityTag = (): Uint8Array => {
  const bytes = new Uint8Array(12);
  identityCurve(bytes, 0);
  return bytes;
};

const curvGammaTag = (raw: number): Uint8Array => {
  const bytes = new Uint8Array(14);
  const view = new DataView(bytes.buffer);
  identityCurve(bytes, 0);
  view.setUint32(8, 1);
  view.setUint16(12, raw);
  return bytes;
};

const padded = (length: number): number => Math.ceil(length / 4) * 4;

interface ClutSpec {
  readonly grid: ReadonlyArray<number>;
  readonly precision: number;
  readonly values: ReadonlyArray<number>;
}

interface PartsSpec {
  readonly b: ReadonlyArray<Uint8Array>;
  // Twelve raw s15Fixed16 integers.
  readonly matrix?: ReadonlyArray<number>;
  readonly m?: ReadonlyArray<Uint8Array>;
  readonly clut?: ClutSpec;
  readonly a?: ReadonlyArray<Uint8Array>;
}

const curvesPart = (curves: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(curves.reduce((sum, curve) => sum + padded(curve.length), 0));
  let cursor = 0;
  for (const curve of curves) {
    bytes.set(curve, cursor);
    cursor += padded(curve.length);
  }
  return bytes;
};

const matrixPart = (raw: ReadonlyArray<number>): Uint8Array => {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of raw.entries()) {
    view.setInt32(index * 4, value);
  }
  return bytes;
};

// ICC.1:2022, 10.12.3 Table 46: 16 grid-point bytes, a precision byte, three reserved bytes and the values.
const clutPart = (clut: ClutSpec): Uint8Array => {
  const bytes = new Uint8Array(20 + clut.values.length * clut.precision);
  const view = new DataView(bytes.buffer);
  bytes.set(clut.grid);
  bytes[16] = clut.precision;
  for (const [index, value] of clut.values.entries()) {
    if (clut.precision === 2) {
      view.setUint16(20 + index * 2, value);
    } else {
      bytes[20 + index] = value;
    }
  }
  return bytes;
};

type Element = 'b' | 'matrix' | 'm' | 'clut' | 'a';

// ICC.1:2022, 10.12.1 Table 45 and 10.13.1 Table 47: a 32-byte header with the element offsets, then each element 4-byte aligned, in the given order.
const multiLutTag = (
  type: 'mAB ' | 'mBA ',
  channels: readonly [number, number],
  parts: PartsSpec,
  order: ReadonlyArray<Element> = ['b', 'matrix', 'm', 'clut', 'a'],
): Uint8Array => {
  const data = {
    b: curvesPart(parts.b),
    matrix: parts.matrix === undefined ? undefined : matrixPart(parts.matrix),
    m: parts.m === undefined ? undefined : curvesPart(parts.m),
    clut: parts.clut === undefined ? undefined : clutPart(parts.clut),
    a: parts.a === undefined ? undefined : curvesPart(parts.a),
  };
  const fields = { b: 12, matrix: 16, m: 20, clut: 24, a: 28 } as const satisfies Record<Element, number>;
  const bytes = new Uint8Array(32 + order.reduce((sum, element) => sum + padded(data[element]?.length ?? 0), 0));
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(type));
  bytes.set(channels, 8);
  let cursor = 32;
  for (const element of order) {
    const part = data[element];
    if (part !== undefined) {
      view.setUint32(fields[element], cursor);
      bytes.set(part, cursor);
      cursor += padded(part.length);
    }
  }
  return bytes;
};

const START = 4;

// The tag four bytes into a larger buffer, so offsets reported relative to the buffer differ from offsets inside the tag.
const embedded = (tag: Uint8Array, size = tag.length): Uint8Array => {
  const bytes = new Uint8Array(START + Math.max(size, tag.length) + 4).fill(0xee);
  bytes.set(tag, START);
  return bytes;
};

const read = (tag: Uint8Array, size = tag.length): ReturnType<typeof readMultiLut> => readMultiLut(embedded(tag, size), START, START + size);

// Returns the reason and offset of an InvalidProfileError, and lets any other outcome fail the test.
const failure = (tag: Uint8Array, size = tag.length): 'accepted' | { readonly reason: string; readonly offset: number } => {
  try {
    read(tag, size);
    return 'accepted';
  } catch (error) {
    if (error instanceof InvalidProfileError) {
      return { reason: error.reason, offset: error.offset };
    }
    throw error;
  }
};

const setUint32 = (bytes: Uint8Array, offset: number, value: number): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  new DataView(copy.buffer).setUint32(offset, value);
  return copy;
};

const identities = (count: number): Array<Uint8Array> => Array.from({ length: count }, identityTag);

const gamma = (value: number) => ({ kind: 'parametric', functionType: 0, params: [Math.round(value * 65_536) / 65_536] });

describe('icc multi-process lut tags', () => {
  it('reads a B-only mAB pipeline', () => {
    // A 14-byte first curve is padded to 16, so a reader that skips the padding or does not advance reads the wrong curves.
    const tag = multiLutTag('mAB ', [3, 3], { b: [curvGammaTag(0x02_33), sampledCurveTag([0, 65_535]), identityTag()] });
    expect(read(tag)).toStrictEqual({
      kind: 'lutAtoB',
      b: [{ kind: 'gamma', gamma: 563 / 256 }, { kind: 'table', values: Uint16Array.of(0, 65_535) }, { kind: 'identity' }],
      matrix: undefined,
      m: undefined,
      clut: undefined,
      a: undefined,
    });
  });

  it('accepts an unpadded final curve', () => {
    const bytes = new Uint8Array(70);
    bytes.set(new TextEncoder().encode('mAB '));
    bytes[8] = 3;
    bytes[9] = 3;
    const view = new DataView(bytes.buffer);
    view.setUint32(12, 32);
    identityCurve(bytes, 32);
    identityCurve(bytes, 44);
    identityCurve(bytes, 56);
    view.setUint32(64, 1);
    view.setUint16(68, 256);
    expect(readMultiLut(bytes, 0, bytes.length).b).toHaveLength(3);
  });

  it('reads per-axis CLUT grid points in mBA and rejects invalid precision', () => {
    const clut = { grid: [2, 3, 4], precision: 1, values: Array.from({ length: 96 }, (_, index) => index + 1) };
    const a = [sampledCurveTag([1, 2]), sampledCurveTag([3, 4]), sampledCurveTag([5, 6]), gammaCurveTag(1.5)];
    const tag = multiLutTag('mBA ', [3, 4], { b: [gammaCurveTag(2.2), gammaCurveTag(1.8), identityTag()], clut, a });
    expect(read(tag)).toStrictEqual({
      kind: 'lutBtoA',
      b: [gamma(2.2), gamma(1.8), { kind: 'identity' }],
      matrix: undefined,
      m: undefined,
      clut: { gridPoints: [2, 3, 4], inputChannels: 3, outputChannels: 4, values: Uint8Array.from(clut.values) },
      a: [
        { kind: 'table', values: Uint16Array.of(1, 2) },
        { kind: 'table', values: Uint16Array.of(3, 4) },
        { kind: 'table', values: Uint16Array.of(5, 6) },
        gamma(1.5),
      ],
    });
    const clutAt = new DataView(tag.buffer).getUint32(24);
    tag[clutAt + 16] = 3;
    expect(() => read(tag)).toThrow(InvalidProfileError);
    expect(failure(tag)).toStrictEqual({ reason: 'bad-tag-data', offset: START + clutAt + 16 });
  });

  it.each(['mAB ', 'mBA '] as const)('reads a %s matrix as e1..e9 coefficients followed by e10..e12 offsets', type => {
    const elements = Array.from({ length: 12 }, (_, index) => (index + 1) / 16);
    const bytes = matrixLutTag(type, elements);
    expect(readMultiLut(bytes, 0, bytes.length).matrix).toStrictEqual({ m: elements.slice(0, 9), offset: elements.slice(9) });
  });

  it('reads a four-input, three-output mAB with every element', () => {
    // ICC.1:2022, 10.12.1: in lutAToBType the A curves follow the inputs, and the M and B curves follow the outputs.
    const clut = { grid: [2, 3, 2, 2], precision: 2, values: Array.from({ length: 72 }, (_, index) => index * 900) };
    const tag = multiLutTag('mAB ', [4, 3], {
      a: [sampledCurveTag([1, 2]), sampledCurveTag([3, 4]), sampledCurveTag([5, 6]), sampledCurveTag([7, 8])],
      clut,
      m: [gammaCurveTag(1.25), gammaCurveTag(1.5), gammaCurveTag(1.75)],
      matrix: Array.from({ length: 12 }, (_, index) => (index - 6) * 0x40_00),
      b: [gammaCurveTag(2), identityTag(), curvGammaTag(0x01_80)],
    });
    expect(read(tag)).toStrictEqual({
      kind: 'lutAtoB',
      b: [gamma(2), { kind: 'identity' }, { kind: 'gamma', gamma: 1.5 }],
      matrix: { m: [-1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5], offset: [0.75, 1, 1.25] },
      m: [gamma(1.25), gamma(1.5), gamma(1.75)],
      clut: { gridPoints: [2, 3, 2, 2], inputChannels: 4, outputChannels: 3, values: Uint16Array.from(clut.values) },
      a: [
        { kind: 'table', values: Uint16Array.of(1, 2) },
        { kind: 'table', values: Uint16Array.of(3, 4) },
        { kind: 'table', values: Uint16Array.of(5, 6) },
        { kind: 'table', values: Uint16Array.of(7, 8) },
      ],
    });
  });

  it('rejects a tag shorter than its header and a tag of another type', () => {
    const tag = multiLutTag('mAB ', [3, 3], { b: identities(3) });
    expect(failure(tag, 31)).toStrictEqual({ reason: 'bad-tag-data', offset: START });
    const other = Uint8Array.from(tag);
    other.set(new TextEncoder().encode('mft2'));
    expect(failure(other)).toStrictEqual({ reason: 'tag-type-mismatch', offset: START });
  });

  it.each([
    { name: 'no input channels', channels: [0, 3] },
    { name: '16 input channels', channels: [16, 3] },
    { name: 'no output channels', channels: [3, 0] },
    { name: '16 output channels', channels: [3, 16] },
  ] as const)('rejects an mAB with $name', ({ channels }) => {
    const tag = multiLutTag('mAB ', [3, 3], { b: identities(3) });
    tag.set(channels, 8);
    expect(failure(tag)).toStrictEqual({ reason: 'bad-tag-data', offset: START + 8 });
  });

  it('accepts 15 input and 15 output channels', () => {
    expect(read(multiLutTag('mBA ', [15, 15], { b: identities(15) })).b).toStrictEqual(Array.from({ length: 15 }, () => ({ kind: 'identity' })));
  });

  // ICC.1:2022, 10.12.1 Table 45: every element offset is 4-byte aligned and inside the tag, B is required, and A comes with a CLUT and M with a matrix.
  it.each([
    { name: 'a B offset that is not 4-byte aligned', field: 12, value: 34 },
    { name: 'a B offset inside the header', field: 12, value: 16 },
    { name: 'a B offset at the end of the tag', field: 12, value: 68 },
    { name: 'no B curves', field: 12, value: 0 },
    { name: 'A curves without a CLUT', field: 28, value: 32 },
    { name: 'a CLUT without A curves', field: 24, value: 32 },
    { name: 'M curves without a matrix', field: 20, value: 32 },
    { name: 'a matrix without M curves', field: 16, value: 32 },
  ])('rejects an mAB with $name', ({ field, value }) => {
    const tag = multiLutTag('mAB ', [3, 3], { b: identities(3) });
    expect(tag).toHaveLength(68);
    expect(failure(setUint32(tag, field, value))).toStrictEqual({ reason: 'bad-tag-data', offset: START });
  });

  it('requires a CLUT when the input and output channel counts differ', () => {
    const tag = multiLutTag('mAB ', [3, 4], { b: identities(4) });
    expect(failure(tag)).toStrictEqual({ reason: 'bad-tag-data', offset: START + 24 });
  });

  it('reads a matrix that has 48 bytes before the next element and rejects one with 47', () => {
    const tag = multiLutTag('mBA ', [3, 3], { b: identities(3), m: identities(3) });
    const matrixAt = tag.length;
    const withMatrix = new Uint8Array(matrixAt + 48);
    withMatrix.set(setUint32(tag, 16, matrixAt));
    withMatrix.set(matrixPart(Array.from({ length: 12 }, (_, index) => index * 0x1_00_00)), matrixAt);
    expect(read(withMatrix).matrix).toStrictEqual({ m: [0, 1, 2, 3, 4, 5, 6, 7, 8], offset: [9, 10, 11] });
    expect(failure(withMatrix, matrixAt + 47)).toStrictEqual({ reason: 'bad-tag-data', offset: START + matrixAt });
  });

  // ICC.1:2022, 10.12.3 Table 46: each grid has at least two points, the precision is 1 or 2, and the values fill the CLUT.
  it.each([
    { name: 'a CLUT of 19 bytes', edit: undefined, size: 19, offset: 0 },
    { name: 'a grid of one point on its second axis', edit: [1, 1], size: 28, offset: 1 },
    { name: 'a grid of no points on its first axis', edit: [0, 0], size: 28, offset: 0 },
    { name: 'a precision of 0', edit: [16, 0], size: 28, offset: 16 },
    { name: 'values one byte short', edit: undefined, size: 27, offset: 16 },
  ] as const)('rejects a CLUT with $name', ({ edit, size, offset }) => {
    // Three inputs with two grid points and one output: 8 one-byte values after the 20-byte CLUT header, as the last element of the tag.
    const clut = { grid: [2, 2, 2], precision: 1, values: [1, 2, 3, 4, 5, 6, 7, 8] };
    const tag = multiLutTag('mBA ', [3, 1], { b: identities(3), clut, a: identities(1) }, ['b', 'a', 'clut']);
    const clutAt = new DataView(tag.buffer).getUint32(24);
    expect(tag).toHaveLength(clutAt + 28);
    expect(read(tag).clut).toStrictEqual({ gridPoints: [2, 2, 2], inputChannels: 3, outputChannels: 1, values: Uint8Array.from(clut.values) });
    if (edit !== undefined) {
      tag[clutAt + edit[0]] = edit[1];
    }
    expect(failure(tag, clutAt + size)).toStrictEqual({ reason: 'bad-tag-data', offset: START + clutAt + offset });
  });

  it('caps a CLUT with per-axis grids at exactly 16,777,216 entries', () => {
    const grid = [16, 16, 16, 16, 16, 16];
    // Six inputs with 16 grid points and one output is exactly the cap, so it passes the cap and fails only for its missing values.
    const exact = multiLutTag('mAB ', [6, 1], { b: identities(1), a: identities(6), clut: { grid, precision: 1, values: [] } }, ['b', 'a', 'clut']);
    const clutAt = new DataView(exact.buffer).getUint32(24);
    expect(failure(exact)).toStrictEqual({ reason: 'bad-tag-data', offset: START + clutAt + 16 });
    const over = multiLutTag('mAB ', [6, 2], { b: identities(2), a: identities(6), clut: { grid, precision: 1, values: [] } }, ['b', 'a', 'clut']);
    expect(() => read(over)).toThrow(ResourceLimitError);
  });

  it('stops each curve element at the next element', () => {
    // ICC.1:2022, 10.12.1: each element ends where another begins, so a curve may not run into the matrix after it.
    const tag = multiLutTag('mBA ', [3, 3], { b: identities(3), matrix: Array.from({ length: 12 }, () => 0), m: identities(3) });
    expect(read(tag).b).toStrictEqual(Array.from({ length: 3 }, () => ({ kind: 'identity' })));
    expect(failure(setUint32(tag, 16, 56))).toStrictEqual({ reason: 'bad-tag-data', offset: START + 56 });
  });

  it('rejects a second curve that would start past the end of its element', () => {
    // The first curve is 14 bytes, padded to 16, so the second would start at 48 in a 46-byte tag.
    const tag = multiLutTag('mAB ', [2, 2], { b: [curvGammaTag(0x01_00), identityTag()] });
    expect(failure(tag, 46)).toStrictEqual({ reason: 'bad-tag-data', offset: START + 48 });
  });
});

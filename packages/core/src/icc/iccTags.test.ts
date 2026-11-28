import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { gammaCurveTag, sampledCurveTag, xyzTag } from '../testing/iccProfileBytes.ts';

import { readCurve, readSf32, readXyz } from './iccTags.ts';

const type = (bytes: Uint8Array, name: string): void => {
  bytes.set(new TextEncoder().encode(name));
};

// ICC.1:2022, 10.18 Table 68: parametric function types 0 to 4 carry 1, 3, 4, 5 and 7 parameters.
const parameterCounts = [1, 3, 4, 5, 7] as const;

// A parametricCurveType whose s15Fixed16 parameters are the given raw 32-bit integers.
const parametricTag = (functionType: number, raw: ReadonlyArray<number>): Uint8Array => {
  const bytes = new Uint8Array(12 + raw.length * 4);
  const view = new DataView(bytes.buffer);
  type(bytes, 'para');
  view.setUint16(8, functionType);
  for (const [index, value] of raw.entries()) {
    view.setInt32(12 + index * 4, value);
  }
  return bytes;
};

// An s15Fixed16ArrayType with nine values given as raw 32-bit integers.
const sf32Tag = (raw: ReadonlyArray<number>): Uint8Array => {
  const bytes = new Uint8Array(8 + raw.length * 4);
  const view = new DataView(bytes.buffer);
  type(bytes, 'sf32');
  for (const [index, value] of raw.entries()) {
    view.setInt32(8 + index * 4, value);
  }
  return bytes;
};

// The tag as a view that starts five bytes into a larger buffer, so a reader that ignores the view's own start reads the wrong bytes.
const at = (tag: Uint8Array): Uint8Array => {
  const host = new Uint8Array(tag.length + 7).fill(0xee);
  host.set(tag, 5);
  return host.subarray(5, 5 + tag.length);
};

const curvTag = (count: number, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  type(bytes, 'curv');
  new DataView(bytes.buffer).setUint32(8, count);
  return bytes;
};

describe('icc basic tags', () => {
  it('reads identity, gamma, sampled and parametric curves', () => {
    const identity = new Uint8Array(12);
    type(identity, 'curv');
    expect(readCurve(identity, 0, identity.length).curve).toStrictEqual({ kind: 'identity' });
    const gamma = new Uint8Array(14);
    type(gamma, 'curv');
    const gammaView = new DataView(gamma.buffer);
    gammaView.setUint32(8, 1);
    gammaView.setUint16(12, 0x02_33);
    expect(readCurve(gamma, 0, gamma.length).curve).toStrictEqual({ kind: 'gamma', gamma: 563 / 256 });
    const table = new Uint8Array(18);
    type(table, 'curv');
    const tableView = new DataView(table.buffer);
    tableView.setUint32(8, 3);
    tableView.setUint16(12, 0);
    tableView.setUint16(14, 32_768);
    tableView.setUint16(16, 65_535);
    expect(readCurve(table, 0, table.length).curve).toStrictEqual({ kind: 'table', values: Uint16Array.of(0, 32_768, 65_535) });
    const parametric = new Uint8Array(32);
    type(parametric, 'para');
    const paramView = new DataView(parametric.buffer);
    paramView.setUint16(8, 3);
    for (let index = 0; index < 5; index++) {
      paramView.setInt32(12 + index * 4, (index + 1) * 65_536);
    }
    expect(readCurve(parametric, 0, parametric.length).curve).toStrictEqual({ kind: 'parametric', functionType: 3, params: [1, 2, 3, 4, 5] });
  });

  it('reads fixed XYZ and matrix values and rejects truncated tags', () => {
    const xyz = new Uint8Array(20);
    type(xyz, 'XYZ ');
    const xyzView = new DataView(xyz.buffer);
    // ICC.1:2022, 4.6: s15Fixed16Number is signed, so FFFF8000h is -0.5.
    xyzView.setUint32(8, 0xff_ff_80_00);
    xyzView.setInt32(12, 0x00_01_00_00);
    xyzView.setInt32(16, 0x00_00_d3_2d);
    expect(readXyz(xyz, 0, xyz.length)).toStrictEqual({ x: -0.5, y: 1, z: 0xd3_2d / 65_536 });
    const sf32 = sf32Tag(Array.from({ length: 9 }, (_, index) => (index - 4) * 65_536));
    expect(readSf32(sf32, 0, sf32.length)).toStrictEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
    // ICC.1:2022, 10.31 and 10.22: an XYZType holds 20 bytes and a nine-value s15Fixed16ArrayType 44.
    expect(() => readXyz(xyz, 0, 19)).toThrow(InvalidProfileError);
    expect(() => readXyz(xyz, 0, 19)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: 0 }));
    expect(() => readSf32(sf32, 0, 43)).toThrow(InvalidProfileError);
    expect(() => readSf32(sf32, 0, 43)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: 0 }));
  });

  // ICC.1:2022, 10.6 Table 35: a curveType holds a 12-byte header and two bytes per entry.
  it.each([
    { name: 'no entries', count: 0, length: 12, consumed: 12, curve: { kind: 'identity' } },
    { name: 'one entry', count: 1, length: 14, consumed: 14, curve: { kind: 'gamma', gamma: 0 } },
    { name: 'two entries', count: 2, length: 16, consumed: 16, curve: { kind: 'table', values: new Uint16Array(2) } },
  ])('reads a curveType with $name and reports the bytes it used', ({ count, length, consumed, curve }) => {
    const bytes = curvTag(count, length + 4);
    expect(readCurve(bytes, 0, length)).toStrictEqual({ curve, consumed });
  });

  it.each([
    { name: 'no entries', count: 0, length: 11 },
    { name: 'one entry', count: 1, length: 13 },
    { name: 'two entries', count: 2, length: 15 },
  ])('rejects a curveType with $name one byte short', ({ count, length }) => {
    const bytes = curvTag(count, length + 4);
    expect(() => readCurve(bytes, 0, length)).toThrow(InvalidProfileError);
    expect(() => readCurve(bytes, 0, length)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: 0 }));
  });

  it.each([0, 1, 2, 3, 4] as const)('reads parametric function type %i at exactly its length and rejects one byte less', functionType => {
    const count = parameterCounts[functionType];
    const raw = Array.from({ length: count }, (_, index) => (index + 1) * 0x1_00_00 + index);
    const bytes = parametricTag(functionType, raw);
    expect(readCurve(bytes, 0, bytes.length)).toStrictEqual({
      curve: { kind: 'parametric', functionType, params: raw.map(value => value / 65_536) },
      consumed: 12 + count * 4,
    });
    expect(() => readCurve(bytes, 0, bytes.length - 1)).toThrow(InvalidProfileError);
    expect(() => readCurve(bytes, 0, bytes.length - 1)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: 0 }));
  });

  it('rejects parametric function type 5 and a parametric curve shorter than its header', () => {
    const typeFive = parametricTag(
      5,
      Array.from({ length: 8 }, () => 0x1_00_00),
    );
    expect(() => readCurve(typeFive, 0, typeFive.length)).toThrow(InvalidProfileError);
    expect(() => readCurve(typeFive, 0, typeFive.length)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: 0 }));
    // ICC.1:2022, 10.18 Table 67: the function type sits at bytes 8 and 9, so a tag that ends at byte 9 cannot hold it.
    const header = parametricTag(0, [0x1_00_00]).slice(0, 9);
    expect(() => readCurve(header, 0, header.length)).toThrow(InvalidProfileError);
    expect(() => readCurve(header, 0, header.length)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: 0 }));
  });

  it('reads negative parametric parameters', () => {
    const bytes = parametricTag(1, [0x2_00_00, 0xff_ff_00_00 | 0, 0xff_fe_80_00 | 0]);
    expect(readCurve(bytes, 0, bytes.length).curve).toStrictEqual({ kind: 'parametric', functionType: 1, params: [2, -1, -1.5] });
  });

  it('rejects a curve of another type', () => {
    const bytes = xyzTag([0.5, 0.25, 0.125]);
    expect(() => readCurve(bytes, 0, bytes.length)).toThrow(InvalidProfileError);
    expect(() => readCurve(bytes, 0, bytes.length)).toThrow(expect.objectContaining({ reason: 'tag-type-mismatch', offset: 0 }));
  });

  it.each([
    { name: 'a negative offset', offset: -1, limit: 20 },
    { name: 'a limit past the bytes', offset: 0, limit: 21 },
    { name: 'a limit before the offset', offset: 8, limit: 4 },
  ])('rejects $name', ({ offset, limit }) => {
    const bytes = xyzTag([0.5, 0.25, 0.125]);
    expect(() => readXyz(bytes, offset, limit)).toThrow(InvalidProfileError);
    expect(() => readXyz(bytes, offset, limit)).toThrow(expect.objectContaining({ reason: 'bad-tag-data' }));
    const curve = gammaCurveTag(2.2);
    expect(() => readCurve(curve, offset, limit - 4)).toThrow(InvalidProfileError);
    expect(() => readCurve(curve, offset, limit - 4)).toThrow(expect.objectContaining({ reason: 'bad-tag-data' }));
  });

  it('reads each tag through a view that starts inside its buffer', () => {
    const xyz = at(xyzTag([0.5, -0.25, 0.125]));
    const sf32 = at(sf32Tag(Array.from({ length: 9 }, (_, index) => index * 0x80_00)));
    const sampled = at(sampledCurveTag([1, 2, 3]));
    const parametric = at(parametricTag(0, [0x2_33_33]));
    expect([
      readXyz(xyz, 0, xyz.length),
      readSf32(sf32, 0, sf32.length),
      readCurve(sampled, 0, sampled.length),
      readCurve(parametric, 0, parametric.length),
    ]).toStrictEqual([
      { x: 0.5, y: -0.25, z: 0.125 },
      [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
      { curve: { kind: 'table', values: Uint16Array.of(1, 2, 3) }, consumed: 18 },
      { curve: { kind: 'parametric', functionType: 0, params: [0x2_33_33 / 65_536] }, consumed: 16 },
    ]);
  });

  describe('properties', () => {
    const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 });

    it('reads every s15Fixed16 value an XYZType or s15Fixed16ArrayType holds', () => {
      fc.assert(
        fc.property(fc.array(int32, { minLength: 9, maxLength: 9 }), raw => {
          const xyz = new Uint8Array(20);
          type(xyz, 'XYZ ');
          const view = new DataView(xyz.buffer);
          for (let index = 0; index < 3; index++) {
            view.setInt32(8 + index * 4, raw[index] ?? 0);
          }
          const values = raw.map(value => value / 65_536);
          expect(readXyz(xyz, 0, xyz.length)).toStrictEqual({ x: values[0], y: values[1], z: values[2] });
          expect(readSf32(sf32Tag(raw), 0, 44)).toStrictEqual(values);
        }),
      );
    });

    const curveTags = fc.oneof(
      fc.array(fc.integer({ min: 0, max: 0xff_ff }), { minLength: 2, maxLength: 64 }).map(samples => ({
        bytes: sampledCurveTag(samples),
        curve: { kind: 'table', values: Uint16Array.from(samples) },
      })),
      fc.integer({ min: 0, max: 4 }).chain(functionType =>
        fc.array(int32, { minLength: parameterCounts[functionType] ?? 1, maxLength: parameterCounts[functionType] ?? 1 }).map(raw => ({
          bytes: parametricTag(functionType, raw),
          curve: { kind: 'parametric', functionType, params: raw.map(value => value / 65_536) },
        })),
      ),
    );

    it('decodes an encoded curve and reports its encoded length as consumed', () => {
      fc.assert(
        fc.property(curveTags, ({ bytes, curve }) => {
          expect(readCurve(bytes, 0, bytes.length)).toStrictEqual({ curve, consumed: bytes.length });
        }),
      );
    });

    it('rejects every truncation of an encoded curve as bad tag data', () => {
      fc.assert(
        fc.property(curveTags, fc.nat(), ({ bytes }, cut) => {
          const limit = cut % bytes.length;
          expect(() => readCurve(bytes, 0, limit)).toThrow(InvalidProfileError);
          expect(() => readCurve(bytes, 0, limit)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: 0 }));
        }),
      );
    });
  });
});

import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { readLut } from './iccLut.ts';

const matrix = (view: DataView): void => {
  for (let index = 0; index < 9; index++) view.setInt32(12 + index * 4, index % 4 === 0 ? 65536 : 0);
};

describe('icc lut8 and lut16 tags', () => {
  it('reads lut8 tables and a two-point CLUT in channel order', () => {
    const bytes = new Uint8Array(562);
    bytes.set(new TextEncoder().encode('mft1'));
    bytes[8] = 1;
    bytes[9] = 1;
    bytes[10] = 2;
    matrix(new DataView(bytes.buffer));
    for (let index = 0; index < 256; index++) {
      bytes[48 + index] = index;
      bytes[306 + index] = index;
    }
    bytes[304] = 0;
    bytes[305] = 255;
    const lut = readLut(bytes, 0, bytes.length);
    expect(lut.kind).toBe('lut8');
    expect(lut.input[0]).toStrictEqual({ kind: 'table', values: Uint8Array.from({ length: 256 }, (_, index) => index) });
    expect(lut.clut.gridPoints).toStrictEqual([2]);
    expect([...lut.clut.values]).toStrictEqual([0, 255]);
  });

  it('reads lut16 tables and rejects an undersized CLUT', () => {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('mft2'));
    bytes[8] = 1;
    bytes[9] = 1;
    bytes[10] = 2;
    matrix(view);
    view.setUint16(48, 2);
    view.setUint16(50, 2);
    view.setUint16(52, 0);
    view.setUint16(54, 65535);
    view.setUint16(56, 0);
    view.setUint16(58, 65535);
    view.setUint16(60, 0);
    view.setUint16(62, 65535);
    const lut = readLut(bytes, 0, bytes.length);
    expect(lut.kind).toBe('lut16');
    expect([...lut.clut.values]).toStrictEqual([0, 65535]);
    expect(() => readLut(bytes, 0, 58)).toThrow(InvalidProfileError);
  });
});

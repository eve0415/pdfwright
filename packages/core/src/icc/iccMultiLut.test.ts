import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { readMultiLut } from './iccMultiLut.ts';

const identityCurve = (bytes: Uint8Array, offset: number): void => {
  bytes.set(new TextEncoder().encode('curv'), offset);
};

describe('icc multi-process lut tags', () => {
  it('reads a B-only mAB pipeline', () => {
    const bytes = new Uint8Array(68);
    bytes.set(new TextEncoder().encode('mAB '));
    bytes[8] = 3;
    bytes[9] = 3;
    new DataView(bytes.buffer).setUint32(12, 32);
    for (let index = 0; index < 3; index++) identityCurve(bytes, 32 + index * 12);
    const lut = readMultiLut(bytes, 0, bytes.length);
    expect(lut.kind).toBe('lutAtoB');
    expect(lut.b).toHaveLength(3);
    expect(lut.clut).toBeUndefined();
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
    const bytes = new Uint8Array(168);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('mBA '));
    bytes[8] = 3;
    bytes[9] = 4;
    view.setUint32(12, 32);
    view.setUint32(24, 68);
    view.setUint32(28, 120);
    for (let index = 0; index < 3; index++) identityCurve(bytes, 32 + index * 12);
    bytes.set([2, 2, 2], 68);
    bytes[84] = 1;
    for (let index = 0; index < 32; index++) bytes[88 + index] = index;
    for (let index = 0; index < 4; index++) identityCurve(bytes, 120 + index * 12);
    const lut = readMultiLut(bytes, 0, bytes.length);
    expect(lut.kind).toBe('lutBtoA');
    expect(lut.clut?.gridPoints).toStrictEqual([2, 2, 2]);
    expect(lut.clut?.values[31]).toBe(31 / 255);
    bytes[84] = 3;
    expect(() => readMultiLut(bytes, 0, bytes.length)).toThrow(InvalidProfileError);
  });
});

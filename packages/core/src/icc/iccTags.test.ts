import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { readCurve, readSf32, readXyz } from './iccTags.ts';

const type = (bytes: Uint8Array, name: string): void => {
  bytes.set(new TextEncoder().encode(name));
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
    gammaView.setUint16(12, 0x0233);
    expect(readCurve(gamma, 0, gamma.length).curve).toStrictEqual({ kind: 'gamma', gamma: 563 / 256 });
    const table = new Uint8Array(18);
    type(table, 'curv');
    const tableView = new DataView(table.buffer);
    tableView.setUint32(8, 3);
    tableView.setUint16(12, 0);
    tableView.setUint16(14, 32768);
    tableView.setUint16(16, 65535);
    expect(readCurve(table, 0, table.length).curve).toStrictEqual({ kind: 'table', values: Uint16Array.of(0, 32768, 65535) });
    const parametric = new Uint8Array(32);
    type(parametric, 'para');
    const paramView = new DataView(parametric.buffer);
    paramView.setUint16(8, 3);
    for (let index = 0; index < 5; index++) paramView.setInt32(12 + index * 4, (index + 1) * 65536);
    expect(readCurve(parametric, 0, parametric.length).curve).toStrictEqual({ kind: 'parametric', functionType: 3, params: [1, 2, 3, 4, 5] });
  });

  it('reads fixed XYZ and matrix values and rejects truncated tags', () => {
    const xyz = new Uint8Array(20);
    type(xyz, 'XYZ ');
    const xyzView = new DataView(xyz.buffer);
    xyzView.setInt32(8, 0x0000f6d6);
    xyzView.setInt32(12, 0x00010000);
    xyzView.setInt32(16, 0x0000d32d);
    expect(readXyz(xyz, 0, xyz.length)).toStrictEqual({ x: 0xf6d6 / 65536, y: 1, z: 0xd32d / 65536 });
    const sf32 = new Uint8Array(44);
    type(sf32, 'sf32');
    const view = new DataView(sf32.buffer);
    for (let index = 0; index < 9; index++) view.setInt32(8 + index * 4, index * 65536);
    expect(readSf32(sf32, 0, sf32.length)).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => readCurve(xyz, 0, 11)).toThrow(InvalidProfileError);
  });
});

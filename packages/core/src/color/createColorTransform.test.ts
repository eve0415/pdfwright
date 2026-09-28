import type { TableLut } from '../icc/iccLut.ts';
import type { IccProfile } from '../icc/iccProfile.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { md5 } from '../hash/md5.ts';

import { createColorTransform } from './createColorTransform.ts';

const D50 = { x: 0.9642, y: 1, z: 0.8249 };
const identity = { kind: 'identity' } as const;
const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

const source = (): IccProfile => ({
  header: {
    size: 132,
    version: { major: 4, minor: 0, bugfix: 0 },
    profileClass: 'display',
    colorSpace: 'RGB',
    pcs: 'XYZ',
    renderingIntent: 'relativeColorimetric',
    illuminant: D50,
    profileId: new Uint8Array(16),
  },
  description: undefined,
  copyright: undefined,
  mediaWhitePoint: D50,
  mediaBlackPoint: undefined,
  chromaticAdaptation: undefined,
  colorants: { red: D50, green: { x: 0, y: 0, z: 0 }, blue: { x: 0, y: 0, z: 0 } },
  trc: { red: identity, green: identity, blue: identity },
  deviceToPcs: {},
  pcsToDevice: {},
  identity: new Uint8Array(16),
  bytes: new Uint8Array(132),
  warnings: [],
});

const destination = (): IccProfile => {
  const values = new Float64Array(32);
  let index = 0;
  for (let l = 0; l < 2; l++) {
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        values.set([a, b, l, 0], index);
        index += 4;
      }
    }
  }
  const table = { kind: 'table' as const, values: Float64Array.from({ length: 256 }, (_, sample) => sample / 255) };
  const lut: TableLut = {
    kind: 'lut8',
    matrix,
    input: [table, table, table],
    clut: { gridPoints: [2, 2, 2], inputChannels: 3, outputChannels: 4, values },
    output: [table, table, table, table],
  };
  return {
    ...source(),
    header: { ...source().header, profileClass: 'output', colorSpace: 'CMYK', pcs: 'Lab' },
    colorants: undefined,
    trc: undefined,
    pcsToDevice: { 1: lut },
  };
};

describe('icc colour transforms', () => {
  it('selects the ICC lut8 Lab encoding by default and permits the alternate midpoint', () => {
    const src = { kind: 'icc' as const, profile: source() };
    const dst = destination();
    const input = Float64Array.of(0.184, 0, 0);
    const icc = new Float64Array(4);
    const alternate = new Float64Array(4);
    createColorTransform(src, dst, { intent: 'relativeColorimetric', blackPointCompensation: false }).convert(input, icc);
    createColorTransform(src, dst, { intent: 'relativeColorimetric', blackPointCompensation: false, lut8LabEncoding: 'adobe' }).convert(input, alternate);
    expect(icc[0]).toBeCloseTo(128 / 255, 6);
    expect(alternate[0]).toBeCloseTo(0.5, 6);
    expect(Number(icc[0]) - Number(alternate[0])).toBeCloseTo(0.5 / 255, 6);
  });

  it('reads lut8 Lab output with both neutral a and b midpoints', () => {
    const table = { kind: 'table' as const, values: Float64Array.from({ length: 256 }, (_, sample) => sample / 255) };
    const values = new Float64Array(24);
    for (let index = 0; index < 8; index++) values.set([0.5, 0.5, 0.5], index * 3);
    const lut: TableLut = {
      kind: 'lut8',
      matrix,
      input: [table, table, table],
      clut: { gridPoints: [2, 2, 2], inputChannels: 3, outputChannels: 3, values },
      output: [table, table, table],
    };
    const labSource: IccProfile = { ...source(), header: { ...source().header, pcs: 'Lab' }, deviceToPcs: { 1: lut } };
    const rgbDestination: IccProfile = {
      ...source(),
      colorants: { red: { x: 1, y: 0, z: 0 }, green: { x: 0, y: 1, z: 0 }, blue: { x: 0, y: 0, z: 1 } },
    };
    const icc = new Float64Array(3);
    const alternate = new Float64Array(3);
    createColorTransform({ kind: 'icc', profile: labSource }, rgbDestination, { intent: 'relativeColorimetric', blackPointCompensation: false }).convert(
      Float64Array.of(0.3, 0.3, 0.3),
      icc,
    );
    createColorTransform({ kind: 'icc', profile: labSource }, rgbDestination, {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
      lut8LabEncoding: 'adobe',
    }).convert(Float64Array.of(0.3, 0.3, 0.3), alternate);
    expect(Number(alternate[0]) - Number(icc[0])).toBeGreaterThan(0.0008);
  });

  it('rejects a singular matrix when a destination needs its inverse', () => {
    expect(() => createColorTransform({ kind: 'icc', profile: source() }, source(), { intent: 'relativeColorimetric', blackPointCompensation: false })).toThrow(
      InvalidProfileError,
    );
  });

  it('keeps the complete pipeline digest identical across runtimes', () => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
    });
    const bytes = new Uint8Array(4096 * 4 * 8);
    const view = new DataView(bytes.buffer);
    const output = new Float64Array(4);
    for (let index = 0; index < 4096; index++) {
      transform.convert(Float64Array.of((index + 0.5) / 4096, 0, 0), output);
      for (let channel = 0; channel < 4; channel++) view.setFloat64((index * 4 + channel) * 8, Number(output[channel]), true);
    }
    const digest = [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('cacc8d97316e725b4d13f347e0acdae6');
  });

  it('converts 8 and 16 bit rows like scalar calls across cache collisions', () => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
    });
    const input8 = Uint8Array.of(0, 0, 17, 0, 1, 0, 0, 0, 17, 128, 128, 128);
    const output8 = new Uint8Array(16);
    transform.convertRow8(input8, output8, 4);
    const scalar = new Float64Array(4);
    for (let pixel = 0; pixel < 4; pixel++) {
      transform.convert(
        Float64Array.from(input8.subarray(pixel * 3, pixel * 3 + 3), value => value / 255),
        scalar,
      );
      for (let channel = 0; channel < 4; channel++) expect(output8[pixel * 4 + channel]).toBe(Math.round(Number(scalar[channel]) * 255));
    }
    const input16 = Uint16Array.of(0, 0, 0, 32768, 32768, 32768, 65535, 65535, 65535);
    const output16 = new Uint16Array(12);
    transform.convertRow16(input16, output16, 3);
    for (let pixel = 0; pixel < 3; pixel++) {
      transform.convert(
        Float64Array.from(input16.subarray(pixel * 3, pixel * 3 + 3), value => value / 65535),
        scalar,
      );
      for (let channel = 0; channel < 4; channel++) expect(output16[pixel * 4 + channel]).toBe(Math.round(Number(scalar[channel]) * 65535));
    }
  });

  it('rejects row buffers shorter than their requested pixel count', () => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
    });
    expect(() => {
      transform.convertRow8(new Uint8Array(2), new Uint8Array(4), 1);
    }).toThrow(InvalidArgumentError);
    expect(() => {
      transform.convertRow16(new Uint16Array(3), new Uint16Array(3), 1);
    }).toThrow(InvalidArgumentError);
  });
});

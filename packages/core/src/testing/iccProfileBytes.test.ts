import { describe, expect, it } from 'vitest';

import { parseIccProfile } from '../icc/iccProfile.ts';
import { parseIccStructure } from '../icc/iccStructure.ts';

import { gammaCurveTag, iccProfileBytes, matrixLutTag, sampledCurveTag, xyzTag } from './iccProfileBytes.ts';

const RED = [0.4361, 0.2225, 0.0139] as const;
const GREEN = [0.3851, 0.7169, 0.0971] as const;
// A negative component, so that a reading of s15Fixed16Number as unsigned shows.
const BLUE = [-0.1431, 0.0606, 0.7141] as const;

const rgb = (): Uint8Array =>
  iccProfileBytes({
    profileClass: 'scnr',
    colorSpace: 'RGB ',
    pcs: 'Lab ',
    tags: [
      ['rXYZ', xyzTag(RED)],
      ['gXYZ', xyzTag(GREEN)],
      ['bXYZ', xyzTag(BLUE)],
      ['rTRC', gammaCurveTag(2.2)],
      ['gTRC', sampledCurveTag([0, 30_000, 65_535])],
      ['bTRC', gammaCurveTag(1.8)],
    ],
  });

const xyz = (values: { readonly x: number; readonly y: number; readonly z: number } | undefined): ReadonlyArray<number> =>
  values === undefined ? [] : [values.x, values.y, values.z];

describe('ICC profile bytes', () => {
  it('writes a version 4.4 header with the class, colour spaces and size it was given', () => {
    const bytes = rgb();
    const { header } = parseIccProfile(bytes);
    expect([header.size, header.version, header.profileClass, header.colorSpace, header.pcs]).toStrictEqual([
      bytes.length,
      { major: 4, minor: 4, bugfix: 0 },
      'input',
      'RGB',
      'Lab',
    ]);
  });

  it('writes the added tags first and every tag 4-byte aligned without overlap', () => {
    const structure = parseIccStructure(rgb());
    expect(structure.tags.map(tag => tag.signature)).toStrictEqual(['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']);
    expect(structure.tags.filter(tag => tag.offset % 4 !== 0)).toStrictEqual([]);
    expect(structure.warnings).toStrictEqual([]);
  });

  it('writes XYZ values within one s15Fixed16Number step, curves and texts as given', () => {
    const profile = parseIccProfile(rgb());
    const step = 1 / 65_536;
    const colorants = profile.colorants;
    for (const [read, written] of [
      [xyz(colorants?.red), RED],
      [xyz(colorants?.green), GREEN],
      [xyz(colorants?.blue), BLUE],
      [xyz(profile.mediaWhitePoint), [0.9642, 1, 0.8249]],
    ] as const) {
      expect(read).toHaveLength(3);
      for (const [index, value] of read.entries()) {
        expect(Math.abs(value - (written[index] ?? Number.NaN))).toBeLessThanOrEqual(step / 2);
      }
    }
    const trc = profile.trc;
    expect(trc !== undefined && 'red' in trc ? [trc.red, trc.green, trc.blue] : []).toStrictEqual([
      { kind: 'parametric', functionType: 0, params: [Math.round(2.2 * 65_536) / 65_536] },
      { kind: 'table', values: Uint16Array.from([0, 30_000, 65_535]) },
      { kind: 'parametric', functionType: 0, params: [Math.round(1.8 * 65_536) / 65_536] },
    ]);
    expect([profile.description, profile.copyright]).toStrictEqual(['Test profile', 'No copyright, use freely']);
  });

  it.each([
    ['a three-character class', { profileClass: 'mnt' }],
    ['a five-character colour space', { colorSpace: 'GRAY ' }],
    ['a non-ASCII class', { profileClass: 'mnté' }],
    ['a three-character tag signature', { tags: [['kTR', gammaCurveTag(1)]] }],
    ['a tag the builder already adds', { tags: [['wtpt', xyzTag([0.95, 1, 1.09])]] }],
  ] as const)('refuses %s', (_, input) => {
    expect(() => iccProfileBytes({ profileClass: 'mntr', colorSpace: 'GRAY', pcs: 'XYZ ', tags: [['kTRC', gammaCurveTag(1)]], ...input })).toThrow(RangeError);
  });

  it('refuses fixed-point values outside s15Fixed16Number and accepts its limits', () => {
    expect(() => xyzTag([32_768, 0, 0])).toThrow(RangeError);
    expect(() => xyzTag([-32_768.00001, 0, 0])).toThrow(RangeError);
    expect(() => gammaCurveTag(Number.NaN)).toThrow(RangeError);
    const limits = xyzTag([-32_768, 32_767 + 65_535 / 65_536, 0]);
    expect(Array.from({ length: 2 }, (_, index) => new DataView(limits.buffer).getInt32(8 + 4 * index))).toStrictEqual([-(2 ** 31), 2 ** 31 - 1]);
  });

  it.each([
    ['a single sample', [65_535]],
    ['no samples', []],
    ['a sample above 65535', [0, 65_536]],
    ['a negative sample', [-1, 65_535]],
    ['a fractional sample', [0, 0.5]],
  ])('refuses a sampled curve with %s', (_, samples) => {
    expect(() => sampledCurveTag(samples)).toThrow(RangeError);
  });

  it.each([11, 13])('refuses a matrix of %i elements', count => {
    expect(() =>
      matrixLutTag(
        'mAB ',
        Array.from({ length: count }, () => 0),
      ),
    ).toThrow(RangeError);
  });
});

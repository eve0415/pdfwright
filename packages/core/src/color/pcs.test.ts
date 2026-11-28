import type { LutTag } from '../icc/iccProfile.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodePcs, encodePcs, labToXyz, xyzToLab } from './pcs.ts';
import { lut8, PCS_D50 } from './testing/iccProfiles.ts';
import { largestDifference } from './testing/largestDifference.ts';

const D50 = [PCS_D50.x, PCS_D50.y, PCS_D50.z] as const;

const lut8Tag: LutTag = lut8(3, 3, ([l = 0, a = 0, b = 0]) => [l * 255, a * 255, b * 255]);
const lut16Tag: LutTag = { ...lut8Tag, kind: 'lut16' };
const lutBtoATag: LutTag = { kind: 'lutBtoA', b: [] };

// CIE 15:2004, 8.2.1 (ICC.1:2022, Annex A, Equations A.4–A.6), written out with the engine's cbrt: L*a*b* relative to the D50 PCS white.
const KAPPA = 24_389 / 27;
const EPSILON = 216 / 24_389;
const f = (ratio: number): number => (ratio > EPSILON ? Math.cbrt(ratio) : (KAPPA * ratio + 16) / 116);
const cieLab = (xyz: ReadonlyArray<number>): Array<number> => {
  const [fx, fy, fz] = xyz.map((value, index) => f(value / (D50[index] ?? 1)));
  return [116 * (fy ?? 0) - 16, 500 * ((fx ?? 0) - (fy ?? 0)), 200 * ((fy ?? 0) - (fz ?? 0))];
};

const component = (max: number): fc.Arbitrary<number> => fc.double({ min: 0, max, noNaN: true });

describe('PCS L*a*b* conversion', () => {
  it('maps the D50 white to L* 100 and back', () => {
    expect(largestDifference(xyzToLab(D50), [100, 0, 0])).toBeLessThan(1e-12);
    expect(largestDifference(labToXyz([100, 0, 0]), D50)).toBeLessThan(1e-12);
  });

  it('maps black to black in both directions', () => {
    expect(largestDifference(xyzToLab([0, 0, 0]), [0, 0, 0])).toBeLessThan(1e-12);
    expect(largestDifference(labToXyz([0, 0, 0]), [0, 0, 0])).toBeLessThan(1e-12);
  });

  it.each([{ xyz: [0.3, 0.4, 0.2] }, { xyz: [0.05, 0.02, 0.6] }, { xyz: [0.004, 0.005, 0.003] }, { xyz: [-0.01, -0.02, 0.001] }])(
    'follows the CIE definition at $xyz',
    ({ xyz }) => {
      expect(largestDifference(xyzToLab(xyz), cieLab(xyz))).toBeLessThan(1e-9);
    },
  );

  it('follows the linear segment below the cube threshold, including negative luminance', () => {
    expect(xyzToLab([0, 0.005, 0])[0]).toBeCloseTo(KAPPA * 0.005, 9);
    expect(xyzToLab([0, -0.01, 0])[0]).toBeCloseTo(KAPPA * -0.01, 9);
  });

  // Below L* = κε = 8 the CIE inverse is linear: Y = L* / κ, and likewise for fx and fz.
  it.each([4, 7.5])('inverts L* %d on the linear segment', lightness => {
    expect(largestDifference(labToXyz([lightness, 0, 0]), [PCS_D50.x * (lightness / KAPPA), lightness / KAPPA, PCS_D50.z * (lightness / KAPPA)])).toBeLessThan(
      1e-12,
    );
  });

  it('is continuous at the cube threshold in both directions', () => {
    const below = xyzToLab([0, EPSILON - 1e-12, 0])[0] ?? 0;
    const above = xyzToLab([0, EPSILON + 1e-12, 0])[0] ?? 0;
    // The linear segment's slope is κ, so the 2e-12 gap alone moves L* by about 1.8e-9.
    expect(Math.abs(above - below)).toBeLessThan(1e-8);
    // L* = 116 · 6/29 - 16 = 8 is where fy crosses 6/29.
    const lower = labToXyz([8 - 1e-9, 0, 0])[1] ?? 0;
    const upper = labToXyz([8 + 1e-9, 0, 0])[1] ?? 0;
    expect(Math.abs(upper - lower)).toBeLessThan(1e-10);
    expect(labToXyz([8, 0, 0])[1]).toBeCloseTo(EPSILON, 12);
  });
});

// ICC.1:2022, 6.3.4.2, Tables 11–13 and 10.10: lut16 keeps the legacy 16-bit PCSLAB encoding, every other tag the v4 encoding, and lut8 optionally a 256-step a and b.
describe('PCS encoding for LUT tags', () => {
  it.each([
    { label: 'lut16 white', tag: lut16Tag, option: 'icc' as const, lab: [100, 0, 0], encoded: [65_280 / 65_535, 32_768 / 65_535, 32_768 / 65_535] },
    { label: 'lut16 colour', tag: lut16Tag, option: 'icc' as const, lab: [50, 20, -30], encoded: [32_640 / 65_535, (148 * 256) / 65_535, (98 * 256) / 65_535] },
    {
      label: 'lut16 colour, adobe',
      tag: lut16Tag,
      option: 'adobe' as const,
      lab: [50, 20, -30],
      encoded: [32_640 / 65_535, (148 * 256) / 65_535, (98 * 256) / 65_535],
    },
    { label: 'lut8 white', tag: lut8Tag, option: 'icc' as const, lab: [100, 0, 0], encoded: [1, 128 / 255, 128 / 255] },
    { label: 'lut8 white, adobe', tag: lut8Tag, option: 'adobe' as const, lab: [100, 0, 0], encoded: [1, 0.5, 0.5] },
    { label: 'lut8 colour', tag: lut8Tag, option: 'icc' as const, lab: [50, 20, -30], encoded: [0.5, 148 / 255, 98 / 255] },
    { label: 'lut8 colour, adobe', tag: lut8Tag, option: 'adobe' as const, lab: [50, 20, -30], encoded: [0.5, 148 / 256, 98 / 256] },
    { label: 'lutBtoA colour', tag: lutBtoATag, option: 'icc' as const, lab: [50, 20, -30], encoded: [0.5, 148 / 255, 98 / 255] },
    { label: 'lutBtoA colour, adobe', tag: lutBtoATag, option: 'adobe' as const, lab: [50, 20, -30], encoded: [0.5, 148 / 255, 98 / 255] },
  ])('encodes and decodes Lab for $label', ({ tag, option, lab, encoded }) => {
    expect(largestDifference(encodePcs(lab, 'Lab', { tag, option }), encoded)).toBeLessThan(1e-12);
    expect(largestDifference(decodePcs(encoded, 'Lab', { tag, option }), lab)).toBeLessThan(1e-9);
  });

  it.each([
    { label: 'lut8', tag: lut8Tag },
    { label: 'lut16', tag: lut16Tag },
    { label: 'lutBtoA', tag: lutBtoATag },
  ])('encodes XYZ for $label with 1.0 at 32768/65535 and 1 + 32767/32768 at full scale', ({ tag }) => {
    const config = { tag, option: 'adobe' as const };
    expect(largestDifference(encodePcs([1, 0.5, 1 + 32_767 / 32_768], 'XYZ', config), [32_768 / 65_535, 16_384 / 65_535, 1])).toBeLessThan(1e-12);
    expect(largestDifference(decodePcs([32_768 / 65_535, 16_384 / 65_535, 1], 'XYZ', config), [1, 0.5, 1 + 32_767 / 32_768])).toBeLessThan(1e-12);
  });

  it.each([
    { label: 'lut16 XYZ', tag: lut16Tag, space: 'XYZ' as const, values: [-0.1, 2.5, 1.0001], encoded: [0, 1, 1.0001 / (1 + 32_767 / 32_768)] },
    { label: 'lut16 Lab', tag: lut16Tag, space: 'Lab' as const, values: [-5, -140, 140], encoded: [0, 0, 1] },
    { label: 'lut8 Lab', tag: lut8Tag, space: 'Lab' as const, values: [101, 130, -129], encoded: [1, 1, 0] },
  ])('clamps $label values outside the encodable range', ({ tag, space, values, encoded }) => {
    expect(largestDifference(encodePcs(values, space, { tag, option: 'icc' }), encoded)).toBeLessThan(1e-12);
  });
});

describe('properties', () => {
  it('recovers XYZ from its L*a*b*', () => {
    fc.assert(
      fc.property(fc.tuple(component(2), component(2), component(2)), xyz => {
        expect(largestDifference(labToXyz(xyzToLab(xyz)), xyz)).toBeLessThan(1e-12);
      }),
    );
  });

  it('recovers L*a*b* from its XYZ', () => {
    fc.assert(
      fc.property(fc.tuple(component(100), fc.double({ min: -128, max: 127, noNaN: true }), fc.double({ min: -128, max: 127, noNaN: true })), lab => {
        expect(largestDifference(xyzToLab(labToXyz(lab)), lab)).toBeLessThan(1e-9);
      }),
    );
  });

  it('recovers an in-range PCS value from its LUT encoding for every tag and lut8 option', () => {
    const tag = fc.constantFrom(lut8Tag, lut16Tag, lutBtoATag);
    const option = fc.constantFrom('icc' as const, 'adobe' as const);
    const lab = fc.tuple(component(100), fc.double({ min: -128, max: 127, noNaN: true }), fc.double({ min: -128, max: 127, noNaN: true }));
    const xyz = fc.tuple(component(1 + 32_767 / 32_768), component(1 + 32_767 / 32_768), component(1 + 32_767 / 32_768));
    fc.assert(
      fc.property(
        tag,
        option,
        fc.oneof(
          lab.map(values => ({ space: 'Lab' as const, values })),
          xyz.map(values => ({ space: 'XYZ' as const, values })),
        ),
        (chosen, selected, pcs) => {
          const config = { tag: chosen, option: selected };
          expect(largestDifference(decodePcs(encodePcs(pcs.values, pcs.space, config), pcs.space, config), pcs.values)).toBeLessThan(1e-9);
        },
      ),
    );
  });
});

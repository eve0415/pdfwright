import type { IccProfile } from '../icc/iccProfile.ts';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from './createColorTransform.ts';

const D50 = { x: 0.9642, y: 1, z: 0.8249 };
const D65 = { x: 0.9505, y: 1, z: 1.089 };

const destination = (): IccProfile => ({
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
  colorants: { red: { x: 1, y: 0, z: 0 }, green: { x: 0, y: 1, z: 0 }, blue: { x: 0, y: 0, z: 1 } },
  trc: { red: { kind: 'identity' }, green: { kind: 'identity' }, blue: { kind: 'identity' } },
  deviceToPcs: {},
  pcsToDevice: {},
  identity: new Uint8Array(16),
  bytes: new Uint8Array(132),
  warnings: [],
});

describe('calibrated PDF colour sources', () => {
  it('adapts CalGray D65 to D50 after applying gamma', () => {
    const transform = createColorTransform({ kind: 'calGray', whitePoint: D65, gamma: 2 }, destination(), {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
    });
    const output = new Float64Array(3);
    transform.convert(Float64Array.of(0.5), output);
    expect(output[0]).toBeCloseTo(D50.x * 0.25, 10);
    expect(output[1]).toBeCloseTo(0.25, 10);
    expect(output[2]).toBeCloseTo(D50.z * 0.25, 10);
  });

  it('adapts CalRGB D65 white through the PDF column-major matrix', () => {
    const transform = createColorTransform({ kind: 'calRGB', whitePoint: D65, gamma: [2, 2, 2], matrix: [D65.x, 0, 0, 0, 1, 0, 0, 0, D65.z] }, destination(), {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
    });
    const output = new Float64Array(3);
    transform.convert(Float64Array.of(1, 1, 1), output);
    expect(output[0]).toBeCloseTo(D50.x, 10);
    expect(output[1]).toBeCloseTo(1, 10);
    expect(output[2]).toBeCloseTo(D50.z, 10);
    transform.convert(Float64Array.of(0.5, 0.5, 0.5), output);
    expect(output[1]).toBeCloseTo(0.25, 10);
  });

  it('reads CalRGB Matrix entries as three XYZ columns', () => {
    const transform = createColorTransform(
      { kind: 'calRGB', whitePoint: D50, gamma: [1, 1, 1], matrix: [0.4, 0.1, 0.2, 0.3, 0.5, 0.3, 0.2642, 0.4, 0.3249] },
      destination(),
      { intent: 'relativeColorimetric', blackPointCompensation: false },
    );
    const output = new Float64Array(3);
    transform.convert(Float64Array.of(1, 0, 0), output);
    expect(output[0]).toBeCloseTo(0.4, 12);
    expect(output[1]).toBeCloseTo(0.1, 12);
    expect(output[2]).toBeCloseTo(0.2, 12);
  });
});

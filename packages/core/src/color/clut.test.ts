import { describe, expect, it } from 'vitest';

import { evaluateClut } from './clut.ts';

describe('icc CLUT interpolation', () => {
  it('uses trilinear interpolation for Lab PCS input and tetrahedral otherwise', () => {
    const values = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 255);
    const clut = { gridPoints: [2, 2, 2], inputChannels: 3, outputChannels: 1, values };
    expect(evaluateClut(clut, [0.7, 0.5, 0.3], 'trilinear')[0]).toBeCloseTo(0.105, 12);
    expect(evaluateClut(clut, [0.7, 0.5, 0.3], 'tetrahedral')[0]).toBeCloseTo(0.3, 12);
  });

  it('interpolates the first dimension of a four-input CLUT between tetrahedral planes', () => {
    const values = new Uint8Array(16);
    values.fill(255, 8);
    const clut = { gridPoints: [2, 2, 2, 2], inputChannels: 4, outputChannels: 1, values };
    expect(evaluateClut(clut, [0.4, 0.7, 0.5, 0.3], 'tetrahedral')[0]).toBeCloseTo(0.4, 12);
  });
});

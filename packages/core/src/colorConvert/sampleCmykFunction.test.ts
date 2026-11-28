import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { CmykFunctionConfig, SampledCmykFunction } from './sampleCmykFunction.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfArray, pdfInteger, pdfName, pdfReal } from '../object/pdfObject.ts';

import { sampleCmykFunction } from './sampleCmykFunction.ts';

const destination = parseIccProfile(fograBytes);

const samples = (sampled: SampledCmykFunction): Uint8Array => inflateZlib(sampled.data).data;

const entries = (sampled: SampledCmykFunction): Record<string, PdfDirectObject> =>
  Object.fromEntries([...sampled.dictionary.entries()].map(([key, value]) => [new TextDecoder('latin1').decode(key), value]));

const oneInput = (evaluate: (input: number) => ReadonlyArray<number>, options?: Partial<CmykFunctionConfig>): SampledCmykFunction =>
  sampleCmykFunction({ dimensions: 1, domain: [0, 1], evaluate: ([input]) => Float64Array.from(evaluate(input ?? Number.NaN)), destination, ...options });

const cyanRamp = (input: number): ReadonlyArray<number> => [input, 0, 0, 0];
const cyanWave = (input: number): ReadonlyArray<number> => [0.5 + 0.5 * Math.sin(40 * input), 0, 0, 0];
const cyanCurve = (input: number): ReadonlyArray<number> => [input ** 2, 0, 0, 0];
// Every grid with an even number of points puts the midpoint of one interval on the step, so refining never meets a tolerance.
const step = (input: number): ReadonlyArray<number> => (input < 0.5 ? [0, 0, 0, 0] : [1, 1, 1, 1]);
// Four distinct outputs on [0, 0.1), [0.1, 0.5), [0.5, 0.9) and [0.9, 1], so sampling the wrong domain changes the samples.
const pieces = (input: number): ReadonlyArray<number> => {
  if (input < 0.1) {
    return [0, 0, 0, 0];
  }
  if (input < 0.5) {
    return [0.25, 0.5, 0.75, 1];
  }
  return input < 0.9 ? [0, 1 / 65_535, 1, 0.5] : [1, 1, 1, 1];
};

const word = (value: number): ReadonlyArray<number> => [Math.floor(value / 256), value % 256];

describe('sampled CMYK functions', () => {
  it.each([
    [5, 10],
    [2, 316],
  ])('samples %d inputs on a grid of %d, within 100000 samples', (dimensions, grid) => {
    const sampled = sampleCmykFunction({
      dimensions,
      domain: Array.from({ length: dimensions }, () => [0, 1]).flat(),
      evaluate: () => new Float64Array(4),
      destination,
      grid,
    });
    expect(entries(sampled)['Size']).toStrictEqual(pdfArray(Array.from({ length: dimensions }, () => pdfInteger(grid))));
  });

  it.each([
    [2, 317],
    [5, 11],
  ])('refuses %d inputs on a grid of %d, beyond 100000 samples', (dimensions, grid) => {
    expect(() =>
      sampleCmykFunction({
        dimensions,
        domain: Array.from({ length: dimensions }, () => [0, 1]).flat(),
        evaluate: () => new Float64Array(4),
        destination,
        grid,
      }),
    ).toThrow(ResourceLimitError);
  });

  // The ramp interpolates exactly, and the wave's midpoint error is about 0.12 at 256 samples and 0.03 at 512.
  it.each([
    ['a cyan ramp', cyanRamp, 256],
    ['a cyan wave', cyanWave, 512],
  ])('starts %s at 256 samples and doubles them until the midpoints are within 0.1', (_, evaluate, grid) => {
    const sampled = oneInput(evaluate);
    expect(entries(sampled)['Size']).toStrictEqual(pdfArray([pdfInteger(grid)]));
    expect(sampled.maxDeltaE2000).toBeLessThanOrEqual(0.1);
  });

  it('keeps the grid whose midpoint error equals the tolerance and refines past one just below it', () => {
    const coarse = oneInput(cyanCurve, { minimumGrid: 2, midpointTolerance: Number.POSITIVE_INFINITY });
    const atLimit = oneInput(cyanCurve, { minimumGrid: 2, midpointTolerance: coarse.maxDeltaE2000 });
    const belowLimit = oneInput(cyanCurve, { minimumGrid: 2, midpointTolerance: coarse.maxDeltaE2000 * (1 - Number.EPSILON * 4) });
    expect([coarse.maxDeltaE2000 > 0, entries(atLimit)['Size'], entries(belowLimit)['Size']]).toStrictEqual([
      true,
      pdfArray([pdfInteger(2)]),
      pdfArray([pdfInteger(4)]),
    ]);
  });

  it('stops refining at 4096 samples and reports the remaining midpoint error', () => {
    const sampled = oneInput(step, { minimumGrid: 2048 });
    expect(entries(sampled)['Size']).toStrictEqual(pdfArray([pdfInteger(4096)]));
    expect(sampled.maxDeltaE2000).toBeGreaterThan(0.1);
    expect(samples(sampled)).toHaveLength(4096 * 4 * 2);
  });

  // ISO 32000-1:2008, 7.10.2 Table 39: samples are BitsPerSample-bit unsigned integers, high-order byte first, each mapped over the output Range.
  it('rounds each channel to 16 bits, high byte first, over the domain the caller gives', () => {
    const sampled = oneInput(pieces, { domain: [0.2, 0.8], minimumGrid: 2, midpointTolerance: Number.POSITIVE_INFINITY });
    expect(samples(sampled)).toStrictEqual(Uint8Array.of(0x40, 0x00, 0x80, 0x00, 0xbf, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0xff, 0xff, 0x80, 0x00));
    expect(entries(sampled)).toStrictEqual({
      FunctionType: pdfInteger(0),
      Domain: pdfArray([pdfReal(0.2), pdfReal(0.8)]),
      Range: pdfArray([0, 1, 0, 1, 0, 1, 0, 1].map(value => pdfInteger(value))),
      Size: pdfArray([pdfInteger(2)]),
      BitsPerSample: pdfInteger(16),
      Order: pdfInteger(1),
      Filter: pdfName('FlateDecode'),
    });
  });

  // ISO 32000-1:2008, 7.10.2: the first input varies fastest in the sample table.
  it('samples a two-input function on its fixed grid with the first input varying fastest and no midpoint error', () => {
    const sampled = sampleCmykFunction({
      dimensions: 2,
      domain: [0, 1, 10, 20],
      evaluate: ([first = 0, second = 0]) => Float64Array.of(first, (second - 10) / 10, first < 0.5 ? 0 : 1, 0),
      destination,
      grid: 3,
    });
    const levels = [0, 32_768, 65_535];
    const expected = Array.from({ length: 9 }, (_, index) => {
      const first = levels[index % 3] ?? 0;
      return [...word(first), ...word(levels[Math.floor(index / 3)] ?? 0), ...word(index % 3 === 0 ? 0 : 65_535), 0, 0];
    }).flat();
    expect(samples(sampled)).toStrictEqual(Uint8Array.from(expected));
    expect([entries(sampled)['Size'], sampled.maxDeltaE2000]).toStrictEqual([pdfArray([pdfInteger(3), pdfInteger(3)]), 0]);
  });
});

// A cyan and magenta wave whose frequency decides how many doublings the midpoint tolerance needs.
const wave =
  (frequency: number, phase: number) =>
  (input: number): ReadonlyArray<number> => [0.5 + 0.5 * Math.sin(frequency * input + phase), 0.5 + 0.5 * Math.cos(frequency * input), 0, 0];

describe('properties', () => {
  it('chooses the first doubled grid whose own midpoint error meets the tolerance, up to 4096', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 60, noNaN: true }),
        fc.double({ min: 0, max: 6, noNaN: true }),
        fc.integer({ min: 1, max: 8 }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (frequency, phase, exponent, tolerance) => {
          const minimumGrid = 2 ** exponent;
          const evaluate = wave(frequency, phase);
          const single = (grid: number): SampledCmykFunction => oneInput(evaluate, { minimumGrid: grid, midpointTolerance: Number.POSITIVE_INFINITY });
          let grid = minimumGrid;
          while (grid < 4096 && single(grid).maxDeltaE2000 > tolerance) {
            grid *= 2;
          }
          const sampled = oneInput(evaluate, { minimumGrid, midpointTolerance: tolerance });
          const expected = single(grid);
          expect([entries(sampled)['Size'], sampled.maxDeltaE2000, samples(sampled)]).toStrictEqual([
            pdfArray([pdfInteger(grid)]),
            expected.maxDeltaE2000,
            samples(expected),
          ]);
          expect(samples(sampled)).toHaveLength(grid * 4 * 2);
        },
      ),
    );
  }, 60_000);
});

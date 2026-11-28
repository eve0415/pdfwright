import type { Clut } from '../icc/iccLut.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { evaluateClut } from './clut.ts';

const modes = ['trilinear', 'tetrahedral'] as const;

const oneChannel = (gridPoints: ReadonlyArray<number>, values: Uint8Array | Uint16Array): Clut => ({
  gridPoints,
  inputChannels: gridPoints.length,
  outputChannels: 1,
  values,
});

// Every node of a 2-point grid is zero except the one at flat index `index`, which is full scale for lut8 or lut16 samples.
const singleNode = (inputs: number, index: number, samples: 'lut8' | 'lut16'): Clut => {
  const count = 2 ** inputs;
  const values = samples === 'lut8' ? new Uint8Array(count) : new Uint16Array(count);
  values[index] = samples === 'lut8' ? 255 : 65_535;
  return oneChannel(
    Array.from({ length: inputs }, () => 2),
    values,
  );
};

// Node (x, y, z) of a 3 by 3 by 3 grid sits at flat index 9x + 3y + z and holds (37 · index) mod 251, which is not affine in the node coordinates.
const nodeValue = (index: number): number => (index * 37) % 251;

describe('icc CLUT interpolation', () => {
  it('interpolates trilinearly or tetrahedrally as requested', () => {
    const clut = singleNode(3, 7, 'lut8');
    expect(evaluateClut(clut, [0.7, 0.5, 0.3], 'trilinear')[0]).toBeCloseTo(0.105, 12);
    expect(evaluateClut(clut, [0.7, 0.5, 0.3], 'tetrahedral')[0]).toBeCloseTo(0.3, 12);
  });

  it('scales lut16 samples by 65,535 as lut8 samples are scaled by 255', () => {
    const clut = singleNode(3, 7, 'lut16');
    expect(evaluateClut(clut, [0.7, 0.5, 0.3], 'trilinear')[0]).toBeCloseTo(0.105, 12);
    expect(evaluateClut(clut, [0.7, 0.5, 0.3], 'tetrahedral')[0]).toBeCloseTo(0.3, 12);
  });

  it('interpolates the first dimension of a four-input CLUT between tetrahedral planes', () => {
    const values = new Uint8Array(16);
    values.fill(255, 8);
    const clut = { gridPoints: [2, 2, 2, 2], inputChannels: 4, outputChannels: 1, values };
    expect(evaluateClut(clut, [0.4, 0.7, 0.5, 0.3], 'tetrahedral')[0]).toBeCloseTo(0.4, 12);
  });

  // ICC.1:2022, 10.10 and 10.12: the last input varies fastest, so flat index 1 is the corner where only the third input is high.
  it.each([
    { mode: 'trilinear' as const, expected: 0.8 * 0.7 * 0.6 },
    { mode: 'tetrahedral' as const, expected: 0.6 - 0.3 },
  ])('stores the last input fastest under $mode interpolation', ({ mode, expected }) => {
    const clut = singleNode(3, 1, 'lut8');
    expect(evaluateClut(clut, [0.2, 0.3, 0.6], mode)[0]).toBeCloseTo(expected, 12);
  });

  it.each(modes)('clips inputs outside [0, 1] to the grid under %s interpolation', mode => {
    const clut = oneChannel([2, 2, 2], Uint8Array.of(0, 10, 20, 30, 40, 50, 60, 255));
    // Inputs (0, 1, 0.3) run from node (0, 1, 0) = 20 to node (0, 1, 1) = 30.
    expect(evaluateClut(clut, [-0.5, 1.5, 0.3], mode)[0]).toBeCloseTo(23 / 255, 12);
    expect(evaluateClut(clut, [0, 1, 0.3], mode)[0]).toBeCloseTo(23 / 255, 12);
  });

  describe('a 3 by 3 by 3 grid with distinct node values', () => {
    const clut = oneChannel(
      [3, 3, 3],
      Uint8Array.from({ length: 27 }, (_, index) => nodeValue(index)),
    );

    it.each(modes)('returns the node value at a node and the last node at 1 under %s interpolation', mode => {
      expect(evaluateClut(clut, [0.5, 0, 1], mode)[0]).toBeCloseTo(nodeValue(11) / 255, 12);
      expect(evaluateClut(clut, [1, 1, 1], mode)[0]).toBeCloseTo(nodeValue(26) / 255, 12);
      expect(evaluateClut(clut, [1, 0.5, 0], mode)[0]).toBeCloseTo(nodeValue(21) / 255, 12);
    });

    it.each(modes)('interpolates between the second and third nodes of an axis under %s interpolation', mode => {
      expect(evaluateClut(clut, [0, 0, 0.75], mode)[0]).toBeCloseTo((nodeValue(1) + nodeValue(2)) / 2 / 255, 12);
      expect(evaluateClut(clut, [0.75, 0, 0], mode)[0]).toBeCloseTo((nodeValue(9) + nodeValue(18)) / 2 / 255, 12);
    });
  });

  it.each(modes)('interpolates a one-input CLUT linearly between its grid points under %s interpolation', mode => {
    const clut = oneChannel([3], Uint8Array.of(0, 100, 250));
    expect(evaluateClut(clut, [0.25], mode)[0]).toBeCloseTo(50 / 255, 12);
    expect(evaluateClut(clut, [0.75], mode)[0]).toBeCloseTo(175 / 255, 12);
    expect(evaluateClut(clut, [1], mode)[0]).toBeCloseTo(250 / 255, 12);
  });

  it.each(modes)('interpolates a two-input CLUT bilinearly, with the second input fastest, under %s interpolation', mode => {
    // Flat index 1 is the corner where only the second input is high.
    const clut = singleNode(2, 1, 'lut8');
    expect(evaluateClut(clut, [0.2, 0.7], mode)[0]).toBeCloseTo(0.8 * 0.7, 12);
  });

  it.each([
    { high: 'first', start: 16, expected: 0.3 },
    { high: 'second', start: 8, expected: 0.6 },
  ])('interpolates a five-input CLUT along its $high input through two levels of recursion', ({ start, expected }) => {
    const values = new Uint8Array(32);
    for (let index = 0; index < 32; index++) {
      values[index] = Math.floor(index / start) % 2 === 1 ? 255 : 0;
    }
    const clut = oneChannel([2, 2, 2, 2, 2], values);
    expect(evaluateClut(clut, [0.3, 0.6, 0.5, 0.2, 0.9], 'tetrahedral')[0]).toBeCloseTo(expected, 12);
  });

  it.each(modes)('interpolates each output channel independently under %s interpolation', mode => {
    const channels = [
      [0, 200, 30, 90, 255, 10, 70, 140],
      [255, 0, 0, 0, 0, 0, 0, 0],
      [5, 60, 120, 180, 240, 30, 15, 100],
    ];
    const interleaved = Uint8Array.from({ length: 24 }, (_, index) => channels[index % 3]?.[Math.floor(index / 3)] ?? 0);
    const input = [0.6, 0.25, 0.8];
    const combined = evaluateClut({ gridPoints: [2, 2, 2], inputChannels: 3, outputChannels: 3, values: interleaved }, input, mode);
    const separate = channels.map(values => evaluateClut(oneChannel([2, 2, 2], Uint8Array.from(values)), input, mode)[0]);
    expect(combined).toStrictEqual(separate);
    expect(new Set(combined).size).toBe(3);
  });
});

describe('properties', () => {
  const grid = fc.tuple(fc.integer({ min: 2, max: 5 }), fc.integer({ min: 2, max: 5 }), fc.integer({ min: 2, max: 5 }));
  const coefficient = fc.integer({ min: 0, max: 4000 });
  const unit = fc.double({ min: 0, max: 1, noNaN: true });

  it('reproduces an affine CLUT exactly at any input in both modes', () => {
    fc.assert(
      fc.property(
        grid,
        fc.tuple(coefficient, coefficient, coefficient, coefficient),
        fc.tuple(unit, unit, unit),
        fc.constantFrom(...modes),
        (points, [a, b, c, d], input, mode) => {
          const [nx, ny, nz] = points;
          const values = new Uint16Array(nx * ny * nz);
          for (let x = 0; x < nx; x++) {
            for (let y = 0; y < ny; y++) {
              for (let z = 0; z < nz; z++) {
                values[(x * ny + y) * nz + z] = d + a * x + b * y + c * z;
              }
            }
          }
          const [u, v, w] = input;
          const expected = (d + a * u * (nx - 1) + b * v * (ny - 1) + c * w * (nz - 1)) / 65_535;
          expect(evaluateClut(oneChannel(points, values), input, mode)[0]).toBeCloseTo(expected, 12);
        },
      ),
    );
  });

  it('returns the node value at every grid node in both modes', () => {
    fc.assert(
      fc.property(
        grid,
        fc.uint16Array({ minLength: 125, maxLength: 125 }),
        fc.tuple(fc.nat(), fc.nat(), fc.nat()),
        fc.constantFrom(...modes),
        (points, pool, coordinates, mode) => {
          const [nx, ny, nz] = points;
          const values = pool.slice(0, nx * ny * nz);
          const x = coordinates[0] % nx;
          const y = coordinates[1] % ny;
          const z = coordinates[2] % nz;
          const expected = (values[(x * ny + y) * nz + z] ?? 0) / 65_535;
          expect(evaluateClut(oneChannel(points, values), [x / (nx - 1), y / (ny - 1), z / (nz - 1)], mode)[0]).toBeCloseTo(expected, 12);
        },
      ),
    );
  });
});

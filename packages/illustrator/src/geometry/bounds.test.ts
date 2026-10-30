import type { IllustratorDocument, PathGeometry } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';

import { artBounds, integerBounds } from './bounds.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 0, minute: 0, second: 0, offset: 'Z' });
const rectangle: PathGeometry = {
  subpaths: [
    {
      start: [0, 0],
      segments: [
        { kind: 'line', to: [10, 0] },
        { kind: 'line', to: [10, 10] },
        { kind: 'line', to: [0, 10] },
      ],
    },
  ],
};

// A quadratic coordinate (1 − t)² p0 + 2 (1 − t) t q + t² p2 is extreme at t = (p0 − q) / (p0 − 2q + p2).
const quadraticRange = (p0: number, q: number, p2: number): readonly [number, number] => {
  const t = (p0 - q) / (p0 - 2 * q + p2);
  const ends = [p0, p2];
  const values = t > 0 && t < 1 ? [...ends, (1 - t) ** 2 * p0 + 2 * (1 - t) * t * q + t ** 2 * p2] : ends;
  return [Math.min(...values), Math.max(...values)];
};

describe('native art bounds', () => {
  it('includes the miter tip of a stroked triangle', () => {
    const document: IllustratorDocument = {
      artboard: { width: 120, height: 100 },
      lastModified: date,
      layers: [
        {
          name: 'Triangle',
          items: [
            {
              kind: 'path',
              geometry: {
                subpaths: [
                  {
                    start: [10, 10],
                    segments: [
                      { kind: 'line', to: [60, 60] },
                      { kind: 'line', to: [110, 10] },
                    ],
                  },
                ],
              },
              stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 10 },
            },
          ],
        },
      ],
    };
    expect(artBounds(document).maxY).toBeCloseTo(60 + 5 * Math.SQRT2);
    expect(integerBounds(artBounds(document))).toStrictEqual([-3, 5, 123, 68]);
    expect(new TextDecoder().decode(writeNative(document).bytes)).toContain('%%BoundingBox: -3 5 123 68');
  });

  it('bevels a miter above the default limit of 10', () => {
    const document: IllustratorDocument = {
      artboard: { width: 120, height: 100 },
      lastModified: date,
      layers: [
        {
          name: 'Sharp',
          items: [
            {
              kind: 'path',
              geometry: {
                subpaths: [
                  {
                    start: [10, 10],
                    segments: [
                      { kind: 'line', to: [60, 60] },
                      { kind: 'line', to: [12, 10] },
                    ],
                  },
                ],
              },
              stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 10 },
            },
          ],
        },
      ],
    };
    expect(artBounds(document).maxY).toBe(65);
  });

  it('uses a curve end tangent at a miter join', () => {
    const document: IllustratorDocument = {
      artboard: { width: 120, height: 100 },
      lastModified: date,
      layers: [
        {
          name: 'Curve',
          items: [
            {
              kind: 'path',
              geometry: {
                subpaths: [
                  {
                    start: [10, 10],
                    segments: [
                      { kind: 'curve', control1: [25, 25], control2: [45, 45], to: [60, 60] },
                      { kind: 'line', to: [110, 10] },
                    ],
                  },
                ],
              },
              stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 10 },
            },
          ],
        },
      ],
    };
    expect(artBounds(document).maxY).toBeCloseTo(60 + 5 * Math.SQRT2);
  });

  it('uses exact cubic extrema and expands stroked paths by half their width', () => {
    const document: IllustratorDocument = {
      artboard: { width: 100, height: 100 },
      lastModified: date,
      layers: [
        {
          name: 'Curves',
          items: [
            {
              kind: 'path',
              geometry: { subpaths: [{ start: [0, 0], segments: [{ kind: 'curve', control1: [0, 2], control2: [1, 2], to: [1, 0] }] }] },
              stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 1 },
            },
          ],
        },
      ],
    };
    expect(artBounds(document)).toStrictEqual({ minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 2 });
    expect(integerBounds(artBounds(document))).toStrictEqual([-1, -1, 2, 2]);
  });

  it.each([
    { start: [10.5, 20.25], control: [30, 70.5], end: [60.75, 5] },
    { start: [100, 200.9], control: [600, 3000.4], end: [1100, 0.3] },
    { start: [12000.4, 29001], control: [25000, 1], end: [38000.2, 29000.7] },
    { start: [1000000, 0.8], control: [1500000, 3000000.1], end: [2000000.5, 0.3] },
  ] as const)('finds the extrema of the quadratic from $start through $control to $end', ({ start, control, end }) => {
    const document: IllustratorDocument = {
      artboard: { width: 3_000_000, height: 3_000_000 },
      lastModified: date,
      layers: [
        {
          name: 'Quadratic',
          items: [
            {
              kind: 'path',
              geometry: { subpaths: [{ start, segments: [{ kind: 'quadratic', control, to: end }] }] },
              fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
            },
          ],
        },
      ],
    };
    const [minX, maxX] = quadraticRange(start[0], control[0], end[0]);
    const [minY, maxY] = quadraticRange(start[1], control[1], end[1]);
    const bounds = artBounds(document);
    expect(bounds.minX).toBeCloseTo(minX, 6);
    expect(bounds.minY).toBeCloseTo(minY, 6);
    expect(bounds.maxX).toBeCloseTo(maxX, 6);
    expect(bounds.maxY).toBeCloseTo(maxY, 6);
  });

  it('finds the extrema of a cubic segment far from the origin', () => {
    const offset = 1e6;
    const document: IllustratorDocument = {
      artboard: { width: 2 * offset, height: 2 * offset },
      lastModified: date,
      layers: [
        {
          name: 'Cubic',
          items: [
            {
              kind: 'path',
              geometry: {
                subpaths: [
                  {
                    start: [offset, offset],
                    segments: [{ kind: 'curve', control1: [offset - 1, offset + 3], control2: [offset + 2, offset + 1], to: [offset + 1, offset] }],
                  },
                ],
              },
              fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
            },
          ],
        },
      ],
    };
    // x(t) = 1e6 − 3t + 12t² − 8t³ and y(t) = 1e6 + 9t − 15t² + 6t³ for this segment.
    const x = (t: number): number => offset - 3 * t + 12 * t ** 2 - 8 * t ** 3;
    const y = (t: number): number => offset + 9 * t - 15 * t ** 2 + 6 * t ** 3;
    const bounds = artBounds(document);
    expect(bounds.minX).toBeCloseTo(x((1 - Math.sqrt(0.5)) / 2), 6);
    expect(bounds.maxX).toBeCloseTo(x((1 + Math.sqrt(0.5)) / 2), 6);
    expect(bounds.minY).toBe(offset);
    expect(bounds.maxY).toBeCloseTo(y((5 - Math.sqrt(7)) / 6), 6);
  });

  it('uses the clipping path bounds and ignores hidden layers', () => {
    const document: IllustratorDocument = {
      artboard: { width: 100, height: 100 },
      lastModified: date,
      layers: [
        { name: 'Hidden', visible: false, items: [{ kind: 'path', geometry: rectangle, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } }] },
        {
          name: 'Clipped',
          items: [
            {
              kind: 'clipGroup',
              clip: {
                subpaths: [
                  {
                    start: [20, 30],
                    segments: [
                      { kind: 'line', to: [40, 30] },
                      { kind: 'line', to: [40, 50] },
                      { kind: 'line', to: [20, 50] },
                    ],
                  },
                ],
              },
              items: [{ kind: 'path', geometry: rectangle, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } }],
            },
          ],
        },
      ],
    };
    expect(artBounds(document)).toStrictEqual({ minX: 20, minY: 30, maxX: 40, maxY: 50 });
  });

  it('uses raster placement and the artboard when no visible art exists', () => {
    const document: IllustratorDocument = {
      artboard: { width: mm(100), height: 50 },
      lastModified: date,
      layers: [
        {
          name: 'Image',
          items: [
            {
              kind: 'raster',
              width: 1,
              height: 1,
              bounds: { x: 2, y: 3, width: 4, height: 5 },
              color: { space: 'cmyk', samples: new Uint8Array(4) },
              alpha: new Uint8Array([255]),
            },
          ],
        },
      ],
    };
    expect(artBounds(document)).toStrictEqual({ minX: 2, minY: 3, maxX: 6, maxY: 8 });
    expect(artBounds({ ...document, layers: [] })).toStrictEqual({ minX: 0, minY: 0, maxX: 36000 / 127, maxY: 50 });
  });
});

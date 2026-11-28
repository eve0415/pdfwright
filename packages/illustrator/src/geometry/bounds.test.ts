import type { IllustratorDocument, Paint, PathGeometry, PathItem, Subpath } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';

import { artBounds, integerBounds, pathBounds } from './bounds.ts';

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

const black: Paint = { kind: 'process', cmyk: [0, 0, 0, 1] };
// An open triangle that the writer closes with a line back to (10, 10); every join is 45° or 90°, well inside the miter limit.
const triangle: ReadonlyArray<Subpath> = [
  {
    start: [10, 10],
    segments: [
      { kind: 'line', to: [60, 60] },
      { kind: 'line', to: [110, 10] },
    ],
  },
];
const strokedDocument = (subpaths: ReadonlyArray<Subpath>, width: number): IllustratorDocument => ({
  artboard: { width: 120, height: 100 },
  lastModified: date,
  layers: [{ name: 'Stroked', items: [{ kind: 'path', geometry: { subpaths }, stroke: { paint: black, width } }] }],
});

const filledSquare = (left: number): PathItem => ({
  kind: 'path',
  geometry: {
    subpaths: [
      {
        start: [left, left],
        segments: [
          { kind: 'line', to: [left + 10, left] },
          { kind: 'line', to: [left + 10, left + 10] },
          { kind: 'line', to: [left, left + 10] },
        ],
      },
    ],
  },
  fill: { paint: black },
});

// A quadratic coordinate (1 − t)² p0 + 2 (1 − t) t q + t² p2 is extreme at t = (p0 − q) / (p0 − 2q + p2).
const quadraticRange = (p0: number, q: number, p2: number): readonly [number, number] => {
  const t = (p0 - q) / (p0 - 2 * q + p2);
  const ends = [p0, p2];
  const values = t > 0 && t < 1 ? [...ends, (1 - t) ** 2 * p0 + 2 * (1 - t) * t * q + t ** 2 * p2] : ends;
  return [Math.min(...values), Math.max(...values)];
};

const cubicAt = ([p0, p1, p2, p3]: readonly [number, number, number, number], t: number): number =>
  (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;

// Golden-section search for the largest value of f on [low, high], with the interval's ends as candidates too.
const refinedMaximum = (f: (t: number) => number, low: number, high: number): number => {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let [a, b] = [low, high];
  for (let step = 0; step < 100; step++) {
    const left = b - ratio * (b - a);
    const right = a + ratio * (b - a);
    if (f(left) < f(right)) {
      a = left;
    } else {
      b = right;
    }
  }
  return Math.max(f(low), f(high), f((a + b) / 2));
};

// The range of one cubic coordinate found without its derivative: the extremes of 1001 samples, each refined between its neighbouring samples.
const sampledRange = (coordinates: readonly [number, number, number, number]): readonly [number, number] => {
  const steps = 1000;
  const samples = Array.from({ length: steps + 1 }, (_, index) => cubicAt(coordinates, index / steps));
  const around = (index: number, sign: number): number =>
    sign * refinedMaximum(t => sign * cubicAt(coordinates, t), Math.max(0, (index - 1) / steps), Math.min(1, (index + 1) / steps));
  return [around(samples.indexOf(Math.min(...samples)), -1), around(samples.indexOf(Math.max(...samples)), 1)];
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
    // The curve arrives at (60, 60) travelling straight up, from its second control point (60, 40), while its chord from (10, 10) runs at 45°.
    // With the 45° line leaving downward, the outer stroke edges x = 55 and (x − 60 + y − 60) / √2 = 5 meet at the miter tip (55, 65 + 5√2); the chord's direction would put the tip at (60, 60 + 5√2) instead.
    const document = strokedDocument(
      [
        {
          start: [10, 10],
          segments: [
            { kind: 'curve', control1: [25, 25], control2: [60, 40], to: [60, 60] },
            { kind: 'line', to: [110, 10] },
          ],
        },
      ],
      10,
    );
    const bounds = artBounds(document);
    expect(bounds.maxY).toBeCloseTo(65 + 5 * Math.SQRT2, 9);
    // The joins at (10, 10) and (110, 10) put their tips 5 + 5√2 beyond the ends of the base, and the base's stroke edge is at y = 5.
    expect(bounds.minX).toBeCloseTo(5 - 5 * Math.SQRT2, 9);
    expect(bounds.maxX).toBeCloseTo(115 + 5 * Math.SQRT2, 9);
    expect(bounds.minY).toBeCloseTo(5, 9);
  });

  it('unions the children of nested groups', () => {
    const document: IllustratorDocument = {
      artboard: { width: 100, height: 100 },
      lastModified: date,
      layers: [{ name: 'Grouped', items: [{ kind: 'group', items: [filledSquare(0), { kind: 'group', items: [filledSquare(50)] }] }] }],
    };
    expect(artBounds(document)).toStrictEqual({ minX: 0, minY: 0, maxX: 60, maxY: 60 });
  });

  it('falls back to the artboard when the only layer is hidden', () => {
    const document: IllustratorDocument = {
      artboard: { width: 100, height: 50 },
      lastModified: date,
      layers: [{ name: 'Hidden', visible: false, items: [{ kind: 'path', geometry: rectangle, fill: { paint: black } }] }],
    };
    expect(artBounds(document)).toStrictEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
  });

  it('gives a zero-width stroke the bounds of its path', () => {
    expect(artBounds(strokedDocument(triangle, 0))).toStrictEqual({ minX: 10, minY: 10, maxX: 110, maxY: 60 });
  });

  // ISO 32000-1:2008, 8.4.3.5: a miter join is bevelled when the miter length divided by the line width, 1 / sin(φ / 2) for a join angle φ, exceeds the miter limit of 10.
  // A line along y = 50 arrives at (100, 50) and leaves at angle φ back towards the start; an unbevelled tip lies at (100 + 5 cot(φ / 2), 45).
  // Just below the limit the tip lies near 100 + 5√99 ≈ 149.7, about 45 points beyond the bevel's 105, so a ratio within 1e-6 of 10 still separates the two.
  it.each([
    { join: 'miters', ratio: 10 - 1e-6, maxX: 100 + 5 * Math.sqrt((10 - 1e-6) ** 2 - 1) },
    { join: 'bevels', ratio: 10 + 1e-6, maxX: 105 },
  ])('$join a join whose miter ratio is $ratio', ({ ratio, maxX }) => {
    const angle = 2 * Math.asin(1 / ratio);
    const document = strokedDocument(
      [
        {
          start: [0, 50],
          segments: [
            { kind: 'line', to: [100, 50] },
            { kind: 'line', to: [100 - 100 * Math.cos(angle), 50 + 100 * Math.sin(angle)] },
          ],
        },
      ],
      10,
    );
    expect(artBounds(document).maxX).toBeCloseTo(maxX, 9);
  });

  it('miters the join at the start of an explicitly closed subpath', () => {
    const closed: ReadonlyArray<Subpath> = [
      {
        start: [10, 10],
        segments: [
          { kind: 'line', to: [60, 60] },
          { kind: 'line', to: [110, 10] },
          { kind: 'line', to: [10, 10] },
        ],
      },
    ];
    // The tip at (10, 10) reaches 5 + 5√2 left of the vertex, as it does when the writer closes the subpath itself.
    expect(artBounds(strokedDocument(closed, 10)).minX).toBeCloseTo(5 - 5 * Math.SQRT2, 9);
  });

  it('takes a miter tip from each subpath of a compound path', () => {
    const inverted: Subpath = {
      start: [10, -10],
      segments: [
        { kind: 'line', to: [110, -10] },
        { kind: 'line', to: [60, -60] },
      ],
    };
    const bounds = artBounds(strokedDocument([...triangle, inverted], 10));
    expect(bounds.maxY).toBeCloseTo(60 + 5 * Math.SQRT2, 9);
    expect(bounds.minY).toBeCloseTo(-60 - 5 * Math.SQRT2, 9);
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
    { start: [12_000.4, 29_001], control: [25_000, 1], end: [38_000.2, 29_000.7] },
    { start: [1_000_000, 0.8], control: [1_500_000, 3_000_000.1], end: [2_000_000.5, 0.3] },
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
    expect(artBounds({ ...document, layers: [] })).toStrictEqual({ minX: 0, minY: 0, maxX: 36_000 / 127, maxY: 50 });
  });

  describe('properties', () => {
    const coordinate = fc.integer({ min: -1000, max: 1000 });
    const point = fc.tuple(coordinate, coordinate);

    it('agrees with a refined sampling of each cubic segment', () => {
      fc.assert(
        fc.property(point, point, point, point, (start, control1, control2, to) => {
          const [minX, maxX] = sampledRange([start[0], control1[0], control2[0], to[0]]);
          const [minY, maxY] = sampledRange([start[1], control1[1], control2[1], to[1]]);
          const bounds = pathBounds({ subpaths: [{ start, segments: [{ kind: 'curve', control1, control2, to }] }] });
          expect([bounds.minX - minX, bounds.minY - minY, bounds.maxX - maxX, bounds.maxY - maxY].map(difference => Math.abs(difference) < 1e-6)).toStrictEqual(
            [true, true, true, true],
          );
        }),
      );
    });

    it('agrees with the closed-form extremes of each quadratic segment', () => {
      fc.assert(
        fc.property(point, point, point, (start, control, to) => {
          const [minX, maxX] = quadraticRange(start[0], control[0], to[0]);
          const [minY, maxY] = quadraticRange(start[1], control[1], to[1]);
          const bounds = pathBounds({ subpaths: [{ start, segments: [{ kind: 'quadratic', control, to }] }] });
          expect([bounds.minX - minX, bounds.minY - minY, bounds.maxX - maxX, bounds.maxY - maxY].map(difference => Math.abs(difference) < 1e-6)).toStrictEqual(
            [true, true, true, true],
          );
        }),
      );
    });
  });
});

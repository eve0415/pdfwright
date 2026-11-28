import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Clip } from './clip.ts';
import { IDENTITY } from './matrix.ts';
import { MAX_CLIP_VERTICES, PathBuilder } from './path.ts';

const cubic = (points: ReadonlyArray<number>, t: number): readonly [number, number] => {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = points;
  const u = 1 - t;
  return [u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3];
};

// Chord midpoints against the curve at the midpoint parameter, since the vertices are at equal parameter steps.
const chordDeviations = (points: ReadonlyArray<readonly [number, number]>, controls: ReadonlyArray<number>): Array<number> => {
  const deviations: Array<number> = [];
  for (let index = 1; index < points.length; index++) {
    const [x0, y0] = points[index - 1] ?? [0, 0];
    const [x1, y1] = points[index] ?? [0, 0];
    const [x, y] = cubic(controls, (index - 0.5) / (points.length - 1));
    deviations.push(Math.hypot((x0 + x1) / 2 - x, (y0 + y1) / 2 - y));
  }
  return deviations;
};

describe('path flattening', () => {
  it('subdivides a cubic segment until every chord lies within 0.05 of the curve', () => {
    const controls = [0, 0, 0, 552.3, 447.7, 1000, 1000, 1000];
    const path = new PathBuilder(IDENTITY);
    path.moveTo(0, 0);
    path.curveTo([0, 552.3, 447.7, 1000, 1000, 1000]);
    const points = path.polygons().flat();
    const steps = points.length - 1;
    const deviations = chordDeviations(points, controls);
    expect([steps > 10, Math.max(...deviations) <= 0.05]).toStrictEqual([true, true]);
  });

  it('stops keeping points past the clip vertex limit but goes on counting them', () => {
    const path = new PathBuilder(IDENTITY);
    path.moveTo(0, 0);
    for (let index = 0; index < 4000; index++) {
      path.curveTo([100_000, 100_000, -100_000, 100_000, 0, 0]);
    }
    const kept = path.polygons().flat().length;
    expect([
      kept <= MAX_CLIP_VERTICES + 1,
      path.vertices > 4000 * 1000,
      Clip.NONE.intersect(path, 'nonzero').classifyPoint(0, 0),
      path.axisAlignedRectangles(),
    ]).toStrictEqual([true, true, 'unknown', undefined]);
  });

  it('transforms points by the matrix in force when the path is built', () => {
    const path = new PathBuilder([2, 0, 0, 2, 10, 0]);
    path.rectangle([0, 0, 5, 5]);
    expect(path.polygons()).toStrictEqual([
      [
        [10, 0],
        [20, 0],
        [20, 10],
        [10, 10],
      ],
    ]);
  });

  it('replaces one curve by at most 4,096 chords however far its control points lie', () => {
    const path = new PathBuilder(IDENTITY);
    path.moveTo(0, 0);
    path.curveTo([1e9, 0, -1e9, 0, 0, 0]);
    expect(path.vertices).toBe(4097);
  });

  it('starts the subpath after h at the start of the closed subpath', () => {
    // ISO 32000-1:2008, 8.5.2.1, Table 59, h: "Appending another segment to the current path shall begin a new subpath", from the point h returned to.
    const path = new PathBuilder(IDENTITY);
    path.moveTo(0, 0);
    path.lineTo(10, 0);
    path.lineTo(10, 10);
    path.close();
    const afterClose = path.currentPoint();
    path.lineTo(20, 20);
    expect([afterClose, path.polygons()]).toStrictEqual([
      [0, 0],
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        [
          [0, 0],
          [20, 20],
        ],
      ],
    ]);
  });

  it('adds no subpath for a moveTo past the vertex limit but counts its vertices', () => {
    const path = new PathBuilder(IDENTITY);
    path.moveTo(0, 0);
    for (let index = 1; index <= MAX_CLIP_VERTICES; index++) {
      path.lineTo(index, 0);
    }
    const [subpaths, vertices] = [path.polygons().length, path.vertices];
    for (let index = 0; index < 100; index++) {
      path.rectangle([0, 0, 1, 1]);
    }
    expect([subpaths, vertices, path.polygons().length, path.vertices]).toStrictEqual([1, 10_001, 1, 10_401]);
  });
});

const rectanglesOf = (draw: (path: PathBuilder) => void): ReturnType<PathBuilder['axisAlignedRectangles']> => {
  const path = new PathBuilder(IDENTITY);
  draw(path);
  return path.axisAlignedRectangles();
};

// Rectangles 5 wide, 10 apart, so that none touches another.
const disjoint = (count: number): ReturnType<PathBuilder['axisAlignedRectangles']> =>
  rectanglesOf(path => {
    for (let index = 0; index < count; index++) {
      path.rectangle([index * 10, 0, 5, 5]);
    }
  });

describe('axis-aligned rectangles', () => {
  it('normalises a rectangle drawn with negative sides and refuses one of zero area', () => {
    expect([
      rectanglesOf(path => {
        path.rectangle([10, 10, -5, -5]);
      }),
      rectanglesOf(path => {
        path.rectangle([0, 0, 0, 10]);
      }),
    ]).toStrictEqual([[[5, 5, 10, 10]], undefined]);
  });

  it('recognises a rectangle closed by a fifth point equal to the first', () => {
    expect(
      rectanglesOf(path => {
        path.moveTo(0, 0);
        path.lineTo(10, 0);
        path.lineTo(10, 10);
        path.lineTo(0, 10);
        path.lineTo(0, 0);
      }),
    ).toStrictEqual([[0, 0, 10, 10]]);
  });

  it('reads up to 64 rectangles and refuses 65', () => {
    const expected = Array.from({ length: 64 }, (_, index) => [index * 10, 0, index * 10 + 5, 5]);
    expect([disjoint(64), disjoint(65)]).toStrictEqual([expected, undefined]);
  });
});

// Rounding to 1e-6 absorbs the last bits of double arithmetic, which the two evaluations of the curve order differently.
const rounded = (points: ReadonlyArray<readonly [number, number]>): Array<Array<number>> =>
  points.map(point => point.map(value => Math.round(value * 1e6) / 1e6 + 0));

const coordinate = fc.integer({ min: -1000, max: 1000 });

describe('properties', () => {
  it('places the vertices of a flattened cubic on the curve at equal parameter steps from its start to its end', () => {
    fc.assert(
      fc.property(fc.tuple(coordinate, coordinate, coordinate, coordinate, coordinate, coordinate, coordinate, coordinate), controls => {
        const [x0, y0, x1, y1, x2, y2, x3, y3] = controls;
        const path = new PathBuilder(IDENTITY);
        path.moveTo(x0, y0);
        path.curveTo([x1, y1, x2, y2, x3, y3]);
        const points = path.polygons().flat();
        const steps = points.length - 1;
        expect(rounded(points)).toStrictEqual(rounded(points.map((_, index) => cubic(controls, index / steps))));
      }),
    );
  });

  it('reads disjoint rectangles under a positive scale and a translation as their transformed corners', () => {
    // Each rectangle lies in its own cell 20 wide, so no two overlap.
    const cell = fc.record({
      x: fc.integer({ min: 0, max: 5 }),
      y: fc.integer({ min: -50, max: 50 }),
      width: fc.integer({ min: 1, max: 10 }),
      height: fc.integer({ min: 1, max: 10 }),
    });
    const scale = fc.integer({ min: 1, max: 40 }).map(value => value / 4);
    fc.assert(
      fc.property(fc.array(cell, { minLength: 1, maxLength: 64 }), scale, scale, coordinate, coordinate, (cells, sx, sy, tx, ty) => {
        const path = new PathBuilder([sx, 0, 0, sy, tx, ty]);
        const placed = cells.map(({ x, y, width, height }, index) => [index * 20 + x, y, width, height] as const);
        for (const operands of placed) {
          path.rectangle(operands);
        }
        expect(path.axisAlignedRectangles()).toStrictEqual(
          placed.map(([x, y, width, height]) => [sx * x + tx, sy * y + ty, sx * (x + width) + tx, sy * (y + height) + ty]),
        );
      }),
    );
  });
});

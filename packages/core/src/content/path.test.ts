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
});

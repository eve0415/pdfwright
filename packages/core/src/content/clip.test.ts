import type { Quad } from './clip.ts';

import { describe, expect, it } from 'vitest';

import { Clip, rectanglePath } from './clip.ts';
import { IDENTITY } from './matrix.ts';
import { PathBuilder } from './path.ts';

const quad = ([left, bottom, right, top]: readonly [number, number, number, number]): Quad => [left, bottom, right, bottom, right, top, left, top];

// A square drawn counter-clockwise, or clockwise when asked.
const square = (
  path: PathBuilder,
  [left, bottom, size]: readonly [number, number, number],
  turn: 'counter-clockwise' | 'clockwise' = 'counter-clockwise',
): void => {
  const corners = [
    [left + size, bottom],
    [left + size, bottom + size],
    [left, bottom + size],
  ] as const;
  path.moveTo(left, bottom);
  for (const [x, y] of turn === 'clockwise' ? corners.toReversed() : corners) {
    path.lineTo(x, y);
  }
  path.close();
};

// A closed path of exactly `count` vertices around the square 0…100: the bottom side split into many short edges, then the top corners.
const manyVertices = (count: number): PathBuilder => {
  const path = new PathBuilder(IDENTITY);
  path.moveTo(0, 0);
  const steps = count - 3;
  for (let index = 1; index <= steps; index++) {
    path.lineTo((100 * index) / steps, 0);
  }
  path.lineTo(100, 100);
  path.lineTo(0, 100);
  path.close();
  return path;
};

// A rectangle 0…100 by 0…100 whose corners are quarter circles of radius 20, drawn with the usual cubic approximation.
const roundedRectangle = (): PathBuilder => {
  const path = new PathBuilder(IDENTITY);
  const k = 20 * 0.5523;
  path.moveTo(20, 0);
  path.lineTo(80, 0);
  path.curveTo([80 + k, 0, 100, 20 - k, 100, 20]);
  path.lineTo(100, 80);
  path.curveTo([100, 80 + k, 80 + k, 100, 80, 100]);
  path.lineTo(20, 100);
  path.curveTo([20 - k, 100, 0, 80 + k, 0, 80]);
  path.lineTo(0, 20);
  path.curveTo([0, 20 - k, 20 - k, 0, 20, 0]);
  path.close();
  return path;
};

describe('clip classification', () => {
  it('classifies quads against a rectangle as inside, outside or partial', () => {
    const clip = Clip.NONE.intersect(rectanglePath([0, 0, 100, 100], IDENTITY), 'nonzero');
    expect(
      [quad([10, 10, 20, 20]), quad([0, 0, 100, 100]), quad([150, 10, 160, 20]), quad([90, 10, 110, 20])].map(corners => clip.classifyQuad(corners)),
    ).toStrictEqual(['inside', 'inside', 'outside', 'partial']);
    expect([clip.classifyPoint(50, 50), clip.classifyPoint(-1, 50), Clip.NONE.classifyQuad(quad([-1e6, -1e6, 1e6, 1e6]))]).toStrictEqual([
      'inside',
      'outside',
      'inside',
    ]);
  });

  it('applies the nonzero and even-odd rules to nested subpaths', () => {
    const path = new PathBuilder(IDENTITY);
    square(path, [0, 0, 100]);
    square(path, [25, 25, 50]);
    // ISO 32000-1:2008, 8.5.3.3: both squares turn the same way, so the inner one has winding number 2 (inside by nonzero) and one crossing inside the outer (outside by even-odd).
    expect([Clip.NONE.intersect(path, 'nonzero').classifyPoint(50, 50), Clip.NONE.intersect(path, 'even-odd').classifyPoint(50, 50)]).toStrictEqual([
      'inside',
      'outside',
    ]);
    expect(Clip.NONE.intersect(path, 'even-odd').classifyQuad(quad([10, 10, 90, 90]))).toBe('partial');
    // Drawn clockwise, the winding numbers are −1 between the squares and −2 inside the inner one, so the even-odd parity is taken of a negative number.
    const clockwise = new PathBuilder(IDENTITY);
    square(clockwise, [0, 0, 100], 'clockwise');
    square(clockwise, [25, 25, 50], 'clockwise');
    const evenOdd = Clip.NONE.intersect(clockwise, 'even-odd');
    expect([evenOdd.classifyPoint(10, 10), evenOdd.classifyPoint(50, 50), Clip.NONE.intersect(clockwise, 'nonzero').classifyPoint(50, 50)]).toStrictEqual([
      'inside',
      'outside',
      'inside',
    ]);
  });

  it('follows the curves of a rounded rectangle', () => {
    const clip = Clip.NONE.intersect(roundedRectangle(), 'nonzero');
    // The corner square 0…4 lies inside the bounding box but outside the quarter circle; 10…14 is within it.
    // 6.5…8.5 lies within the quarter circle, 16.3 to 19.1 from its centre (20, 20), but wholly beyond its chord x + y = 20.
    expect([
      clip.classifyQuad(quad([0, 0, 4, 4])),
      clip.classifyQuad(quad([10, 10, 14, 14])),
      clip.classifyQuad(quad([2, 2, 14, 14])),
      clip.classifyQuad(quad([6.5, 6.5, 8.5, 8.5])),
    ]).toStrictEqual(['outside', 'inside', 'partial', 'inside']);
  });

  it('intersects successive clips and finds a quad that holds part of a clip boundary', () => {
    const triangle = new PathBuilder(IDENTITY);
    triangle.moveTo(0, 0);
    triangle.lineTo(150, 0);
    triangle.lineTo(0, 150);
    const clip = Clip.NONE.intersect(rectanglePath([0, 0, 100, 100], IDENTITY), 'nonzero').intersect(triangle, 'nonzero');
    // The quad 80…90 lies in the square but beyond the triangle's hypotenuse, and 110…120 by 10…20 in the triangle but beyond the square; a quad around a small clip's corner is partial though its corners are outside.
    expect([clip.classifyQuad(quad([10, 10, 20, 20])), clip.classifyQuad(quad([80, 80, 90, 90])), clip.classifyQuad(quad([110, 10, 120, 20]))]).toStrictEqual([
      'inside',
      'outside',
      'outside',
    ]);
    const small = Clip.NONE.intersect(rectanglePath([40, 40, 42, 42], IDENTITY), 'nonzero');
    expect(small.classifyQuad(quad([0, 0, 100, 100]))).toBe('partial');
  });

  it('finds a notch whose vertices lie on the quad boundary', () => {
    const notched = new PathBuilder(IDENTITY);
    for (const [x, y] of [
      [-100, -100],
      [5, -100],
      [5, 0],
      [10, 10],
      [6, 0],
      [6, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
    ] as const) {
      notched.lineTo(x, y);
    }
    // The triangle (5, 0), (10, 10), (6, 0) is cut out of the quad although no clip vertex is strictly inside it and no clip edge crosses a side.
    expect(Clip.NONE.intersect(notched, 'nonzero').classifyQuad(quad([0, 0, 10, 10]))).toBe('partial');
  });

  it('classifies a clip of 10,000 vertices and gives up at 10,001', () => {
    const [limit, past] = [Clip.NONE.intersect(manyVertices(10_000), 'nonzero'), Clip.NONE.intersect(manyVertices(10_001), 'nonzero')];
    expect([limit.vertices, limit.classifyPoint(50, 50), limit.classifyPoint(150, 50), limit.classifyQuad(quad([10, 10, 20, 20]))]).toStrictEqual([
      10_000,
      'inside',
      'outside',
      'inside',
    ]);
    expect([past.vertices, past.classifyPoint(50, 50), past.classifyQuad(quad([10, 10, 20, 20]))]).toStrictEqual([10_001, 'unknown', 'unknown']);
  });

  it('counts the vertices of every path of a clip against the limit', () => {
    const half = Clip.NONE.intersect(manyVertices(5000), 'nonzero');
    expect([
      half.intersect(manyVertices(5000), 'nonzero').classifyPoint(50, 50),
      Clip.NONE.intersect(manyVertices(5001), 'nonzero').classifyPoint(50, 50),
      half.intersect(manyVertices(5001), 'nonzero').classifyPoint(50, 50),
    ]).toStrictEqual(['inside', 'inside', 'unknown']);
  });

  it('classifies a quad outside two clips that each cross it but whose intersection misses it', () => {
    // 0…50 wide and 60…100 wide: each crosses the quad 40…70, and together they leave nothing of it.
    const clip = Clip.NONE.intersect(rectanglePath([0, 0, 50, 100], IDENTITY), 'nonzero').intersect(rectanglePath([60, 0, 100, 100], IDENTITY), 'nonzero');
    expect([
      clip.classifyQuad(quad([40, 10, 70, 20])),
      Clip.NONE.intersect(rectanglePath([0, 0, 50, 100], IDENTITY), 'nonzero').classifyQuad(quad([40, 10, 70, 20])),
    ]).toStrictEqual(['outside', 'partial']);
  });
});

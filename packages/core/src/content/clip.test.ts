import type { Quad } from './clip.ts';

import fc from 'fast-check';
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

  it('closes an open subpath with the edge from its last point back to its first', () => {
    // ISO 32000-1:2008, 8.5.3.3.1: "Any subpaths that are open shall be implicitly closed before being filled"; here the implied edge x = 100 is the only one to the right of the point.
    const open = new PathBuilder(IDENTITY);
    open.moveTo(100, 0);
    open.lineTo(0, 0);
    open.lineTo(0, 100);
    open.lineTo(100, 100);
    expect(Clip.NONE.intersect(open, 'nonzero').classifyPoint(50, 50)).toBe('inside');
  });

  it('finds a slit that only the crossing of a clip edge with a side of the quad reveals', () => {
    // Every sample of the quad 0…10 is inside one of the two rectangles, no clip vertex or edge midpoint is strictly inside it, and the slit 2…3 runs through it.
    const slit = new PathBuilder(IDENTITY);
    slit.rectangle([-100, -100, 102, 200]);
    slit.rectangle([3, -100, 97, 200]);
    expect(Clip.NONE.intersect(slit, 'nonzero').classifyQuad(quad([0, 0, 10, 10]))).toBe('partial');
  });

  it('classifies everything as unknown once intersected with a shape that is not known, whatever follows', () => {
    const unknown = Clip.NONE.intersectUnknown();
    const narrowed = unknown.intersect(rectanglePath([0, 0, 100, 100], IDENTITY), 'nonzero');
    expect([
      unknown.classifyPoint(0, 0),
      unknown.classifyQuad(quad([0, 0, 1, 1])),
      narrowed.classifyPoint(50, 50),
      narrowed.classifyQuad(quad([10, 10, 20, 20])),
    ]).toStrictEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  });

  it('counts a point within 1e-6 of the clip boundary as on it', () => {
    const clip = Clip.NONE.intersect(rectanglePath([0, 0, 100, 100], IDENTITY), 'nonzero');
    expect([clip.classifyPoint(100 + 1e-7, 50), clip.classifyPoint(100 + 1e-5, 50)]).toStrictEqual(['inside', 'outside']);
  });

  it('finds a clip inside a quad whose corners are given clockwise', () => {
    const small = Clip.NONE.intersect(rectanglePath([40, 40, 42, 42], IDENTITY), 'nonzero');
    expect(small.classifyQuad([0, 0, 0, 100, 100, 100, 100, 0])).toBe('partial');
  });

  it('encloses nothing by a path of a single point or of no segments', () => {
    const point = new PathBuilder(IDENTITY);
    point.moveTo(5, 5);
    expect([
      Clip.NONE.intersect(point, 'nonzero').classifyPoint(5, 5),
      Clip.NONE.intersect(new PathBuilder(IDENTITY), 'nonzero').classifyPoint(5, 5),
    ]).toStrictEqual(['outside', 'outside']);
  });

  it('classifies a quad outside two clips whose intersection is a sliver between the points of its grid', () => {
    // The clips overlap only on 50.1…50.6, which no point of the 9 by 9 grid over the quad 0…100, 12.5 apart, falls in.
    const clip = Clip.NONE.intersect(rectanglePath([-10, -10, 50.6, 110], IDENTITY), 'nonzero').intersect(
      rectanglePath([50.1, -10, 110, 110], IDENTITY),
      'nonzero',
    );
    expect([clip.classifyPoint(50.3, 50), clip.classifyQuad(quad([0, 0, 100, 100]))]).toStrictEqual(['inside', 'outside']);
  });
});

type Polygon = ReadonlyArray<readonly [number, number]>;

const pathOf = (polygons: ReadonlyArray<Polygon>): PathBuilder => {
  const path = new PathBuilder(IDENTITY);
  for (const [[x, y] = [0, 0], ...rest] of polygons) {
    path.moveTo(x, y);
    for (const [nextX, nextY] of rest) {
      path.lineTo(nextX, nextY);
    }
  }
  return path;
};

const small = fc.integer({ min: -20, max: 20 });
const polygons = fc.array(fc.array(fc.tuple(small, small), { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 });
const RULES = ['nonzero', 'even-odd'] as const;

// A coordinate with a fraction no integer clip coordinate shares, so that a quad's corners and grid points lie on no clip edge.
const offCoordinate = small.map(value => value + 0.3137);

describe('properties', () => {
  it('classifies points the same whichever way each subpath is drawn', () => {
    fc.assert(
      fc.property(polygons, fc.tuple(small, small), (shape, [x, y]) => {
        const forward = pathOf(shape);
        const backward = pathOf(shape.map(polygon => polygon.toReversed()));
        expect(RULES.map(rule => Clip.NONE.intersect(backward, rule).classifyPoint(x / 2, y / 2))).toStrictEqual(
          RULES.map(rule => Clip.NONE.intersect(forward, rule).classifyPoint(x / 2, y / 2)),
        );
      }),
    );
  });

  it('classifies points and quads against a rectangle as the intervals they span relate', () => {
    const span = fc.tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: 1, max: 50 }));
    // Points fall on quarters, so each is on the rectangle's boundary or at least 0.25 from it; quads fall on halves, so none touches it.
    const point = fc.tuple(fc.integer({ min: -400, max: 400 }), fc.integer({ min: -400, max: 400 })).map(([x, y]) => [x / 4, y / 4] as const);
    const halves = fc
      .tuple(fc.integer({ min: -110, max: 110 }), fc.integer({ min: 1, max: 100 }))
      .map(([start, length]) => [start + 0.5, start + 0.5 + length] as const);
    fc.assert(
      fc.property(span, span, point, halves, halves, ([left, width], [bottom, height], [x, y], [qLeft, qRight], [qBottom, qTop]) => {
        const [right, top] = [left + width, bottom + height];
        const clip = Clip.NONE.intersect(rectanglePath([left, bottom, right, top], IDENTITY), 'nonzero');
        const pointInside = left <= x && x <= right && bottom <= y && y <= top;
        const quadInside = left <= qLeft && qRight <= right && bottom <= qBottom && qTop <= top;
        const quadOutside = qRight < left || right < qLeft || qTop < bottom || top < qBottom;
        expect([clip.classifyPoint(x, y), clip.classifyQuad(quad([qLeft, qBottom, qRight, qTop]))]).toStrictEqual([
          pointInside ? 'inside' : 'outside',
          quadInside ? 'inside' : quadOutside ? 'outside' : 'partial',
        ]);
      }),
    );
  });

  it('classifies a quad inside one clip path only when every point of a grid over it is inside, and outside only when none is', () => {
    fc.assert(
      fc.property(
        polygons,
        fc.constantFrom(...RULES),
        offCoordinate,
        offCoordinate,
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (shape, rule, left, bottom, width, height) => {
          const clip = Clip.NONE.intersect(pathOf(shape), rule);
          const found = clip.classifyQuad(quad([left, bottom, left + width, bottom + height]));
          const grid = Array.from({ length: 81 }, (_, index) =>
            clip.classifyPoint(left + (width * (index % 9)) / 8, bottom + (height * Math.floor(index / 9)) / 8),
          );
          const disagreeing = found === 'partial' ? [] : grid.filter(point => point !== found);
          expect(disagreeing).toStrictEqual([]);
        },
      ),
    );
  });
});

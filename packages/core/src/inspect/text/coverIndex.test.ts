import type { Quad } from '../../content/clip.ts';
import type { CoverEvent } from '../../content/interpreter.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Clip, rectanglePath } from '../../content/clip.ts';
import { IDENTITY } from '../../content/matrix.ts';
import { ResourceLimitError } from '../../error/resourceLimitError.ts';

import { CoverIndex, quadBounds } from './coverIndex.ts';

const fill = (rectangle: CoverEvent['rectangle'], sequence = 0, clip = Clip.NONE): CoverEvent => ({
  rectangle,
  clip,
  sequence,
  context: { sources: [{ kind: 'page' }], colour: 'used' },
});

const BOUNDS = { left: 0, bottom: 0, right: 100, top: 100 };

// Queries a point repeatedly; the index refuses more than 4,000,000 comparisons over its life.
const queries = (index: CoverIndex, [x, y]: readonly [number, number], count: number): Array<boolean> => Array.from({ length: count }, () => index.hides(x, y));

// Whether one fill added to an index over BOUNDS hides the point.
const hiddenByOne = (rectangle: CoverEvent['rectangle'], [x, y]: readonly [number, number]): boolean => {
  const index = new CoverIndex(BOUNDS, 1);
  index.add(fill(rectangle));
  return index.hides(x, y);
};

describe('cover index', () => {
  it('does not repeat comparisons for identical fills', () => {
    const index = new CoverIndex(BOUNDS, 4000);
    const clip = Clip.NONE.intersect(rectanglePath([10, 10, 20, 20], IDENTITY), 'nonzero');
    for (let sequence = 0; sequence < 40_000; sequence++) {
      index.add(fill([0, 0, 100, 100], sequence, clip));
    }
    const hidden = Array.from({ length: 200 }, () => index.hides(50, 50));
    expect([hidden.every(value => !value)]).toStrictEqual([true]);
  });

  it('omits wide fills from queries outside their coarse bands', () => {
    // 2001 distinct fills read by each of 2001 queries would be 4,004,001 comparisons, past the limit, so a query must not read the bands it lies outside.
    const index = new CoverIndex(BOUNDS, 4000);
    for (let sequence = 0; sequence < 2001; sequence++) {
      index.add(fill([10, 10, 90 + sequence / 1_000_000, 90], sequence));
    }
    expect([queries(index, [0, 0], 2001).every(value => !value), index.hides(50, 50)]).toStrictEqual([true, true]);
  });

  it('keeps a tall narrow fill in the column bands, away from queries beside it in its rows', () => {
    // [40, 0, 45, 100] spans 4 of 64 columns and every row, too many cells for the grid; read by queries in its rows it would pass the comparison limit.
    const index = new CoverIndex(BOUNDS, 4000);
    for (let sequence = 0; sequence < 2001; sequence++) {
      index.add(fill([40, 0, 45 + sequence / 1_000_000, 100], sequence));
    }
    expect([queries(index, [60, 50], 2001).every(value => !value), index.hides(42, 50)]).toStrictEqual([true, true]);
  });

  it('finds a wide or a tall fill from queries in its first and last bands', () => {
    // Each fill spans every column or row and bands 0 to 6 of 64 the other way; the bands are 100 / 64 = 1.5625 wide.
    const index = new CoverIndex(BOUNDS, 4000);
    index.add(fill([0, 0, 100, 10]));
    index.add(fill([90, 0, 100, 100]));
    expect([
      index.hides(50, 0.5),
      index.hides(50, 9.9),
      index.hides(50, 10.5),
      index.hides(99.9, 50),
      index.hides(90.1, 50),
      index.hides(89.5, 50),
    ]).toStrictEqual([true, true, false, true, true, false]);
  });

  it('bounds comparisons when many large fills overlap a query but their clips exclude it', () => {
    const index = new CoverIndex(BOUNDS, 4000);
    const clip = Clip.NONE.intersect(rectanglePath([10, 10, 80, 80], IDENTITY), 'nonzero');
    for (let sequence = 0; sequence < 2001; sequence++) {
      index.add(fill([0, 0, 100 + sequence / 1_000_000, 100], sequence, clip));
    }
    expect(() => {
      for (let query = 0; query < 2001; query++) {
        index.hides(0, 0);
      }
    }).toThrow(ResourceLimitError);
  });

  it('counts a point within 10⁻⁶ of a fill’s edge as covered, and one further out as not', () => {
    // 100 glyphs over 100 by 100 give cells 10 wide, so the fill's edges lie on cell edges and a point just past them lies in the next cell.
    const index = new CoverIndex(BOUNDS, 100);
    index.add(fill([10, 10, 20, 20]));
    expect([index.hides(20 + 5e-7, 15), index.hides(20 + 2e-6, 15), index.hides(10 - 5e-7, 15), index.hides(15, 10 - 2e-6)]).toStrictEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('keeps a fill that starts within 10⁻⁶ outside the bounds', () => {
    const index = new CoverIndex(BOUNDS, 1);
    index.add(fill([100 + 5e-7, 10, 120, 20]));
    expect(index.hides(100, 15)).toBe(true);
  });

  it('keeps a fill that starts exactly 10⁻⁶ outside the bounds on any side, for a point on that edge of the bounds', () => {
    expect([
      hiddenByOne([100 + 1e-6, 10, 120, 20], [100, 15]),
      hiddenByOne([-20, 10, -1e-6, 20], [0, 15]),
      hiddenByOne([10, 100 + 1e-6, 20, 120], [15, 100]),
      hiddenByOne([10, -20, 20, -1e-6], [15, 0]),
    ]).toStrictEqual([true, true, true, true]);
  });

  it('skips a fill that starts further outside the bounds, even for a point inside its rectangle', () => {
    // Callers bound the index by every box they will query, so a fill wholly outside the bounds can hide nothing they ask about.
    const index = new CoverIndex(BOUNDS, 1);
    index.add(fill([100.01, 10, 120, 20]));
    expect(index.hides(110, 15)).toBe(false);
  });

  it.each([
    ['across', { left: -1e308, bottom: 0, right: 1e308, top: 100 }],
    ['up', { left: 0, bottom: -1e308, right: 100, top: 1e308 }],
  ])('keeps fills when the bounds span more %s than a number can hold', (_, bounds) => {
    // The width or height of these bounds overflows to Infinity, which no cell size divides into a count of cells.
    const index = new CoverIndex(bounds, 3);
    index.add(fill([10, 10, 20, 20]));
    index.add(fill([-1e308, -1e308, 1e308, 1e308], 1, Clip.NONE.intersect(rectanglePath([50, 50, 60, 60], IDENTITY), 'nonzero')));
    expect([index.hides(15, 15), index.hides(30, 15), index.hides(55, 55), index.hides(70, 70)]).toStrictEqual([true, false, true, false]);
  });

  it('keeps a fill whose edges lie at the extremes of bounds that overflow, for points at those extremes too', () => {
    const index = new CoverIndex({ left: -1e308, bottom: 0, right: 1e308, top: 100 }, 3);
    index.add(fill([-1e308, 0, 1e308, 50]));
    expect([index.hides(-1e308, 25), index.hides(0, 25), index.hides(1e308, 25), index.hides(1e308, 75)]).toStrictEqual([true, true, true, false]);
  });

  it('keeps the same rectangle again when it is painted under another clip', () => {
    // The first fill's clip excludes the query point; the second, under no clip, covers it.
    const index = new CoverIndex(BOUNDS, 1);
    const clip = Clip.NONE.intersect(rectanglePath([60, 60, 70, 70], IDENTITY), 'nonzero');
    index.add(fill([10, 10, 50, 50], 0, clip));
    index.add(fill([10, 10, 50, 50], 1));
    expect(index.hides(20, 20)).toBe(true);
  });

  it('builds one cell over bounds without area and finds the fill covering them', () => {
    const point = new CoverIndex({ left: 5, bottom: 5, right: 5, top: 5 }, 10);
    point.add(fill([0, 0, 10, 10]));
    const line = new CoverIndex({ left: 0, bottom: 5, right: 100, top: 5 }, 10);
    line.add(fill([40, 0, 50, 10]));
    expect([point.hides(5, 5), line.hides(45, 5), line.hides(60, 5)]).toStrictEqual([true, true, false]);
  });

  it('bounds the quads whose coordinates are all finite, or gives undefined when none are', () => {
    const square: Quad = [10, 20, 30, 20, 30, 40, 10, 40];
    // The square gives the left and top edges, and the turned quad's third corner the right edge and its second corner the bottom edge.
    const turned: Quad = [52, 3, 58, -5, 60, 9, 45, 2];
    // A quad with one coordinate that is not finite is skipped whole, so its finite coordinates (x 50, y 0) do not widen the bounds either.
    expect([
      quadBounds([]),
      quadBounds([square, turned]),
      quadBounds([square, [50, 0, Number.NaN, 20, 30, 40, 10, 40]]),
      quadBounds([square, [50, 0, 30, 20, 30, Infinity, 10, 40]]),
      quadBounds([[Number.NaN, 0, 1, 0, 1, 1, 0, 1]]),
    ]).toStrictEqual([
      undefined,
      { left: 10, bottom: -5, right: 60, top: 40 },
      { left: 10, bottom: 20, right: 30, top: 40 },
      { left: 10, bottom: 20, right: 30, top: 40 },
      undefined,
    ]);
  });
});

const TOLERANCE = 1e-6;

const inside = ([left, bottom, right, top]: CoverEvent['rectangle'], x: number, y: number): boolean =>
  x >= left - TOLERANCE && x <= right + TOLERANCE && y >= bottom - TOLERANCE && y <= top + TOLERANCE;

// Integer coordinates, so that points often fall on edges and cell boundaries; small rectangles go to the grid's cells, wide ones to its row bands and tall ones to its column bands, and any may reach past the bounds or lie outside them. fast-check keeps an array to about ten items unless its size is raised.
const rectangleOf = (maxWidth: number, maxHeight: number): fc.Arbitrary<CoverEvent['rectangle']> =>
  fc
    .tuple(
      fc.integer({ min: -20, max: 120 }),
      fc.integer({ min: -20, max: 120 }),
      fc.integer({ min: 0, max: maxWidth }),
      fc.integer({ min: 0, max: maxHeight }),
    )
    .map(([left, bottom, width, height]) => [left, bottom, left + width, bottom + height] as const);

describe('properties', () => {
  const rectangle = fc.oneof(
    { arbitrary: rectangleOf(12, 12), weight: 4 },
    { arbitrary: rectangleOf(120, 12), weight: 1 },
    { arbitrary: rectangleOf(12, 120), weight: 1 },
    { arbitrary: rectangleOf(120, 120), weight: 1 },
  );
  const scene = fc.record({
    width: fc.integer({ min: 0, max: 100 }),
    height: fc.integer({ min: 0, max: 100 }),
    count: fc.integer({ min: 1, max: 400 }),
    rectangles: fc.array(rectangle, { maxLength: 30, size: 'max' }),
    points: fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })), {
      minLength: 1,
      maxLength: 40,
      size: 'max',
    }),
  });

  it('hides a point inside the bounds exactly when some fill’s rectangle contains it', () => {
    fc.assert(
      fc.property(scene, ({ width, height, count, rectangles, points }) => {
        const index = new CoverIndex({ left: 0, bottom: 0, right: width, top: height }, count);
        for (const [sequence, rectangle] of rectangles.entries()) {
          index.add(fill(rectangle, sequence));
        }
        const at = points.map(([u, v]) => [Math.round(u * width * 4) / 4, Math.round(v * height * 4) / 4] as const);
        expect(at.map(([x, y]) => index.hides(x, y))).toStrictEqual(at.map(([x, y]) => rectangles.some(rectangle => inside(rectangle, x, y))));
      }),
    );
  });
});

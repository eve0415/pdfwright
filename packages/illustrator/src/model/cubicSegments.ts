import type { Coordinate, Point, Segment, Subpath } from './illustratorDocument.ts';
import type { Length } from '@pdfwright/core';

import { add, pt } from '@pdfwright/core';

/** A segment that PDF and Illustrator path operators draw directly. */
export type CubicSegment = Exclude<Segment, { readonly kind: 'quadratic' }>;

const exact = (value: Coordinate): Length => (typeof value === 'number' ? pt(value) : value);

// (a + 2b) / 3, kept exact when either coordinate is an exact length; add reduces the fraction it builds.
const twoThirdsToward = (from: Coordinate, toward: Coordinate): Coordinate => {
  if (typeof from === 'number' && typeof toward === 'number') return (from + 2 * toward) / 3;
  const towardLength = exact(toward);
  const sum = add(exact(from), add(towardLength, towardLength));
  return add({ numerator: sum.numerator, denominator: sum.denominator * 3n }, pt(0));
};

const raise = (from: Point, control: Point, to: Point): readonly [Point, Point] => [
  [twoThirdsToward(from[0], control[0]), twoThirdsToward(from[1], control[1])],
  [twoThirdsToward(to[0], control[0]), twoThirdsToward(to[1], control[1])],
];

/** Returns a subpath's segments with each quadratic raised to the cubic with control points P0 + 2/3 (Q − P0) and P2 + 2/3 (Q − P2), which traces the same curve. */
export const cubicSegments = (subpath: Subpath): readonly CubicSegment[] => {
  let current = subpath.start;
  return subpath.segments.map(segment => {
    const from = current;
    current = segment.to;
    if (segment.kind !== 'quadratic') return segment;
    const [control1, control2] = raise(from, segment.control, segment.to);
    return segment.anchor === undefined
      ? { kind: 'curve', control1, control2, to: segment.to }
      : { kind: 'curve', control1, control2, to: segment.to, anchor: segment.anchor };
  });
};

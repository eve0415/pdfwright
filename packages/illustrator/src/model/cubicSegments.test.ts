import type { Coordinate, Subpath } from './illustratorDocument.ts';
import type { Length } from '@pdfwright/core';

import { mm } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cubicSegments } from './cubicSegments.ts';

// B(t) = (1 − t)² P0 + 2 (1 − t) t Q + t² P2 for the quadratic and the Bernstein form of degree 3 for the cubic.
const quadraticAt = (p0: number, q: number, p2: number, t: number): number => (1 - t) ** 2 * p0 + 2 * (1 - t) * t * q + t ** 2 * p2;
const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number =>
  (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
const numeric = (value: Coordinate | undefined): number => (typeof value === 'number' ? value : Number.NaN);
const reduce = (numerator: bigint, denominator: bigint): Length => {
  let [a, b] = [numerator < 0n ? -numerator : numerator, denominator];
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return { numerator: numerator / a, denominator: denominator / a };
};
// (a/b + 2c/d) / 3 = (ad + 2cb) / 3bd, written in lowest terms.
const twoThirds = (from: Length, toward: Length): Length =>
  reduce(from.numerator * toward.denominator + 2n * toward.numerator * from.denominator, 3n * from.denominator * toward.denominator);

describe('cubic segments', () => {
  it('raises a quadratic to the cubic with control points two thirds of the way to its control point', () => {
    const subpath: Subpath = {
      start: [0, 0],
      segments: [
        { kind: 'quadratic', control: [30, 60], to: [60, 0], anchor: 'smooth' },
        { kind: 'line', to: [0, 0] },
      ],
    };
    expect(cubicSegments(subpath)).toStrictEqual([
      { kind: 'curve', control1: [20, 40], control2: [40, 40], to: [60, 0], anchor: 'smooth' },
      { kind: 'line', to: [0, 0] },
    ]);
  });

  it('keeps exact lengths exact and starts each quadratic at the end of the segment before it', () => {
    const subpath: Subpath = {
      start: [mm(0), mm(0)],
      segments: [
        { kind: 'line', to: [mm(1), mm(0)] },
        { kind: 'quadratic', control: [mm(2), 1], to: [mm(1), mm(3)] },
      ],
    };
    // 1 mm is 360/127 pt. x: (360/127 + 2 × 720/127) / 3 = 600/127 for both controls; y: (0 + 2 × 1) / 3 = 2/3 and (1080/127 + 2 × 1) / 3 = 1334/381.
    expect(cubicSegments(subpath)[1]).toStrictEqual({
      kind: 'curve',
      control1: [
        { numerator: 600n, denominator: 127n },
        { numerator: 2n, denominator: 3n },
      ],
      control2: [
        { numerator: 600n, denominator: 127n },
        { numerator: 1334n, denominator: 381n },
      ],
      to: [mm(1), mm(3)],
    });
  });

  // Each quadratic starts at the end point of the segment before it, never at the subpath start or a control point.
  it.each([
    {
      case: 'a quadratic after a quadratic',
      segments: [
        { kind: 'quadratic', control: [30, 60], to: [60, 0] },
        { kind: 'quadratic', control: [90, -60], to: [120, 0] },
      ],
      // (60 + 2 × 90) / 3 = 80, (0 + 2 × −60) / 3 = −40 and (120 + 2 × 90) / 3 = 100.
      expected: [
        { kind: 'curve', control1: [20, 40], control2: [40, 40], to: [60, 0] },
        { kind: 'curve', control1: [80, -40], control2: [100, -40], to: [120, 0] },
      ],
    },
    {
      case: 'a quadratic after a curve',
      segments: [
        { kind: 'curve', control1: [0, 30], control2: [30, 30], to: [30, 0] },
        { kind: 'quadratic', control: [45, -30], to: [60, 0] },
      ],
      // (30 + 2 × 45) / 3 = 40, (0 + 2 × −30) / 3 = −20 and (60 + 2 × 45) / 3 = 50.
      expected: [
        { kind: 'curve', control1: [0, 30], control2: [30, 30], to: [30, 0] },
        { kind: 'curve', control1: [40, -20], control2: [50, -20], to: [60, 0] },
      ],
    },
  ] as const)('raises $case from the end of the segment before it', ({ segments, expected }) => {
    expect(cubicSegments({ start: [0, 0], segments })).toStrictEqual(expected);
  });

  describe('properties', () => {
    const coordinate = fc.integer({ min: -100_000, max: 100_000 });
    const point = fc.tuple(coordinate, coordinate);

    it('traces the same points as the quadratic it raises', () => {
      fc.assert(
        fc.property(point, point, point, fc.double({ min: 0, max: 1, noNaN: true }), (start, control, to, t) => {
          const [raised] = cubicSegments({ start, segments: [{ kind: 'quadratic', control, to }] });
          const control1 = raised?.kind === 'curve' ? raised.control1 : undefined;
          const control2 = raised?.kind === 'curve' ? raised.control2 : undefined;
          for (const axis of [0, 1] as const) {
            const traced = cubicAt(start[axis], numeric(control1?.[axis]), numeric(control2?.[axis]), to[axis], t);
            // 1e-9 of the largest coordinate.
            expect(Math.abs(traced - quadraticAt(start[axis], control[axis], to[axis], t))).toBeLessThanOrEqual(1e-4);
          }
        }),
      );
    });

    const length = fc
      .tuple(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 12n }))
      .map(([numerator, denominator]) => reduce(numerator, denominator));

    it('raises exact lengths to the exact rationals (P + 2Q) / 3', () => {
      fc.assert(
        fc.property(fc.tuple(length, length), fc.tuple(length, length), fc.tuple(length, length), (start, control, to) => {
          expect(cubicSegments({ start, segments: [{ kind: 'quadratic', control, to }] })).toStrictEqual([
            {
              kind: 'curve',
              control1: [twoThirds(start[0], control[0]), twoThirds(start[1], control[1])],
              control2: [twoThirds(to[0], control[0]), twoThirds(to[1], control[1])],
              to,
            },
          ]);
        }),
      );
    });
  });
});

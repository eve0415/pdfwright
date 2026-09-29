import type { Subpath } from './illustratorDocument.ts';

import { mm } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { cubicSegments } from './cubicSegments.ts';

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
});

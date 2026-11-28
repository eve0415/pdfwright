import type { IllustratorDocument, PathItem } from '../model/illustratorDocument.ts';

import { pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { numberDeviation } from './modelNumbers.ts';

const path = (x: number, y: number): PathItem => ({
  kind: 'path',
  geometry: { subpaths: [{ start: [x, y], segments: [{ kind: 'line', to: [x + 10, y] }] }] },
  fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
});
const model = (items: ReadonlyArray<PathItem>): IllustratorDocument => ({
  artboard: { width: 100, height: 70 },
  layers: [{ name: 'Art', items }],
  lastModified: pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' }),
});

describe('numberDeviation', () => {
  it('is 0 for models with the same numbers', () => {
    expect(numberDeviation(model([path(1, 2)]), model([path(1, 2)]))).toBe(0);
  });

  it('is the largest absolute difference between corresponding numbers', () => {
    // One number is 0.25 too large and another 0.5 too small, so a signed or smallest difference gives another answer.
    expect(numberDeviation(model([path(1.25, 1.5)]), model([path(1, 2)]))).toBe(0.5);
  });

  it('is infinite when either model holds an extra item', () => {
    expect([
      numberDeviation(model([path(1, 2), path(1, 2)]), model([path(1, 2)])),
      numberDeviation(model([path(1, 2)]), model([path(1, 2), path(1, 2)])),
    ]).toStrictEqual([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
  });
});

import type { IllustratorDocument, PathGeometry } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';

import { artBounds, integerBounds } from './bounds.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 0, minute: 0, second: 0, offset: 'Z' });
const rectangle: PathGeometry = {
  start: [0, 0],
  segments: [
    { kind: 'line', to: [10, 0] },
    { kind: 'line', to: [10, 10] },
    { kind: 'line', to: [0, 10] },
  ],
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
                start: [10, 10],
                segments: [
                  { kind: 'line', to: [60, 60] },
                  { kind: 'line', to: [110, 10] },
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
                start: [10, 10],
                segments: [
                  { kind: 'line', to: [60, 60] },
                  { kind: 'line', to: [12, 10] },
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
    const document: IllustratorDocument = {
      artboard: { width: 120, height: 100 },
      lastModified: date,
      layers: [
        {
          name: 'Curve',
          items: [
            {
              kind: 'path',
              geometry: {
                start: [10, 10],
                segments: [
                  { kind: 'curve', control1: [25, 25], control2: [45, 45], to: [60, 60] },
                  { kind: 'line', to: [110, 10] },
                ],
              },
              stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 10 },
            },
          ],
        },
      ],
    };
    expect(artBounds(document).maxY).toBeCloseTo(60 + 5 * Math.SQRT2);
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
              geometry: { start: [0, 0], segments: [{ kind: 'curve', control1: [0, 2], control2: [1, 2], to: [1, 0] }] },
              stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 1 },
            },
          ],
        },
      ],
    };
    expect(artBounds(document)).toStrictEqual({ minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 2 });
    expect(integerBounds(artBounds(document))).toStrictEqual([-1, -1, 2, 2]);
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
                start: [20, 30],
                segments: [
                  { kind: 'line', to: [40, 30] },
                  { kind: 'line', to: [40, 50] },
                  { kind: 'line', to: [20, 50] },
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
    expect(artBounds({ ...document, layers: [] })).toStrictEqual({ minX: 0, minY: 0, maxX: 36000 / 127, maxY: 50 });
  });
});

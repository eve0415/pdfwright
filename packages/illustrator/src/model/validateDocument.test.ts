import type { IllustratorDocument, Layer, PathItem, RasterItem, SpotColor } from './illustratorDocument.ts';

import { UnsupportedFeatureError, ValidationError, mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeIllustratorPdf } from '../writeIllustratorPdf.ts';

import { validateDocument } from './validateDocument.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const spot: SpotColor = { name: 'White', alternate: [0, 0, 0, 0] };
const path: PathItem = {
  kind: 'path',
  geometry: {
    start: [0, 0],
    segments: [
      { kind: 'line', to: [10, 0] },
      { kind: 'line', to: [10, 10] },
      { kind: 'line', to: [0, 10] },
    ],
  },
  fill: { paint: { kind: 'spot', spot } },
};
const raster: RasterItem = {
  kind: 'raster',
  width: 2,
  height: 1,
  bounds: { x: 0, y: 0, width: mm(10), height: mm(5) },
  color: { space: 'cmyk', samples: new Uint8Array(8) },
  alpha: new Uint8Array([255, 0]),
};
const layer: Layer = { name: 'Artwork', items: [path, raster] };
const document: IllustratorDocument = {
  artboard: { width: mm(100), height: mm(70) },
  layers: [layer],
  lastModified: date,
};
const validates =
  (candidate: IllustratorDocument): (() => void) =>
  () => {
    validateDocument(candidate);
  };

const corrupt = (source: IllustratorDocument, key: keyof IllustratorDocument, value: unknown): IllustratorDocument => {
  const candidate = { ...source };
  Object.defineProperty(candidate, key, { value, enumerable: true });
  return candidate;
};

describe('illustrator document validation', () => {
  it('accepts a CMYK artboard with a spot path and an alpha raster', () => {
    expect(validates(document)).not.toThrow();
  });

  it('accepts finite coordinates with bigint terms beyond Number range', () => {
    const huge = 10n ** 400n;
    const ten = { numerator: huge * 10n, denominator: huge };
    expect(
      validates({
        ...document,
        artboard: { width: ten, height: ten },
        layers: [{ name: 'Artwork', items: [{ ...path, geometry: { ...path.geometry, start: [ten, 0] } }] }],
      }),
    ).not.toThrow();
  });

  it('rejects unobserved locked layers', () => {
    expect(validates({ ...document, layers: [{ ...layer, locked: true }] })).toThrow(UnsupportedFeatureError);
  });

  it('rejects duplicate and control-character layer names', () => {
    expect(validates({ ...document, layers: [layer, layer] })).toThrow(ValidationError);
    expect(validates({ ...document, layers: [{ name: 'Bad\nname', items: [path] }] })).toThrow(ValidationError);
  });

  it('keeps layer XML identifiers unique and rejects lone surrogates', () => {
    expect(
      validates({
        ...document,
        layers: [
          { name: 'A B', items: [] },
          { name: 'A_B', items: [] },
          { name: 'A%', items: [] },
          { name: 'A_x25_', items: [] },
        ],
      }),
    ).not.toThrow();
    expect(validates({ ...document, layers: [{ name: '\uD800', items: [] }] })).toThrow(ValidationError);
  });

  it('rejects invalid geometry, opacity, color components and raster sizes', () => {
    expect(validates({ ...document, artboard: { width: 16384, height: 10 } })).toThrow(ValidationError);
    expect(validates({ ...document, layers: [{ name: 'A', opacity: 1.1, items: [path] }] })).toThrow(ValidationError);
    expect(validates({ ...document, layers: [{ name: 'A', items: [{ ...path, geometry: { ...path.geometry, start: [Infinity, 0] } }] }] })).toThrow(
      ValidationError,
    );
    expect(validates({ ...document, layers: [{ name: 'A', items: [{ ...raster, alpha: new Uint8Array(1) }] }] })).toThrow(ValidationError);
    expect(validates({ ...document, layers: [{ name: 'A', items: [{ kind: 'path', geometry: path.geometry }] }] })).toThrow(ValidationError);
  });

  it('gives caller validation failures a typed reason', () => {
    const invalid: IllustratorDocument[] = [
      { ...document, layers: [layer, layer] },
      { ...document, layers: [{ ...layer, opacity: 2 }] },
      { ...document, layers: [{ ...layer, items: [{ ...raster, alpha: new Uint8Array(1) }] }] },
    ];
    for (const candidate of invalid) {
      expect(() => {
        validateDocument(candidate);
      }).toThrow(expect.objectContaining({ reason: 'illustrator-model' }));
    }
  });

  it('rejects oversized bleed, strokes and PDF colorant names before writing', () => {
    expect(validates({ ...document, artboard: { width: 100, height: 100, bleed: 1e9 } })).toThrow(ValidationError);
    expect(
      validates({ ...document, layers: [{ name: 'A', items: [{ ...path, stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 1e14 } }] }] }),
    ).toThrow(ValidationError);
    for (const nameBytes of [Uint8Array.of(0), new Uint8Array(128).fill(65)]) {
      expect(
        validates({ ...document, layers: [{ name: 'A', items: [{ ...path, fill: { paint: { kind: 'spot', spot: { ...spot, nameBytes } } } }] }] }),
      ).toThrow(ValidationError);
    }
  });

  it('rejects empty paths and raster scales that serialize as zero', () => {
    expect(validates({ ...document, layers: [{ name: 'A', items: [{ ...path, geometry: { start: [0, 0], segments: [] } }] }] })).toThrow(ValidationError);
    expect(validates({ ...document, layers: [{ name: 'A', items: [{ kind: 'clipGroup', clip: { start: [0, 0], segments: [] }, items: [path] }] }] })).toThrow(
      ValidationError,
    );
    const tiny = {
      ...raster,
      width: 1000,
      height: 1,
      bounds: { x: 0, y: 0, width: 1e-8, height: 1 },
      color: { space: 'cmyk' as const, samples: new Uint8Array(4000) },
      alpha: new Uint8Array(1000),
    };
    expect(validates({ ...document, layers: [{ name: 'A', items: [tiny] }] })).toThrow(ValidationError);
  });

  it('reports malformed bleed and non-boolean flags as validation errors', () => {
    const malformed: IllustratorDocument[] = [
      corrupt(document, 'artboard', { width: 100, height: 100, bleed: { top: 1 } }),
      corrupt(document, 'layers', [{ ...layer, visible: 'false' }]),
      corrupt(document, 'layers', [{ ...layer, locked: 'true' }]),
      corrupt(document, 'layers', [{ ...layer, items: [{ ...path, fill: { ...path.fill, overprint: 'true' } }] }]),
      corrupt(document, 'layers', [{ ...layer, items: [{ kind: 'group', isolated: 'yes', items: [path] }] }]),
    ];
    for (const candidate of malformed) {
      expect(() => {
        validateDocument(candidate);
      }).toThrow(ValidationError);
    }
    const options = { compression: 'zstandard' as const };
    Object.defineProperty(options, 'compression', { value: 'unknown' });
    expect(() => writeIllustratorPdf(document, options)).toThrow(ValidationError);
  });

  it('rejects conflicting spot definitions using the same colorant bytes', () => {
    const different: SpotColor = { name: 'White', alternate: [0, 0, 0, 0.5] };
    const second: PathItem = { ...path, fill: { paint: { kind: 'spot', spot: different } } };
    expect(validates({ ...document, layers: [{ name: 'A', items: [path, second] }] })).toThrow(ValidationError);
  });

  it('rejects one spot name with different page bytes or alternates', () => {
    const different: SpotColor = { name: 'White', nameBytes: Uint8Array.of(0x57, 0x68, 0x69, 0x74, 0x65, 0x32), alternate: [0, 0, 0, 0] };
    const second: PathItem = { ...path, fill: { paint: { kind: 'spot', spot: different } } };
    expect(validates({ ...document, layers: [{ name: 'A', items: [path, second] }] })).toThrow(ValidationError);
    const alternate: SpotColor = { name: 'White', alternate: [0, 0, 0, 1] };
    expect(validates({ ...document, layers: [{ name: 'A', items: [path, { ...path, fill: { paint: { kind: 'spot', spot: alternate } } }] }] })).toThrow(
      ValidationError,
    );
  });

  it('rejects unsupported artwork fields with a typed feature error', () => {
    const rgbDocument = { ...document, colorSpace: 'RGB' };
    const openPath = { ...path, open: true };
    const gradientPath = { ...path, gradient: { kind: 'linear' } };
    expect(validates(rgbDocument)).toThrow(UnsupportedFeatureError);
    expect(validates({ ...document, layers: [{ name: 'A', items: [openPath] }] })).toThrow(UnsupportedFeatureError);
    expect(validates({ ...document, layers: [{ name: 'A', items: [gradientPath] }] })).toThrow(UnsupportedFeatureError);
  });
});

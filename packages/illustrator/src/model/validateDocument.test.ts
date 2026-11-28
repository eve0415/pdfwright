import type { Artboard, Fill, IllustratorDocument, Item, Layer, PathItem, RasterItem, SpotColor, Subpath } from './illustratorDocument.ts';

import { UnsupportedFeatureError, ValidationError, mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeIllustratorPdf } from '../writeIllustratorPdf.ts';

import { validateDocument } from './validateDocument.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const spot: SpotColor = { name: 'White', alternate: [0, 0, 0, 0] };
const square: Subpath = {
  start: [0, 0],
  segments: [
    { kind: 'line', to: [10, 0] },
    { kind: 'line', to: [10, 10] },
    { kind: 'line', to: [0, 10] },
  ],
};
const path: PathItem = { kind: 'path', geometry: { subpaths: [square] }, fill: { paint: { kind: 'spot', spot } } };
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

const withItems = (items: ReadonlyArray<Item>, artboard: Artboard = document.artboard): IllustratorDocument => ({
  ...document,
  artboard,
  layers: [{ name: 'A', items }],
});
const withUntypedItems = (items: ReadonlyArray<unknown>): IllustratorDocument => corrupt(document, 'layers', [{ name: 'A', items }]);
const fillPath = (fill: Fill): PathItem => ({ kind: 'path', geometry: { subpaths: [square] }, fill });
const spotPath = (color: SpotColor, tint?: number): PathItem =>
  fillPath({ paint: tint === undefined ? { kind: 'spot', spot: color } : { kind: 'spot', spot: color, tint } });
// A path whose one segment runs from the start back to the origin, so the start is the only coordinate that can be wrong.
const withStart = (x: unknown, y: unknown, artboard: Artboard = document.artboard): IllustratorDocument =>
  corrupt({ ...document, artboard }, 'layers', [
    { name: 'A', items: [{ ...path, geometry: { subpaths: [{ start: [x, y], segments: [{ kind: 'line', to: [0, 0] }] }] } }] },
  ]);
const bled = (width: number, height: number, bleed: unknown): IllustratorDocument => corrupt(document, 'artboard', { width, height, bleed });
const placed = (width: number, height: number): RasterItem => ({ ...raster, bounds: { x: 8232, y: 8282, width, height } });

// The validator reports model errors as ValidationError with a typed reason and unsupported fields or kinds as UnsupportedFeatureError; anything else names the error it threw.
const outcomeOf = (candidate: IllustratorDocument): string => {
  try {
    validateDocument(candidate);
    return 'accepted';
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) {
      return 'unsupported';
    }
    if (error instanceof ValidationError && error.reason === 'illustrator-model') {
      return 'model';
    }
    if (error instanceof ValidationError && error.reason === 'illustrator-spot-identity') {
      return 'spot-identity';
    }
    return `other: ${String(error)}`;
  }
};

const nested = (levels: number): Item => {
  let item: Item = path;
  for (let index = 0; index < levels; index++) {
    item = { kind: 'group', items: [item] };
  }
  return item;
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
        layers: [{ name: 'Artwork', items: [{ ...path, geometry: { subpaths: [{ ...square, start: [ten, 0] }] } }] }],
      }),
    ).not.toThrow();
  });

  it('accepts layer and item locks', () => {
    expect(validates({ ...document, layers: [{ ...layer, locked: true, items: [{ ...path, locked: true }] }] })).not.toThrow();
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
    // Two different names whose XML identifiers collide: the underscore escapes to _x5f_ and each space becomes an underscore.
    const colliding: IllustratorDocument = {
      ...document,
      layers: [
        { name: 'A_', items: [] },
        { name: 'A x5f ', items: [] },
      ],
    };
    expect(outcomeOf(colliding)).toBe('model');
    expect(validates({ ...document, layers: [{ name: '\uD800', items: [] }] })).toThrow(ValidationError);
  });

  it.each([
    { case: 'an artboard wider than the canvas', candidate: { ...document, artboard: { width: 16_384, height: 10 } } },
    { case: 'a layer opacity above 1', candidate: { ...document, layers: [{ name: 'A', opacity: 1.1, items: [path] }] } },
    { case: 'an infinite coordinate', candidate: withItems([{ ...path, geometry: { subpaths: [{ ...square, start: [Infinity, 0] }] } }]) },
    { case: 'a short raster alpha plane', candidate: withItems([{ ...raster, alpha: new Uint8Array(1) }]) },
    { case: 'a path with neither fill nor stroke', candidate: withItems([{ kind: 'path', geometry: path.geometry }]) },
    { case: 'a CMYK component above 1', candidate: withItems([fillPath({ paint: { kind: 'process', cmyk: [1.1, 0, 0, 0] } })]) },
    { case: 'a CMYK component below 0', candidate: withItems([fillPath({ paint: { kind: 'process', cmyk: [0, 0, 0, -0.1] } })]) },
    { case: 'a spot alternate above 1', candidate: withItems([spotPath({ name: 'Varnish', alternate: [0, 0, 1.1, 0] })]) },
    { case: 'a spot tint above 1', candidate: withItems([spotPath(spot, 1.1)]) },
  ])('rejects $case as an invalid model', ({ candidate }) => {
    expect(outcomeOf(candidate)).toBe('model');
  });

  it('gives caller validation failures a typed reason', () => {
    const invalid: Array<IllustratorDocument> = [
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
    expect(validates({ ...document, layers: [{ name: 'A', items: [{ ...path, geometry: { subpaths: [{ start: [0, 0], segments: [] }] } }] }] })).toThrow(
      ValidationError,
    );
    expect(
      validates({ ...document, layers: [{ name: 'A', items: [{ kind: 'clipGroup', clip: { subpaths: [{ start: [0, 0], segments: [] }] }, items: [path] }] }] }),
    ).toThrow(ValidationError);
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

  it('accepts several subpaths, either fill rule and quadratic segments', () => {
    const hole: Subpath = { start: [2, 2], segments: [{ kind: 'quadratic', control: [5, 8], to: [8, 2] }] };
    const compound: PathItem = { ...path, geometry: { subpaths: [square, hole], fillRule: 'evenodd' } };
    const clip: Item = { kind: 'clipGroup', clip: { subpaths: [square, hole], fillRule: 'nonzero' }, items: [path] };
    expect(validates({ ...document, layers: [{ name: 'A', items: [compound, clip] }] })).not.toThrow();
  });

  it('rejects a path without subpaths, an unknown fill rule and unknown subpath fields', () => {
    expect(validates({ ...document, layers: [{ name: 'A', items: [{ ...path, geometry: { subpaths: [] } }] }] })).toThrow(ValidationError);
    const badRule = corrupt(document, 'layers', [{ name: 'A', items: [{ ...path, geometry: { subpaths: [square], fillRule: 'winding' } }] }]);
    expect(validates(badRule)).toThrow(ValidationError);
    const openSubpath = { ...path, geometry: { subpaths: [{ ...square, open: true }] } };
    expect(validates({ ...document, layers: [{ name: 'A', items: [openSubpath] }] })).toThrow(UnsupportedFeatureError);
    const arc = corrupt(document, 'layers', [
      { name: 'A', items: [{ ...path, geometry: { subpaths: [{ start: [0, 0], segments: [{ kind: 'arc', to: [1, 1] }] }] } }] },
    ]);
    expect(validates(arc)).toThrow(UnsupportedFeatureError);
  });

  it('reports deeply nested groups as a validation error', () => {
    expect(validates(withItems([nested(20_000)]))).toThrow(ValidationError);
  });

  it('accepts groups nested 128 levels deep and rejects 129', () => {
    expect(outcomeOf(withItems([nested(128)]))).toBe('accepted');
    expect(outcomeOf(withItems([nested(129)]))).toBe('model');
  });

  it('reports malformed bleed and non-boolean flags as validation errors', () => {
    const malformed: Array<IllustratorDocument> = [
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
    expect(outcomeOf(withItems([path, second]))).toBe('spot-identity');
  });

  it('rejects one spot name with different page bytes and one set of page bytes under two names', () => {
    const different: SpotColor = { name: 'White', nameBytes: Uint8Array.of(0x57, 0x68, 0x69, 0x74, 0x65, 0x32), alternate: [0, 0, 0, 0] };
    expect(outcomeOf(withItems([path, spotPath(different)]))).toBe('spot-identity');
    const renamed: SpotColor = { name: 'Blanc', nameBytes: new TextEncoder().encode('White'), alternate: [0, 0, 0, 0] };
    expect(outcomeOf(withItems([path, spotPath(renamed)]))).toBe('spot-identity');
  });

  it('rejects unsupported artwork fields with a typed feature error', () => {
    const rgbDocument = { ...document, colorSpace: 'RGB' };
    const openPath = { ...path, open: true };
    const gradientPath = { ...path, gradient: { kind: 'linear' } };
    expect(validates(rgbDocument)).toThrow(UnsupportedFeatureError);
    expect(validates({ ...document, layers: [{ name: 'A', items: [openPath] }] })).toThrow(UnsupportedFeatureError);
    expect(validates({ ...document, layers: [{ name: 'A', items: [gradientPath] }] })).toThrow(UnsupportedFeatureError);
  });

  describe('artboard', () => {
    const sized = (width: number, height: number): IllustratorDocument => ({ ...document, artboard: { width, height } });
    it.each([
      { case: 'width 0', candidate: sized(0, 100), outcome: 'model' },
      { case: 'width -1', candidate: sized(-1, 100), outcome: 'model' },
      { case: 'width 14400', candidate: sized(14_400, 100), outcome: 'accepted' },
      { case: 'width 14400.001', candidate: sized(14_400.001, 100), outcome: 'model' },
      { case: 'height 0', candidate: sized(100, 0), outcome: 'model' },
      { case: 'height -1', candidate: sized(100, -1), outcome: 'model' },
      { case: 'height 14400', candidate: sized(100, 14_400), outcome: 'accepted' },
      { case: 'height 14400.001', candidate: sized(100, 14_400.001), outcome: 'model' },
      { case: 'the name Board 1', candidate: { ...document, artboard: { ...document.artboard, name: 'Board 1' } }, outcome: 'accepted' },
      { case: 'an empty name', candidate: { ...document, artboard: { ...document.artboard, name: '' } }, outcome: 'model' },
      { case: 'a name with a line feed', candidate: { ...document, artboard: { ...document.artboard, name: 'Board\n1' } }, outcome: 'model' },
      { case: 'an unknown field', candidate: corrupt(document, 'artboard', { ...document.artboard, orientation: 'portrait' }), outcome: 'unsupported' },
    ] as const)('gives $case the outcome $outcome', ({ candidate, outcome }) => {
      expect(outcomeOf(candidate)).toBe(outcome);
    });
  });

  describe('bleed', () => {
    const sides = { top: 1, right: 2, bottom: 3, left: 4 } as const;
    it.each([
      { case: 'a negative bleed', candidate: bled(100, 100, -1), outcome: 'model' },
      { case: 'a zero bleed', candidate: bled(100, 100, 0), outcome: 'accepted' },
      { case: 'different bleed on each side', candidate: bled(100, 100, sides), outcome: 'accepted' },
      { case: 'a negative left bleed', candidate: bled(100, 100, { ...sides, left: -1 }), outcome: 'model' },
      // Left plus right is 6 and top plus bottom is 4, so a limit summed over the wrong pair of sides gives the other outcome.
      { case: 'a page exactly 14400 wide with its bleed', candidate: bled(14_394, 100, sides), outcome: 'accepted' },
      { case: 'a page one point wider than 14400 with its bleed', candidate: bled(14_395, 100, sides), outcome: 'model' },
      { case: 'a page exactly 14400 tall with its bleed', candidate: bled(100, 14_396, sides), outcome: 'accepted' },
      { case: 'a page one point taller than 14400 with its bleed', candidate: bled(100, 14_397, sides), outcome: 'model' },
      { case: 'an exact-length bleed', candidate: bled(100, 100, mm(3)), outcome: 'accepted' },
      { case: 'a string bleed', candidate: bled(100, 100, '3'), outcome: 'model' },
      { case: 'bleed sides with an unknown side', candidate: bled(100, 100, { ...sides, inner: 1 }), outcome: 'unsupported' },
    ] as const)('gives $case the outcome $outcome', ({ candidate, outcome }) => {
      expect(outcomeOf(candidate)).toBe(outcome);
    });
  });

  describe('title', () => {
    it.each([
      { case: 'a space (U+0020)', title: ' ', outcome: 'accepted' },
      { case: 'a tilde (U+007E)', title: 'Box ~ lid', outcome: 'accepted' },
      { case: 'a unit separator (U+001F)', title: 'A\u001FB', outcome: 'model' },
      { case: 'a tab', title: 'A\tB', outcome: 'model' },
      { case: 'a delete (U+007F)', title: 'A\u007FB', outcome: 'model' },
      { case: 'an accented letter', title: 'Café', outcome: 'model' },
    ] as const)('gives a title with $case the outcome $outcome', ({ title, outcome }) => {
      expect(outcomeOf({ ...document, title })).toBe(outcome);
    });
  });

  describe('coordinates', () => {
    it.each([
      // −5 / −1 would be the valid coordinate 5, so only the denominator check rejects it.
      { case: 'a rational with a negative denominator', x: { numerator: -5n, denominator: -1n } },
      { case: 'a rational with a number numerator', x: { numerator: 1, denominator: 1n } },
      { case: 'NaN', x: Number.NaN },
      { case: 'a string', x: '5' },
    ])('rejects $case as a coordinate', ({ x }) => {
      expect(outcomeOf(withStart(x, 0))).toBe('model');
    });

    it('accepts a rational whose terms are both positive', () => {
      expect(outcomeOf(withStart({ numerator: 5n, denominator: 1n }, 0))).toBe('accepted');
    });

    it('accepts a 10-point rational whose numerator alone is beyond Number range', () => {
      expect(outcomeOf(withStart({ numerator: 10n ** 309n, denominator: 10n ** 308n }, 0))).toBe('accepted');
    });

    // A 100 × 200 artboard sits on the 16383-point Illustrator canvas with its origin at floor(8191.5 − 50) = 8141 points from the canvas's left edge and floor(8191.5 − 100) = 8091 points from its bottom edge.
    const artboard = { width: 100, height: 200 };
    it.each([
      { x: -8141, y: 0, outcome: 'accepted' },
      { x: -8141.5, y: 0, outcome: 'model' },
      { x: 8242, y: 0, outcome: 'accepted' },
      { x: 8242.5, y: 0, outcome: 'model' },
      { x: 0, y: -8091, outcome: 'accepted' },
      { x: 0, y: -8091.5, outcome: 'model' },
      { x: 0, y: 8292, outcome: 'accepted' },
      { x: 0, y: 8292.5, outcome: 'model' },
    ] as const)('gives a path point at ($x, $y) the outcome $outcome', ({ x, y, outcome }) => {
      expect(outcomeOf(withStart(x, y, artboard))).toBe(outcome);
    });

    it.each([
      { width: 10, height: 10, outcome: 'accepted' },
      { width: 10.5, height: 10, outcome: 'model' },
      { width: 10, height: 10.5, outcome: 'model' },
    ] as const)('gives a raster at (8232, 8282) of $width × $height points the outcome $outcome', ({ width, height, outcome }) => {
      expect(outcomeOf(withItems([placed(width, height)], artboard))).toBe(outcome);
    });
  });

  describe('spot colours', () => {
    it.each([
      { case: 'an empty name', color: { name: '', alternate: [0, 0, 0, 0] }, outcome: 'model' },
      { case: 'a name with a line feed', color: { name: 'Var\nnish', alternate: [0, 0, 0, 0] }, outcome: 'model' },
      { case: 'empty name bytes', color: { name: 'Varnish', nameBytes: new Uint8Array(0), alternate: [0, 0, 0, 0] }, outcome: 'model' },
      { case: '127 name bytes', color: { name: 'Varnish', nameBytes: new Uint8Array(127).fill(65), alternate: [0, 0, 0, 0] }, outcome: 'accepted' },
      { case: 'an alternate component of 1', color: { name: 'Varnish', alternate: [0, 0, 0, 1] }, outcome: 'accepted' },
      { case: 'an alternate component below 0', color: { name: 'Varnish', alternate: [-0.1, 0, 0, 0] }, outcome: 'model' },
      { case: 'a NaN alternate component', color: { name: 'Varnish', alternate: [0, Number.NaN, 0, 0] }, outcome: 'model' },
    ] as const)('gives a spot with $case the outcome $outcome', ({ color, outcome }) => {
      expect(outcomeOf(withItems([spotPath(color)]))).toBe(outcome);
    });

    it.each([
      { tint: 0, outcome: 'accepted' },
      { tint: 1, outcome: 'accepted' },
      { tint: -0.1, outcome: 'model' },
      { tint: Number.NaN, outcome: 'model' },
    ] as const)('gives a spot tint of $tint the outcome $outcome', ({ tint, outcome }) => {
      expect(outcomeOf(withItems([spotPath(spot, tint)]))).toBe(outcome);
    });

    it('accepts one spot written as two separate but equal objects', () => {
      expect(outcomeOf(withItems([path, spotPath({ name: 'White', alternate: [0, 0, 0, 0] })]))).toBe('accepted');
    });
  });

  describe('paint and stroke', () => {
    const stroked = (width: number): PathItem => ({ ...path, stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width } });
    it.each([
      { case: 'an unknown paint kind', candidate: withUntypedItems([{ ...path, fill: { paint: { kind: 'rgb' } } }]), outcome: 'unsupported' },
      {
        case: 'an unknown process paint field',
        candidate: withUntypedItems([{ ...path, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1], profile: 'FOGRA39' } } }]),
        outcome: 'unsupported',
      },
      { case: 'a stroke width of -1', candidate: withItems([stroked(-1)]), outcome: 'model' },
      { case: 'a stroke width of 0', candidate: withItems([stroked(0)]), outcome: 'accepted' },
      { case: 'a stroke width of 14400', candidate: withItems([stroked(14_400)]), outcome: 'accepted' },
      { case: 'a stroke width of 14400.001', candidate: withItems([stroked(14_400.001)]), outcome: 'model' },
    ] as const)('gives $case the outcome $outcome', ({ candidate, outcome }) => {
      expect(outcomeOf(candidate)).toBe(outcome);
    });
  });

  describe('rasters', () => {
    const sized = (width: number, height: number): RasterItem => {
      const pixels = Math.max(0, Math.round(width * height));
      return { ...raster, width, height, color: { space: 'cmyk', samples: new Uint8Array(pixels * 4) }, alpha: new Uint8Array(pixels) };
    };
    const varnish: SpotColor = { name: 'Varnish', alternate: [0, 0, 0, 0.2] };
    it.each([
      { case: 'zero pixels wide', candidate: withItems([sized(0, 1)]), outcome: 'model' },
      // −1 × −1 and 1.5 × 2 multiply to whole pixel counts, so only the dimension check rejects them.
      { case: 'minus one pixel each way', candidate: withItems([sized(-1, -1)]), outcome: 'model' },
      { case: '1.5 pixels wide', candidate: withItems([sized(1.5, 2)]), outcome: 'model' },
      { case: 'one CMYK sample byte short', candidate: withItems([{ ...raster, color: { space: 'cmyk', samples: new Uint8Array(7) } }]), outcome: 'model' },
      { case: 'one CMYK sample byte over', candidate: withItems([{ ...raster, color: { space: 'cmyk', samples: new Uint8Array(9) } }]), outcome: 'model' },
      {
        case: 'spot samples for each pixel',
        candidate: withItems([{ ...raster, color: { space: 'spot', spot: varnish, samples: new Uint8Array(2) } }]),
        outcome: 'accepted',
      },
      { case: 'no spot samples', candidate: withItems([{ ...raster, color: { space: 'spot', spot: varnish } }]), outcome: 'accepted' },
      {
        case: 'one spot sample short',
        candidate: withItems([{ ...raster, color: { space: 'spot', spot: varnish, samples: new Uint8Array(1) } }]),
        outcome: 'model',
      },
      {
        case: 'an RGB colour space',
        candidate: withUntypedItems([{ ...raster, color: { space: 'rgb', samples: new Uint8Array(6) } }]),
        outcome: 'unsupported',
      },
      { case: 'a string lock', candidate: withUntypedItems([{ ...raster, locked: 'yes' }]), outcome: 'model' },
      // One pixel across 1e-10 points is the smallest scale the native number format keeps with its ten fractional digits; 4e-11 rounds to zero.
      { case: 'a scale of 1e-10', candidate: withItems([{ ...sized(1, 1), bounds: { x: 0, y: 0, width: 1e-10, height: 1 } }]), outcome: 'accepted' },
      { case: 'a scale of 4e-11', candidate: withItems([{ ...sized(1, 1), bounds: { x: 0, y: 0, width: 4e-11, height: 1 } }]), outcome: 'model' },
    ] as const)('gives a raster with $case the outcome $outcome', ({ candidate, outcome }) => {
      expect(outcomeOf(candidate)).toBe(outcome);
    });
  });

  describe('groups and items', () => {
    it.each([
      { case: 'an empty group', candidate: withItems([{ kind: 'group', items: [] }]), outcome: 'model' },
      { case: 'an empty clip group', candidate: withItems([{ kind: 'clipGroup', clip: path.geometry, items: [] }]), outcome: 'model' },
      { case: 'a group opacity of 1', candidate: withItems([{ kind: 'group', opacity: 1, items: [path] }]), outcome: 'accepted' },
      { case: 'a group opacity of 1.1', candidate: withItems([{ kind: 'group', opacity: 1.1, items: [path] }]), outcome: 'model' },
      { case: 'a text item', candidate: withUntypedItems([{ kind: 'text', text: 'Hello' }]), outcome: 'unsupported' },
    ] as const)('gives $case the outcome $outcome', ({ candidate, outcome }) => {
      expect(outcomeOf(candidate)).toBe(outcome);
    });
  });

  describe('layers', () => {
    const coloured = (color: unknown): IllustratorDocument => corrupt(document, 'layers', [{ name: 'A', color, items: [path] }]);
    it.each([
      { case: 'the colour [255, 0, 0]', candidate: coloured([255, 0, 0]), outcome: 'accepted' },
      { case: 'the colour [256, 0, 0]', candidate: coloured([256, 0, 0]), outcome: 'model' },
      { case: 'the colour [0, 1.5, 0]', candidate: coloured([0, 1.5, 0]), outcome: 'model' },
      { case: 'the colour [0, 0, -1]', candidate: coloured([0, 0, -1]), outcome: 'model' },
      { case: 'an empty name', candidate: { ...document, layers: [{ name: '', items: [path] }] }, outcome: 'model' },
    ] as const)('gives a layer with $case the outcome $outcome', ({ candidate, outcome }) => {
      expect(outcomeOf(candidate)).toBe(outcome);
    });
  });
});

import type {
  Anchor,
  Fill,
  FillRule,
  IllustratorDocument,
  Item,
  Paint,
  PathGeometry,
  PathItem,
  RasterItem,
  Segment,
  SpotColor,
  Stroke,
  Subpath,
} from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateDocument } from '../model/validateDocument.ts';
import { writeNative } from '../native/writeNative.ts';
import { numberDeviation } from '../testing/modelNumbers.ts';
import { normalizeModel } from '../testing/normalizeModel.ts';

import { readNative } from './readNative.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const outline: Subpath = {
  start: [mm(5), mm(5)],
  segments: [
    { kind: 'line', to: [mm(35), mm(5)] },
    { kind: 'line', to: [mm(35), mm(25)] },
    { kind: 'line', to: [mm(5), mm(25)] },
  ],
};
const cut: Stroke = { paint: { kind: 'spot', spot: { name: 'ＣＵＴ', alternate: [0, 1, 0, 0] } }, width: 0 };
const die: PathItem = { kind: 'path', geometry: { subpaths: [outline] }, stroke: cut };
const moves = (native: Uint8Array): Array<string> => [...new TextDecoder().decode(native).matchAll(/(?<=\r)\S+ \S+(?= m\r)/gu)].map(match => match[0]);
const model: IllustratorDocument = {
  artboard: { width: mm(100), height: mm(70), bleed: mm(3) },
  layers: [
    { name: '非表示', visible: false, items: [die] },
    {
      name: 'Die (outer)',
      items: [
        { kind: 'clipGroup', clip: die.geometry, items: [{ kind: 'group', opacity: 0.3, isolated: true, items: [die] }] },
        {
          kind: 'raster',
          width: 2,
          height: 1,
          bounds: { x: mm(10), y: mm(20), width: mm(30), height: mm(10) },
          color: { space: 'cmyk', samples: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]) },
          alpha: new Uint8Array([255, 0]),
        },
      ],
    },
  ],
  lastModified: date,
};

describe('native layer round trips', () => {
  it('writes the same native bytes after reading its own output', () => {
    const first = writeNative(model);
    const read = readNative(first.bytes, date);
    const second = writeNative(read.document);
    expect(second.bytes).toStrictEqual(first.bytes);
  });

  it('reads the model after native-number rounding and default materialization', () => {
    const read = readNative(writeNative(model).bytes, date).document;
    expect(read).toStrictEqual(normalizeModel(model));
  });

  // Each model differs from `model` in one field that every other round trip leaves at its default or symmetric value.
  const fill: PathItem = { kind: 'path', geometry: { subpaths: [outline] }, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } };
  const variants = [
    { name: 'a bleed that differs on every side', variant: { ...model, artboard: { ...model.artboard, bleed: { top: 1, right: 2, bottom: 3, left: 4 } } } },
    {
      name: 'overprinting fills and strokes',
      variant: {
        ...model,
        layers: [
          {
            name: 'Overprint',
            items: [
              { ...fill, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, overprint: true } },
              { ...die, stroke: { ...cut, overprint: true } },
              { ...fill, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, overprint: true }, stroke: cut },
            ],
          },
        ],
      },
    },
    { name: 'a custom layer colour', variant: { ...model, layers: [{ name: 'Coloured', color: [1, 2, 3], items: [die] }] } },
    {
      name: 'a smooth line anchor',
      variant: {
        ...model,
        layers: [
          {
            name: 'Smooth',
            items: [
              {
                ...fill,
                geometry: {
                  subpaths: [
                    {
                      start: [10, 10],
                      segments: [
                        { kind: 'line', to: [20, 10], anchor: 'smooth' },
                        { kind: 'line', to: [20, 20] },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  ] as const satisfies Array<{ name: string; variant: IllustratorDocument }>;

  it.each(variants)('round trips $name', ({ variant }) => {
    const first = writeNative(variant);
    const read = readNative(first.bytes, date).document;
    expect(read).toStrictEqual(normalizeModel(variant));
    expect(writeNative(read).bytes).toStrictEqual(first.bytes);
  });

  it('round trips layer and item locks', () => {
    const locked: IllustratorDocument = {
      ...model,
      layers: [
        { name: 'Locked hidden', visible: false, locked: true, items: [die] },
        { name: 'Objects', items: [{ ...die, locked: true }, die] },
      ],
    };
    const read = readNative(writeNative(locked).bytes, date).document;
    expect(read).toStrictEqual(normalizeModel(locked));
    expect(read.layers[0]).toMatchObject({ locked: true });
    expect(read.layers[1]?.items.map(item => item.locked)).toStrictEqual([true, false]);
  });

  it('round trips raster, group, and clip group locks', () => {
    const locked: IllustratorDocument = {
      ...model,
      layers: [
        {
          name: 'Objects',
          items: [
            { kind: 'clipGroup', locked: true, clip: die.geometry, items: [{ kind: 'group', locked: true, items: [die] }] },
            {
              kind: 'raster',
              locked: true,
              width: 1,
              height: 1,
              bounds: { x: 1, y: 2, width: 3, height: 4 },
              color: { space: 'cmyk', samples: Uint8Array.of(1, 2, 3, 4) },
              alpha: Uint8Array.of(255),
            },
          ],
        },
      ],
    };
    expect(readNative(writeNative(locked).bytes, date).document).toStrictEqual(normalizeModel(locked));
  });

  it('round trips compound paths and compound clips under both fill rules', () => {
    const hole: Subpath = {
      start: [mm(15), mm(10)],
      segments: [
        { kind: 'quadratic', control: [mm(20), mm(20)], to: [mm(25), mm(10)], anchor: 'smooth' },
        { kind: 'line', to: [mm(15), mm(10)] },
      ],
    };
    const piece: Subpath = {
      start: [mm(40), mm(5)],
      segments: [
        { kind: 'line', to: [mm(60), mm(5)] },
        { kind: 'line', to: [mm(50), mm(25)] },
      ],
    };
    const evenOdd: PathGeometry = { subpaths: [outline, hole, piece], fillRule: 'evenodd' };
    const nonzero: PathGeometry = { subpaths: [outline, hole] };
    const compound: IllustratorDocument = {
      ...model,
      layers: [
        {
          name: 'Compound',
          items: [
            { ...die, geometry: nonzero },
            { kind: 'path', locked: true, geometry: evenOdd, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } }, stroke: cut },
            { kind: 'clipGroup', clip: evenOdd, items: [{ kind: 'clipGroup', clip: nonzero, items: [{ ...die, geometry: evenOdd }] }] },
            { kind: 'clipGroup', clip: { subpaths: [hole], fillRule: 'evenodd' }, items: [die] },
          ],
        },
      ],
    };
    const first = writeNative(compound);
    const read = readNative(first.bytes, date).document;
    expect(read).toStrictEqual(normalizeModel(compound));
    expect(writeNative(read).bytes).toStrictEqual(first.bytes);
  });

  it('offsets every subpath of a compound path by the native origin', () => {
    const inner: Subpath = {
      start: [10, 20],
      segments: [
        { kind: 'line', to: [30, 20] },
        { kind: 'line', to: [20, 40] },
      ],
    };
    const compound: IllustratorDocument = { ...model, layers: [{ name: 'Die', items: [{ ...die, geometry: { subpaths: [outline, inner] } }] }] };
    // The artboard is 70 mm, 198.4251968504 pt, tall.
    expect(moves(writeNative(compound).bytes)).toStrictEqual(['14.1732283465 14.1732283465', '10 20']);
    expect(moves(writeNative(compound, { nativeOrigin: 'artboard-top-left' }).bytes)).toStrictEqual(['14.1732283465 -184.2519685039', '10 -178.4251968504']);
  });
});

describe('native origin on read', () => {
  const hole: Subpath = {
    start: [mm(15), mm(10)],
    segments: [
      { kind: 'curve', control1: [mm(18), mm(18)], control2: [mm(22), mm(18)], to: [mm(25), mm(10)] },
      { kind: 'line', to: [mm(15), mm(10)] },
    ],
  };
  const compound: IllustratorDocument = {
    ...model,
    layers: [
      ...model.layers,
      {
        name: 'Compound',
        items: [
          { ...die, geometry: { subpaths: [outline, hole], fillRule: 'evenodd' } },
          { kind: 'clipGroup', clip: { subpaths: [outline, hole] }, items: [die] },
        ],
      },
    ],
  };

  it('reads artboard-bottom-left native coordinates back exactly', () => {
    const first = writeNative(compound, { nativeOrigin: 'artboard-bottom-left' });
    const read = readNative(first.bytes, date);
    expect(read.nativeOrigin).toBe('artboard-bottom-left');
    expect(read.document).toStrictEqual(normalizeModel(compound));
    expect(writeNative(read.document).bytes).toStrictEqual(first.bytes);
  });

  it('reads artboard-top-left native coordinates back as model coordinates within one tenth-decimal unit', () => {
    const first = writeNative(compound, { nativeOrigin: 'artboard-top-left' });
    const read = readNative(first.bytes, date);
    expect(read.nativeOrigin).toBe('artboard-top-left');
    // The native copy keeps y minus the artboard height and the header keeps the height, each rounded to ten decimals, so adding them back can land one unit off.
    expect(numberDeviation(read.document, normalizeModel(compound))).toBeLessThan(1.5e-10);
    expect(read.document.layers[2]?.items[0]).toMatchObject({ geometry: { subpaths: [{ start: [14.1732283465, 14.1732283465] }, {}], fillRule: 'evenodd' } });
    expect(writeNative(read.document, { nativeOrigin: 'artboard-top-left' }).bytes).toStrictEqual(first.bytes);
  });
});

interface NumberDomain {
  readonly real: (min: number, max: number) => fc.Arbitrary<number>;
  readonly quadratics: boolean;
}

// Adding 0 turns a generated -0 into 0, which the native copy cannot tell apart.
const anyNumbers: NumberDomain = { real: (min, max) => fc.double({ min, max, noNaN: true }).map(value => value + 0), quadratics: true };
// Multiples of 1/1024 have at most ten decimals, so the native copy stores them exactly and nothing rounds on the way; a quadratic is left out because raising it to a cubic puts its controls at thirds.
const nativeNumbers: NumberDomain = { real: (min, max) => fc.integer({ min: min * 1024, max: max * 1024 }).map(value => value / 1024), quadratics: false };

const lockField = fc.option(fc.boolean(), { nil: undefined }).map(locked => (locked === undefined ? {} : { locked }));
const anchorField = fc.option(fc.constantFrom<Anchor>('corner', 'smooth'), { nil: undefined }).map(anchor => (anchor === undefined ? {} : { anchor }));
const overprintField = fc.option(fc.boolean(), { nil: undefined }).map(overprint => (overprint === undefined ? {} : { overprint }));
// One alternate per spot name, because the model refuses one name with two alternates.
const spotArbitrary = fc.constantFrom<SpotColor>({ name: 'Cut', alternate: [0, 1, 0, 0] }, { name: 'White', alternate: [0.2, 0, 0, 0] });

// Models over the supported grammar: paths of lines, curves and quadratics, compound paths under both fill rules, clip groups, groups, CMYK and spot rasters, locks, overprint, bleeds and layer colours.
const modelsFrom = ({ real, quadratics }: NumberDomain): fc.Arbitrary<IllustratorDocument> => {
  const unit = real(0, 1);
  const coordinate = real(0, 100);
  const point = fc.tuple(coordinate, coordinate);
  const line = fc.tuple(point, anchorField).map(([to, anchor]): Segment => ({ kind: 'line', to, ...anchor }));
  const curve = fc
    .tuple(point, point, point, anchorField)
    .map(([control1, control2, to, anchor]): Segment => ({ kind: 'curve', control1, control2, to, ...anchor }));
  const quadratic = fc.tuple(point, point, anchorField).map(([control, to, anchor]): Segment => ({ kind: 'quadratic', control, to, ...anchor }));
  const segment = quadratics ? fc.oneof(line, curve, quadratic) : fc.oneof(line, curve);
  const subpathArbitrary = fc.record({ start: point, segments: fc.array(segment, { minLength: 1, maxLength: 4 }) });
  const geometryArbitrary = fc
    .tuple(fc.array(subpathArbitrary, { minLength: 1, maxLength: 3 }), fc.option(fc.constantFrom<FillRule>('nonzero', 'evenodd'), { nil: undefined }))
    .map(([subpaths, fillRule]): PathGeometry => (fillRule === undefined ? { subpaths } : { subpaths, fillRule }));
  const paintArbitrary: fc.Arbitrary<Paint> = fc.oneof(
    fc.tuple(unit, unit, unit, unit).map((cmyk): Paint => ({ kind: 'process', cmyk })),
    fc
      .tuple(spotArbitrary, fc.option(unit, { nil: undefined }))
      .map(([spot, tint]): Paint => (tint === undefined ? { kind: 'spot', spot } : { kind: 'spot', spot, tint })),
  );
  const fillArbitrary = fc.tuple(paintArbitrary, overprintField).map(([paint, overprint]): Fill => ({ paint, ...overprint }));
  const strokeArbitrary = fc.tuple(paintArbitrary, real(0, 10), overprintField).map(([paint, width, overprint]): Stroke => ({ paint, width, ...overprint }));
  const pathArbitrary = fc
    .tuple(geometryArbitrary, fillArbitrary, fc.option(strokeArbitrary, { nil: undefined }), fc.boolean(), lockField)
    .map(([geometry, fill, stroke, filled, locked]): PathItem => {
      if (stroke === undefined) {
        return { kind: 'path', geometry, fill, ...locked };
      }
      return filled ? { kind: 'path', geometry, fill, stroke, ...locked } : { kind: 'path', geometry, stroke, ...locked };
    });
  const rasterArbitrary = fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 })).chain(([width, height]) =>
    fc
      .tuple(
        // The native copy stores the per-pixel scale, so the placement is drawn as a scale for every pixel count.
        fc.record({ x: coordinate, y: coordinate, scaleX: real(0.25, 16), scaleY: real(0.25, 16) }),
        fc.oneof(
          fc.uint8Array({ minLength: width * height * 4, maxLength: width * height * 4 }).map((samples): RasterItem['color'] => ({ space: 'cmyk', samples })),
          fc
            .tuple(spotArbitrary, fc.option(fc.uint8Array({ minLength: width * height, maxLength: width * height }), { nil: undefined }))
            .map(([spot, samples]): RasterItem['color'] => (samples === undefined ? { space: 'spot', spot } : { space: 'spot', spot, samples })),
        ),
        fc.uint8Array({ minLength: width * height, maxLength: width * height }),
        lockField,
      )
      .map(([{ x, y, scaleX, scaleY }, color, alpha, locked]): RasterItem => ({
        kind: 'raster',
        width,
        height,
        bounds: { x, y, width: scaleX * width, height: scaleY * height },
        color,
        alpha,
        ...locked,
      })),
  );
  const itemArbitrary = (depth: number): fc.Arbitrary<Item> => {
    if (depth === 0) {
      return fc.oneof(pathArbitrary, rasterArbitrary);
    }
    const children = fc.array(itemArbitrary(depth - 1), { minLength: 1, maxLength: 2 });
    return fc.oneof(
      pathArbitrary,
      rasterArbitrary,
      fc
        .record({ items: children, opacity: unit, isolated: fc.boolean(), locked: fc.boolean() }, { requiredKeys: ['items'] })
        .map((fields): Item => ({ kind: 'group', ...fields })),
      fc.tuple(geometryArbitrary, children, lockField).map(([clip, items, locked]): Item => ({ kind: 'clipGroup', clip, items, ...locked })),
    );
  };
  const layerArbitrary = fc.record(
    {
      visible: fc.boolean(),
      locked: fc.boolean(),
      opacity: unit,
      color: fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      items: fc.array(itemArbitrary(2), { maxLength: 3 }),
    },
    { requiredKeys: ['items'] },
  );
  const artboardArbitrary = fc.record(
    {
      width: real(100, 1000),
      height: real(100, 1000),
      bleed: fc.oneof(real(0, 20), fc.record({ top: real(0, 20), right: real(0, 20), bottom: real(0, 20), left: real(0, 20) })),
      name: fc.constantFrom('Board', 'Sheet (front)'),
    },
    { requiredKeys: ['width', 'height'] },
  );
  return fc.record(
    {
      artboard: artboardArbitrary,
      layers: fc
        .array(layerArbitrary, { minLength: 1, maxLength: 3 })
        .map(layers => layers.map((layer, index) => ({ ...layer, name: `Layer ${String(index)}` }))),
      lastModified: fc.constant(date),
      title: fc.constantFrom('Die sheet', 'Proof (2)'),
    },
    { requiredKeys: ['artboard', 'layers', 'lastModified'] },
  );
};

describe('properties', () => {
  it('reads every generated model back as its normalized form, which the model accepts', () => {
    fc.assert(
      fc.property(modelsFrom(anyNumbers), generated => {
        const read = readNative(writeNative(generated).bytes, date).document;
        expect(read).toStrictEqual(normalizeModel(generated));
        expect(() => {
          validateDocument(read);
        }).not.toThrow();
      }),
    );
  });

  it.each(['artboard-bottom-left', 'artboard-top-left'] as const)(
    'rewrites the same %s native bytes from a model at native precision it reads',
    nativeOrigin => {
      fc.assert(
        fc.property(modelsFrom(nativeNumbers), generated => {
          const first = writeNative(generated, { nativeOrigin });
          const read = readNative(first.bytes, date);
          expect(read.nativeOrigin).toBe(nativeOrigin);
          expect(writeNative(read.document, { nativeOrigin }).bytes).toStrictEqual(first.bytes);
        }),
      );
    },
  );
});

import type { IllustratorDocument, PathGeometry, PathItem, Stroke, Subpath } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

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
const moves = (native: Uint8Array): string[] => [...new TextDecoder().decode(native).matchAll(/(?<=\r)\S+ \S+(?= m\r)/gu)].map(match => match[0]);
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

  it('retains nested objects, alpha bytes and Unicode names', () => {
    const read = readNative(writeNative(model).bytes, date).document;
    expect(read.layers.map(layer => layer.name)).toStrictEqual(['非表示', 'Die (outer)']);
    expect(read.layers[1]?.items[0]).toMatchObject({ kind: 'clipGroup', items: [{ kind: 'group', opacity: 0.3, isolated: true }] });
    expect(read.layers[1]?.items[1]).toMatchObject({ kind: 'raster', alpha: new Uint8Array([255, 0]) });
  });

  it('reads the model after native-number rounding and default materialization', () => {
    const read = readNative(writeNative(model).bytes, date).document;
    expect(read).toStrictEqual(normalizeModel(model));
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

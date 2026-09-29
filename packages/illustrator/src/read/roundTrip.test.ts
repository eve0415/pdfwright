import type { IllustratorDocument, PathItem } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';
import { normalizeModel } from '../testing/normalizeModel.ts';

import { readNative } from './readNative.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const die: PathItem = {
  kind: 'path',
  geometry: {
    start: [mm(5), mm(5)],
    segments: [
      { kind: 'line', to: [mm(35), mm(5)] },
      { kind: 'line', to: [mm(35), mm(25)] },
      { kind: 'line', to: [mm(5), mm(25)] },
    ],
  },
  stroke: { paint: { kind: 'spot', spot: { name: 'ＣＵＴ', alternate: [0, 1, 0, 0] } }, width: 0 },
};
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
});

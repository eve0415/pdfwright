import type { IllustratorDocument } from '../model/illustratorDocument.ts';

import { pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';

import { readNative } from './readNative.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const geometry = {
  start: [0, 0],
  segments: [
    { kind: 'line', to: [10, 0] },
    { kind: 'line', to: [10, 10] },
    { kind: 'line', to: [0, 10] },
  ],
} as const;
const document: IllustratorDocument = {
  artboard: { width: 100, height: 70, bleed: 3, name: 'Board' },
  layers: [
    { name: 'Hidden', visible: false, items: [] },
    {
      name: 'Design',
      opacity: 0.3,
      items: [
        { kind: 'path', geometry, fill: { paint: { kind: 'spot', spot: { name: 'White', alternate: [0.2, 0, 0, 0] }, tint: 0.5 } } },
        {
          kind: 'clipGroup',
          clip: geometry,
          items: [
            {
              kind: 'raster',
              width: 1,
              height: 1,
              bounds: { x: 1, y: 2, width: 3, height: 4 },
              color: { space: 'cmyk', samples: new Uint8Array([1, 2, 3, 4]) },
              alpha: new Uint8Array([128]),
            },
          ],
        },
      ],
    },
  ],
  lastModified: date,
  title: 'Round trip',
};

describe('native model reader', () => {
  it('recovers artboard and layer settings from a synthesized native stream', () => {
    const read = readNative(writeNative(document).bytes, date);
    expect(read.document.artboard).toMatchObject({ width: 100, height: 70, name: 'Board' });
    expect(read.document.layers.map(layer => [layer.name, layer.visible, layer.opacity])).toStrictEqual([
      ['Hidden', false, 1],
      ['Design', true, 0.3],
    ]);
    expect(read.document.title).toBe('Round trip');
    expect(read.header.get('%AI5_FileFormat')).toBe('14.0');
  });

  it('recovers one spot path, a clip path and its binary raster', () => {
    const read = readNative(writeNative(document).bytes, date);
    const items = read.document.layers[1]?.items;
    expect(items?.[0]).toMatchObject({ kind: 'path', fill: { paint: { kind: 'spot', spot: { name: 'White' }, tint: 0.5 } } });
    expect(items?.[1]).toMatchObject({ kind: 'clipGroup', items: [{ kind: 'raster', width: 1, height: 1, alpha: new Uint8Array([128]) }] });
  });
});

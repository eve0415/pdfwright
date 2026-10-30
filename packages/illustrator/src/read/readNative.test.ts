import type { IllustratorDocument, Item } from '../model/illustratorDocument.ts';

import { ResourceLimitError, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';

import { readNative } from './readNative.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const geometry = {
  subpaths: [
    {
      start: [0, 0],
      segments: [
        { kind: 'line', to: [10, 0] },
        { kind: 'line', to: [10, 10] },
        { kind: 'line', to: [0, 10] },
      ],
    },
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

  it('recognises a clipping path of any length after the clipped items', () => {
    const count = 30_000;
    const segments = Array.from({ length: count }, (_, index) => {
      const angle = (2 * Math.PI * (index + 1)) / count;
      return { kind: 'line', to: [50 + 40 * Math.cos(angle), 35 + 30 * Math.sin(angle)] } as const;
    });
    const clipped: IllustratorDocument = {
      artboard: { width: 100, height: 70 },
      layers: [
        {
          name: 'Clipped',
          items: [
            {
              kind: 'clipGroup',
              clip: { subpaths: [{ start: [90, 35], segments }] },
              items: [{ kind: 'path', geometry, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } }],
            },
          ],
        },
      ],
      lastModified: date,
    };
    const item = readNative(writeNative(clipped).bytes, date).document.layers[0]?.items[0];
    expect(item).toMatchObject({ kind: 'clipGroup', items: [{ kind: 'path' }] });
    expect(item).toHaveProperty('clip.subpaths.0.segments.length', count);
  });

  it('reads groups and clipping groups nested as deep as the writer allows', () => {
    let item: Item = { kind: 'path', geometry, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } };
    for (let level = 0; level < 128; level += 2) item = { kind: 'group', items: [{ kind: 'clipGroup', clip: geometry, items: [item] }] };
    const nested: IllustratorDocument = { artboard: { width: 100, height: 70 }, layers: [{ name: 'Nested', items: [item] }], lastModified: date };
    const read = readNative(writeNative(nested).bytes, date).document.layers[0]?.items[0];
    expect(read).toHaveProperty(`${'items.0.'.repeat(127)}kind`, 'clipGroup');
    expect(read).toHaveProperty(`${'items.0.'.repeat(128)}kind`, 'path');
  });

  it.each([129, 200_000])('rejects groups nested %i deep with ResourceLimitError', depth => {
    const empty: IllustratorDocument = { artboard: { width: 100, height: 70 }, layers: [{ name: 'Nested', items: [] }], lastModified: date };
    const text = new TextDecoder().decode(writeNative(empty).bytes);
    expect(text).toContain('0 Xw\rLB\r');
    const nested = text.replace('0 Xw\rLB\r', `0 Xw\r${'0 Ae\ru\r'.repeat(depth)}${'U\r'.repeat(depth)}LB\r`);
    expect(() => readNative(new TextEncoder().encode(nested), date)).toThrow(ResourceLimitError);
  });
});

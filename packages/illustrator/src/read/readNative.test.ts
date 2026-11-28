import type { IllustratorDocument, Item } from '../model/illustratorDocument.ts';

import { ParseError, ResourceLimitError, UnsupportedFeatureError, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';
import { normalizeModel } from '../testing/normalizeModel.ts';

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
const [square] = geometry.subpaths;
const white = { name: 'White', alternate: [0.2, 0, 0, 0] } as const;
const document: IllustratorDocument = {
  artboard: { width: 100, height: 70, bleed: 3, name: 'Board' },
  layers: [
    { name: 'Hidden', visible: false, items: [] },
    {
      name: 'Design',
      opacity: 0.3,
      items: [
        { kind: 'path', geometry, fill: { paint: { kind: 'spot', spot: white, tint: 0.25 } } },
        { kind: 'path', geometry: { subpaths: [square, square] }, stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 2 } },
        {
          kind: 'raster',
          width: 1,
          height: 1,
          bounds: { x: 5, y: 6, width: 7, height: 8 },
          color: { space: 'spot', spot: white },
          alpha: new Uint8Array([64]),
        },
        { kind: 'group', opacity: 0.5, items: [{ kind: 'path', geometry, fill: { paint: { kind: 'process', cmyk: [0, 0.5, 0, 0] } } }] },
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
const encoder = new TextEncoder();
const nativeBytes = writeNative(document).bytes;

const matchesAt = (bytes: Uint8Array, pattern: Uint8Array, start: number): boolean => pattern.every((byte, index) => bytes[start + index] === byte);

// The byte offset of the first occurrence of `needle`, searched in bytes because the raster planes are not UTF-8.
const offsetOf = (bytes: Uint8Array, needle: string): number => {
  const pattern = encoder.encode(needle);
  for (let start = 0; start + pattern.length <= bytes.length; start++) {
    if (matchesAt(bytes, pattern, start)) {
      return start;
    }
  }
  return -1;
};

// Replaces the first occurrence of a needle, failing when it is absent so that a fixture cannot silently stay valid.
const edited = (bytes: Uint8Array, needle: string, replacement: string): Uint8Array => {
  const index = offsetOf(bytes, needle);
  if (index === -1) {
    throw new Error(`fixture bytes are missing ${JSON.stringify(needle)}`);
  }
  const inserted = encoder.encode(replacement);
  const output = new Uint8Array(bytes.length - encoder.encode(needle).length + inserted.length);
  output.set(bytes.subarray(0, index));
  output.set(inserted, index);
  output.set(bytes.subarray(index + encoder.encode(needle).length), index + inserted.length);
  return output;
};

const thrown = (action: () => void): Error | undefined => {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  return undefined;
};

describe('native model reader', () => {
  it('recovers the artboard, layers, items and title from a synthesized native stream', () => {
    const read = readNative(writeNative(document).bytes, date);
    expect(read.document).toStrictEqual(normalizeModel(document));
    expect(read.header.get('%AI5_FileFormat')).toBe('14.0');
    expect(read.unknownBlocks).toStrictEqual([]);
  });

  it('reads no artboard name when the native data marks it as the default name', () => {
    const native = edited(nativeBytes, '%_0 /Bool (IsArtboardDefaultName) ,', '%_1 /Bool (IsArtboardDefaultName) ,');
    expect(readNative(native, date).document.artboard).toStrictEqual({ width: 100, height: 70, bleed: { top: 3, right: 3, bottom: 3, left: 3 } });
  });

  it('reports only the setup blocks it does not know', () => {
    const native = edited(
      edited(nativeBytes, '%%BeginSetup\r', '%%BeginSetup\r%AI9_BeginFoo\r%AI9_EndFoo\r'),
      '%%EndSetup\r',
      '%%EndSetup\r%AI9_BeginOutside\r%AI9_EndOutside\r',
    );
    expect(readNative(native, date).unknownBlocks).toStrictEqual(['%AI9_BeginFoo']);
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
    for (let level = 0; level < 128; level += 2) {
      item = { kind: 'group', items: [{ kind: 'clipGroup', clip: geometry, items: [item] }] };
    }
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

// Each row edits the native copy of `document`, which the first test reads back whole, in one place; `at` is the text whose offset the error names.
const designLb = '1 1 1 1 0 0 1 1 255 79 79 0 50 0 Lb';
const unsupportedRows = [
  { name: 'cropmarks whose left edge is not 0', needle: '%AI3_Cropmarks: 0 0 100 70', replacement: '%AI3_Cropmarks: 1 0 100 70', at: '%AI3_Cropmarks' },
  { name: 'cropmarks with five values', needle: '%AI3_Cropmarks: 0 0 100 70', replacement: '%AI3_Cropmarks: 0 0 100 70 5', at: '%AI3_Cropmarks' },
  { name: 'cropmarks whose right edge is 0', needle: '%AI3_Cropmarks: 0 0 100 70', replacement: '%AI3_Cropmarks: 0 0 0 70', at: '%AI3_Cropmarks' },
  { name: 'cropmarks whose bottom and top are both 0', needle: '%AI3_Cropmarks: 0 0 100 70', replacement: '%AI3_Cropmarks: 0 0 100 0', at: '%AI3_Cropmarks' },
  { name: 'top-left cropmarks whose top is not 0', needle: '%AI3_Cropmarks: 0 0 100 70', replacement: '%AI3_Cropmarks: 0 -70 100 5', at: '%AI3_Cropmarks' },
  { name: 'a layer state whose second field is not 1', needle: designLb, replacement: '1 0 1 1 0 0 1 1 255 79 79 0 50 0 Lb', at: '1 0 1 1 0 0 1 1' },
  { name: 'a layer state whose fourth field is not 1', needle: designLb, replacement: '1 1 1 0 0 0 1 1 255 79 79 0 50 0 Lb', at: '1 1 1 0 0 0 1 1' },
  { name: 'a layer state whose thirteenth field is not 50', needle: designLb, replacement: '1 1 1 1 0 0 1 1 255 79 79 0 49 0 Lb', at: '1 1 1 1 0 0 1 1' },
  { name: 'a layer state with a sixteenth field', needle: designLb, replacement: `${designLb} 0`, at: '1 1 1 1 0 0 1 1' },
  { name: 'an unknown group opener', needle: '0 Ae\ru\r', replacement: '0 Ae\rv\r', at: 'v\r4 As' },
  { name: 'compound path members that end with different operators', needle: '0 0 L\rs\r*U', replacement: '0 0 L\rb\r*U', at: 'b\r*U' },
  { name: 'a compound path with no members', needle: '0 Ae\r*u\r', replacement: '0 Ae\r*u\r*U\r0 Ae\r*u\r', at: '*U\r0 Ae\r*u' },
  { name: 'a filled path with no fill paint', needle: '0.2 0 0 0 (White) 0.75 x\r', replacement: '', at: 'f\r0 Ae\r*u' },
  { name: 'a spot raster without a spot paint before it', needle: '0 O\r0.2 0 0 0 (White) 0 x\r', replacement: '', at: 'F\r%_/ArtDictionary' },
] as const;

const parseRows = [
  { name: 'a layer without its end marker', needle: '%AI5_EndLayer--\r%%PageTrailer', replacement: '%%PageTrailer', at: `%AI5_BeginLayer\r${designLb}` },
  { name: 'a coordinate that is not a number', needle: '10 0 L', replacement: '1O 0 L', at: '1O 0 L' },
] as const;

describe('native grammar refusals', () => {
  it.each(unsupportedRows)('refuses $name with UnsupportedFeatureError at its line', ({ needle, replacement, at }) => {
    const text = edited(nativeBytes, needle, replacement);
    const error = thrown(() => readNative(text, date));
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error).toHaveProperty('message', expect.stringMatching(new RegExp(String.raw`native byte ${String(offsetOf(text, at))}\b`, 'u')));
  });

  it.each(parseRows)('refuses $name with ParseError at its line', ({ needle, replacement, at }) => {
    const text = edited(nativeBytes, needle, replacement);
    const error = thrown(() => readNative(text, date));
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset: offsetOf(text, at) });
  });

  it('refuses native data without %AI3_Cropmarks', () => {
    const text = edited(nativeBytes, '%AI3_Cropmarks: 0 0 100 70\r', '');
    expect(() => readNative(text, date)).toThrow(UnsupportedFeatureError);
  });

  // The two refusals below share their class and offset with the general unknown-operator and no-paint refusals, so the message is what tells them apart.
  it('refuses a layer inside a layer as a sublayer', () => {
    const text = edited(nativeBytes, '0 Xw\r4 As\r', '0 Xw\r%AI5_BeginLayer\r4 As\r');
    const error = thrown(() => readNative(text, date));
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error).toHaveProperty('message', expect.stringMatching(/sublayer/u));
    expect(error).toHaveProperty(
      'message',
      expect.stringMatching(new RegExp(String.raw`native byte ${String(offsetOf(text, '%AI5_BeginLayer\r4 As'))}\b`, 'u')),
    );
  });

  it('refuses a path operator other than f, s and b by name', () => {
    const text = edited(nativeBytes, 'f\r0 Ae\r*u', 'F\r0 Ae\r*u');
    const error = thrown(() => readNative(text, date));
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error).toHaveProperty('message', expect.stringMatching(/operator F\b/u));
  });

  describe('top-left coordinate range', () => {
    // A top-left copy stores y minus the 70 pt artboard height, so the reader adds 70 back and refuses a sum of 1e15 or more, which native numbers cannot hold.
    const topLeftBytes = writeNative(document, { nativeOrigin: 'artboard-top-left' }).bytes;

    it('refuses a native y that restores to 1e15', () => {
      const text = edited(topLeftBytes, '\r0 -70 m\r', '\r0 999999999999930 m\r');
      const error = thrown(() => readNative(text, date));
      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({ offset: offsetOf(text, '0 999999999999930 m') });
    });

    it('reads a native y that restores to one below 1e15', () => {
      const text = edited(topLeftBytes, '\r0 -70 m\r', '\r0 999999999999929 m\r');
      expect(readNative(text, date).document.layers[1]?.items[0]).toHaveProperty('geometry.subpaths.0.start', [0, 999_999_999_999_999]);
    });
  });
});

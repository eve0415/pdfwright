import type { IllustratorDocument, RasterItem } from '../model/illustratorDocument.ts';

import { pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { findExponentTokens } from '../testing/scanNative.ts';

import { createNativeWriter } from './nativeWriter.ts';
import { writeNative } from './writeNative.ts';
import { writeRaster } from './writeRaster.ts';

describe('native exponent scanner', () => {
  it('finds exponent-form path tokens but skips identical raster bytes and strings', () => {
    const writer = createNativeWriter();
    writer.line('2e-10 0 m');
    writer.line({ utf8: 'literal 3e-9' }, 'Ln');
    const raster: RasterItem = {
      kind: 'raster',
      width: 2,
      height: 1,
      bounds: { x: 0, y: 0, width: 2, height: 1 },
      color: { space: 'cmyk', samples: new Uint8Array([50, 101, 45, 49, 48, 0, 0, 0]) },
      alpha: new Uint8Array([0, 0]),
    };
    writeRaster(writer, raster, { itemPath: '0/0' });
    expect(findExponentTokens(writer.finish())).toStrictEqual(['2e-10']);
  });

  it('finds no exponents or provenance paths in synthesized native data', () => {
    const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
    const model: IllustratorDocument = {
      artboard: { width: 100, height: 70 },
      layers: [
        {
          name: 'Tiny',
          items: [
            {
              kind: 'path',
              geometry: { start: [5e-324, -0], segments: [{ kind: 'line', to: [10, -1e-12] }] },
              fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
            },
          ],
        },
      ],
      lastModified: date,
    };
    const native = writeNative(model).bytes;
    const text = new TextDecoder().decode(native);
    expect(findExponentTokens(native)).toStrictEqual([]);
    expect(text).toContain('0 0 m\r');
    expect(text).not.toContain('c2pa');
    expect(text).not.toContain('/Users/');
    expect(text).toContain('%%For: () ()\r');
  });
});

import type { RasterItem } from '../model/illustratorDocument.ts';
import type { NativeRecord } from './nativeTokenizer.ts';

import { describe, expect, it } from 'vitest';

import { createNativeWriter } from '../native/nativeWriter.ts';
import { writeRaster } from '../native/writeRaster.ts';

import { parseNativeLiteral, tokenizeNative } from './nativeTokenizer.ts';

const lines = (records: readonly NativeRecord[]): string[] => records.flatMap(record => (record.kind === 'line' ? [record.text] : []));

describe('native tokenizer', () => {
  it('keeps binary raster bytes out of CR-delimited text lines', () => {
    const raster: RasterItem = {
      kind: 'raster',
      width: 1,
      height: 1,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      color: { space: 'cmyk', samples: new Uint8Array([13, 10, 37, 41]) },
      alpha: new Uint8Array([13]),
    };
    const writer = createNativeWriter();
    writeRaster(writer, raster, { itemPath: '0/0' });
    const records = tokenizeNative(writer.finish());
    const data = records.find(record => record.kind === 'rasterData');
    expect(data).toStrictEqual({ kind: 'rasterData', color: new Uint8Array([13, 10, 37, 41]), alpha: new Uint8Array([13]) });
    expect(lines(records)).toContain('%%EndData');
    expect(lines(records)).toContain('XH');
  });

  it('reads escaped PostScript literal strings', () => {
    expect(parseNativeLiteral(String.raw`(Die \(outer\) \\ White)`)).toBe(String.raw`Die (outer) \ White`);
    expect(parseNativeLiteral('(非表示)')).toBe('非表示');
  });
});

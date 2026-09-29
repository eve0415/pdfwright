import type { RasterItem } from '../model/illustratorDocument.ts';
import type { NativeRecord } from './nativeTokenizer.ts';

import { ParseError } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from '../native/nativeWriter.ts';
import { writeRaster } from '../native/writeRaster.ts';

import { parseNativeLiteral, tokenizeNative } from './nativeTokenizer.ts';

const lines = (records: readonly NativeRecord[]): string[] => records.flatMap(record => (record.kind === 'line' ? [record.text] : []));
const encoder = new TextEncoder();

const thrown = (action: () => void): Error | undefined => {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw error;
  }
  return undefined;
};

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
    const native = writer.finish();
    const records = tokenizeNative(native);
    const data = records.find(record => record.kind === 'rasterData');
    expect(data).toStrictEqual({
      kind: 'rasterData',
      color: new Uint8Array([13, 10, 37, 41]),
      alpha: new Uint8Array([13]),
      offset: new TextDecoder().decode(native).indexOf('XI\n'),
    });
    expect(lines(records)).toContain('%%EndData');
    expect(lines(records)).toContain('XH');
  });

  it('records the byte offset of each line', () => {
    expect(tokenizeNative(encoder.encode('%!PS\r%%EndComments\r')).map(record => record.offset)).toStrictEqual([0, 5]);
  });

  it('reads escaped PostScript literal strings', () => {
    expect(parseNativeLiteral(String.raw`(Die \(outer\) \\ White)`, 0)).toBe(String.raw`Die (outer) \ White`);
    expect(parseNativeLiteral('(非表示)', 0)).toBe('非表示');
  });
});

describe('malformed native bytes', () => {
  it('reports a line without its CR at the line start', () => {
    const error = thrown(() => {
      tokenizeNative(encoder.encode('%!PS\r%%Title'));
    });
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset: 5 });
  });

  it('reports raster data that ends early at the end of the data', () => {
    const native = encoder.encode('[ 1 0 0 1 0 0 ] 0 0 2 2 2 2 8 4 1 18 1 0 4 4 0 0\r%%BeginData: 7\rXI\n1234');
    const error = thrown(() => {
      tokenizeNative(native);
    });
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset: native.length });
  });

  it('reports a literal string that is not closed', () => {
    const error = thrown(() => {
      parseNativeLiteral('(open', 12);
    });
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset: 12 });
  });
});

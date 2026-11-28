import type { RasterItem } from '../model/illustratorDocument.ts';
import type { NativeRecord } from './nativeTokenizer.ts';

import { ParseError } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { escapeNativeString } from '../native/nativeString.ts';
import { createNativeWriter } from '../native/nativeWriter.ts';
import { writeRaster } from '../native/writeRaster.ts';

import { parseNativeLiteral, tokenizeNative } from './nativeTokenizer.ts';

const lines = (records: ReadonlyArray<NativeRecord>): Array<string> => records.flatMap(record => (record.kind === 'line' ? [record.text] : []));
const encoder = new TextEncoder();

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

  it('reads an empty literal string', () => {
    expect(parseNativeLiteral('()', 0)).toBe('');
  });

  it('gives each raster the alpha length of the size line before it', () => {
    // Two pixels and then three, so a reader that keeps the first size would take the wrong alpha plane for the second raster.
    const native = encoder.encode(
      `[ 1 0 0 1 0 0 ] 0 0 2 1 2 1 8 4 1 18 1 0 4 4 0 0\r%%BeginData: 5\rXI\nab12\r[ 1 0 0 1 0 0 ] 0 0 3 1 3 1 8 4 1 18 1 0 4 4 0 0\r%%BeginData: 4\rXI\nc345\r`,
    );
    expect(tokenizeNative(native).filter(record => record.kind === 'rasterData')).toStrictEqual([
      { kind: 'rasterData', color: encoder.encode('ab'), alpha: encoder.encode('12'), offset: 64 },
      { kind: 'rasterData', color: encoder.encode('c'), alpha: encoder.encode('345'), offset: 136 },
    ]);
  });

  it('reads a data count of 3 as an empty colour plane', () => {
    const native = encoder.encode('[ 1 0 0 1 0 0 ] 0 0 2 1 2 1 8 4 1 18 1 0 4 4 0 0\r%%BeginData: 3\rXI\n12\r');
    expect(tokenizeNative(native).find(record => record.kind === 'rasterData')).toStrictEqual({
      kind: 'rasterData',
      color: new Uint8Array(),
      alpha: encoder.encode('12'),
      offset: 64,
    });
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

  it('reports a literal string that is not opened', () => {
    const error = thrown(() => {
      parseNativeLiteral('abc)', 7);
    });
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset: 7 });
  });

  // The %%BeginData line starts at byte 49 in each input; the raster size line before it gives two pixels.
  const sizeLine = '[ 1 0 0 1 0 0 ] 0 0 2 1 2 1 8 4 1 18 1 0 4 4 0 0\r';
  it.each([
    { name: 'a data count below 3', native: `${sizeLine}%%BeginData: 2\rXI\n12\r`, offset: 49 },
    { name: 'a data count with no raster size line before it', native: `${'%'.repeat(48)}\r%%BeginData: 3\rXI\n12\r`, offset: 49 },
    { name: 'raster data that does not start with XI LF', native: `${sizeLine}%%BeginData: 3\rXJ\n12\r`, offset: 64 },
  ])('reports $name at its offset', ({ native, offset }) => {
    const error = thrown(() => {
      tokenizeNative(encoder.encode(native));
    });
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset });
  });
});

// No line can spell a raster size or %%BeginData line, which need digits; multi-byte characters make byte and character offsets differ.
const lineText = fc.string({ unit: fc.constantFrom('a', ' ', '%', ':', '(', ')', '\\', 'é', '非', '😀', '\n'), maxLength: 12 });
const nameText = fc.string({ unit: fc.constantFrom('a', ' ', '(', ')', '\\', 'é', '非', '😀'), maxLength: 12 });

describe('properties', () => {
  it('splits CR-terminated text back into its lines at their byte offsets', () => {
    fc.assert(
      fc.property(fc.array(lineText, { maxLength: 8 }), texts => {
        const records = tokenizeNative(encoder.encode(texts.map(text => `${text}\r`).join('')));
        const offsets = texts.map((_, index) => texts.slice(0, index).reduce((sum, text) => sum + encoder.encode(text).length + 1, 0));
        expect(records).toStrictEqual(texts.map((text, index) => ({ kind: 'line', text, offset: offsets[index] })));
      }),
    );
  });

  it('reads back every name the native writer escapes', () => {
    fc.assert(
      fc.property(nameText, name => {
        expect(parseNativeLiteral(new TextDecoder().decode(escapeNativeString(name)), 0)).toBe(name);
      }),
    );
  });
});

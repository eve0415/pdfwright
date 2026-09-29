import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LoadWarning } from './loadWarning.ts';

import { describe, expect, it } from 'vitest';

import { ByteSource } from './byteSource.ts';
import { Lexer } from './lexer.ts';
import { parseObject } from './parseObject.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const chunked = (bytes: Uint8Array, size: number): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
  return chunks;
};

const parsed = (source: ByteSource, offset: number, warnings: LoadWarning[]): PdfDirectObject => {
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  return source.parseAt(offset, { warn, names: new Map() }, (window, local, context) => parseObject(new Lexer(window, local, context), 256));
};

const joined = (views: readonly Uint8Array[]): string => views.map(view => new TextDecoder('latin1').decode(view)).join('');

describe('segmented byte source', () => {
  const text = '%PDF-1.7 <</Key/Value/Duplicate 1/Duplicate 2/Array[1 2 3 0 R (string)]>> trailing';
  const bytes = encode(text);

  it('parses an object the same way however the input is split, warning once', () => {
    const expected: LoadWarning[] = [];
    const whole = parsed(new ByteSource(bytes), 9, expected);
    for (const size of [1, 2, 3, 7, 16, 64]) {
      const warnings: LoadWarning[] = [];
      const source = new ByteSource(chunked(bytes, size));
      expect([size, parsed(source, 9, warnings), warnings]).toStrictEqual([size, whole, expected]);
    }
    expect(expected.map(warning => warning.offset)).toStrictEqual([33]);
  });

  it('reads bytes and returns views of the original segments without copying', () => {
    const segments = chunked(bytes, 10);
    const source = new ByteSource([...segments, new Uint8Array()]);
    expect([source.length, source.byteAt(0), source.byteAt(bytes.length - 1), source.byteAt(bytes.length)]).toStrictEqual([
      bytes.length,
      0x25,
      0x67,
      undefined,
    ]);
    const views = source.views(5, 25);
    expect(joined(views)).toBe(text.slice(5, 25));
    expect(views.map(view => view.buffer === bytes.buffer)).toStrictEqual([true, true, true]);
    expect(joined(source.views(0, source.length))).toBe(text);
  });

  it('serves the segment that contains an offset and copies a window across segments', () => {
    const source = new ByteSource(chunked(bytes, 10));
    const window = source.window(15);
    expect([window.base, window.bytes.length, window.final]).toStrictEqual([10, 10, false]);
    const last = source.window(bytes.length - 1);
    expect([last.base, last.final]).toStrictEqual([80, true]);
    const copy = source.copy(5, 30);
    expect([copy.base, joined([copy.bytes]), copy.final]).toStrictEqual([5, text.slice(5, 30), false]);
    const end = source.copy(70, 1000);
    expect([end.bytes.length, end.final]).toStrictEqual([text.length - 70, true]);
  });

  it('finds the last pattern across segment boundaries', () => {
    const source = new ByteSource(chunked(encode('endstream abc endstream'), 3));
    expect(source.lastIndexOf([...encode('endstream')])).toBe(14);
  });
});

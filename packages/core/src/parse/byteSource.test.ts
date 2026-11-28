import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LoadWarning } from './loadWarning.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';

import { ByteSource } from './byteSource.ts';
import { Lexer } from './lexer.ts';
import { parseObject } from './parseObject.ts';
import { WindowEndError } from './windowEndError.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const chunked = (bytes: Uint8Array, size: number): Array<Uint8Array> => {
  const chunks: Array<Uint8Array> = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
};

const parsed = (source: ByteSource, offset: number, warnings: Array<LoadWarning>): PdfDirectObject => {
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  return source.parseAt(offset, { warn, names: new Map() }, (window, local, context) => parseObject(new Lexer(window, local, context), 256));
};

const ignore = (): void => {
  // Warnings are not under test here.
};

const joined = (views: ReadonlyArray<Uint8Array>): string => views.map(view => new TextDecoder('latin1').decode(view)).join('');

describe('segmented byte source', () => {
  const text = '%PDF-1.7 <</Key/Value/Duplicate 1/Duplicate 2/Array[1 2 3 0 R (string)]>> trailing';
  const bytes = encode(text);

  it('parses an object the same way however the input is split, warning once', () => {
    const expected: Array<LoadWarning> = [];
    const whole = parsed(new ByteSource(bytes), 9, expected);
    for (const size of [1, 2, 3, 7, 16, 64]) {
      const warnings: Array<LoadWarning> = [];
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
    expect([source.lastIndexOf([]), source.lastIndexOf([...encode('obj')])]).toStrictEqual([source.length, -1]);
  });

  it('finds every pattern, overlapping ones and ones crossing two boundaries included', () => {
    const source = new ByteSource([encode('aaab'), encode('c'), encode('dab')]);
    expect([source.indexesOf([...encode('aa')]), source.indexesOf([...encode('bcda')]), source.indexesOf([])]).toStrictEqual([[0, 1], [3], []]);
  });

  it('clamps offsets outside the source', () => {
    const source = new ByteSource(chunked(bytes, 10));
    const copy = source.copy(-5, 10);
    const last = source.window(bytes.length + 10);
    expect([source.byteAt(-1), copy.base, joined([copy.bytes]), copy.copied, last.base, last.final]).toStrictEqual([
      undefined,
      0,
      text.slice(0, 10),
      true,
      80,
      true,
    ]);
  });

  it('serves an empty source', () => {
    const source = new ByteSource([]);
    const window = source.window(0);
    expect([source.length, source.byteAt(0), source.views(0, 1), window.bytes.length, window.final]).toStrictEqual([0, undefined, [], 0, true]);
  });

  it('grows the copied window until an object larger than it fits, warning once', () => {
    // The duplicate key comes first, so that every attempt that runs out of bytes reads it again.
    const large = encode(`<</D 1 /D 2 /S (${'x'.repeat(10_000)})>>`);
    const expected: Array<LoadWarning> = [];
    const whole = parsed(new ByteSource(large), 0, expected);
    const warnings: Array<LoadWarning> = [];
    expect([parsed(new ByteSource(chunked(large, 1000)), 0, warnings), warnings]).toStrictEqual([whole, expected]);
    expect(expected.map(warning => warning.code)).toStrictEqual(['duplicate-key']);
  });

  it('passes on an error other than running out of bytes without retrying', () => {
    let calls = 0;
    const source = new ByteSource(chunked(bytes, 10));
    const run = (): void => {
      source.parseAt(0, { warn: ignore, names: new Map() }, () => {
        calls++;
        throw new ParseError('refused', 0);
      });
    };
    expect(run).toThrow(ParseError);
    expect(calls).toBe(1);
  });

  it('passes on running out of bytes once the window reaches the end of the source', () => {
    let calls = 0;
    const source = new ByteSource(chunked(bytes, 10));
    const run = (): void => {
      source.parseAt(0, { warn: ignore, names: new Map() }, () => {
        calls++;
        // A cap keeps a parseAt that retries forever from hanging the run.
        throw calls > 5 ? new Error('retried past the end of the source') : new WindowEndError();
      });
    };
    expect(run).toThrow(WindowEndError);
    expect(calls).toBe(2);
  });
});

const matchesAt = (data: Uint8Array, at: number, wanted: Uint8Array): boolean => wanted.every((byte, index) => data[at + index] === byte);

const naiveIndexes = (data: Uint8Array, wanted: Uint8Array): Array<number> =>
  wanted.length === 0 ? [] : Array.from({ length: Math.max(data.length - wanted.length + 1, 0) }, (_, at) => at).filter(at => matchesAt(data, at, wanted));

describe('properties', () => {
  // Four byte values make patterns recur, and cut points split the input into segments, empty ones included.
  const input = fc.tuple(fc.uint8Array({ max: 3, maxLength: 64 }), fc.array(fc.nat(), { maxLength: 6 })).map(([data, cuts]) => {
    const points = [...new Set(cuts.map(cut => cut % (data.length + 1)))].toSorted((left, right) => left - right);
    const segments = [0, ...points].map((start, index) => data.subarray(start, points[index] ?? data.length));
    return { data, segments };
  });
  const pattern = fc.uint8Array({ max: 3, maxLength: 4 });

  it('reads the same bytes and finds the same patterns however the input is split', () => {
    fc.assert(
      fc.property(input, pattern, fc.integer({ min: -2, max: 70 }), fc.integer({ min: -2, max: 70 }), ({ data, segments }, wanted, start, end) => {
        const source = new ByteSource(segments);
        const indexes = naiveIndexes(data, wanted);
        const slice = [...data.subarray(Math.max(start, 0), Math.max(Math.min(end, data.length), 0))];
        expect({
          bytes: Array.from({ length: data.length + 2 }, (_, offset) => source.byteAt(offset - 1)),
          views: source.views(start, end).flatMap(view => [...view]),
          copy: [...source.copy(start, end).bytes],
          indexes: source.indexesOf([...wanted]),
          last: source.lastIndexOf([...wanted]),
        }).toStrictEqual({
          bytes: [undefined, ...data, undefined],
          views: start < end ? slice : [],
          copy: slice,
          indexes,
          last: wanted.length === 0 ? data.length : (indexes.at(-1) ?? -1),
        });
      }),
    );
  });
});

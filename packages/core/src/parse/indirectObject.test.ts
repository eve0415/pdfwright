import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { ParsedIndirectObject } from './indirectObject.ts';
import type { LoadWarning } from './loadWarning.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';

import { ByteSource } from './byteSource.ts';
import { parseIndirectObject } from './indirectObject.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const ignore = (): void => {
  // Warnings are not under test here.
};

interface Result {
  object: ParsedIndirectObject;
  warnings: LoadWarning[];
}

const parse = (text: string, offset = 0, base = 0): Result => {
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const object = parseIndirectObject({ bytes: encode(text), base, final: true }, offset, { warn, names: new Map(), maxNesting: 256 });
  return { object, warnings };
};

const data = (result: Result): string => (result.object.value.kind === 'stream' ? new TextDecoder('latin1').decode(result.object.value.data) : '');

const parseInSource = (source: ByteSource, offset: number): ParsedIndirectObject =>
  source.parseAt(offset, { warn: ignore, names: new Map() }, (window, local, context) => parseIndirectObject(window, local, { ...context, maxNesting: 256 }));

const dataOf = (object: ParsedIndirectObject): Uint8Array => (object.value.kind === 'stream' ? object.value.data : new Uint8Array());

const lengthEntry = (result: Result): PdfDirectObject | undefined =>
  result.object.value.kind === 'stream' ? result.object.value.dictionary.get(pdfName('Length').bytes) : undefined;

describe('indirect object parser', () => {
  it('reads the header, the value and the extent of an object', () => {
    const result = parse('xx 12 3 obj\n<</A 1>>\nendobj\n', 3, 100);
    expect([result.object.objectNumber, result.object.generation, result.object.value.kind]).toStrictEqual([12, 3, 'dictionary']);
    expect(result.object.source).toStrictEqual({ kind: 'file', objectStart: 103, valueStart: 112, valueEnd: 120, objectEnd: 127, clean: true });
    expect(result.warnings).toStrictEqual([]);
  });

  it('reads stream data after CR LF or LF using a direct Length', () => {
    const crlf = parse('1 0 obj <</Length 5>> stream\r\nab\ncd\r\nendstream endobj');
    expect([data(crlf), lengthEntry(crlf), crlf.object.source.clean]).toStrictEqual(['ab\ncd', { kind: 'integer', value: 5 }, true]);
    expect(crlf.object.source).toMatchObject({ valueStart: 8, valueEnd: 46, objectEnd: 53, stream: { dictionaryEnd: 21, dataStart: 30, dataEnd: 35 } });
    expect(data(parse('1 0 obj <</Length 3>> stream\nabcendstream\nendobj'))).toBe('abc');
  });

  it('keeps data that contains the bytes endstream when Length says so', () => {
    expect(data(parse('1 0 obj <</Length 13>> stream\nendstream abc\nendstream endobj'))).toBe('endstream abc');
  });

  it('accepts a lone CR after stream with a warning', () => {
    const result = parse('1 0 obj <</Length 2>> stream\r\nx\nendstream endobj'.replace('\r\n', '\r'));
    expect([data(result), result.object.source.clean]).toStrictEqual(['x\n', false]);
    expect(result.warnings.map(warning => [warning.code, warning.objectNumber])).toStrictEqual([['stream-keyword-cr', 1]]);
  });

  it('accepts a missing endobj before another object or the end of the file', () => {
    const next = parse('1 0 obj 5\n2 0 obj 6 endobj');
    expect([next.object.value, next.object.source.objectEnd, next.warnings.map(warning => warning.code)]).toStrictEqual([
      { kind: 'integer', value: 5 },
      9,
      ['missing-endobj'],
    ]);
    const texts = ['1 0 obj 5 xref', '1 0 obj 5 trailer', '1 0 obj 5 startxref', '1 0 obj 5 '];
    expect(texts.map(text => parse(text).object.source.clean)).toStrictEqual([false, false, false, false]);
  });

  it('rejects a missing header, a stream without a dictionary and stray content before endobj', () => {
    expect(() => parse('1 0 5')).toThrow(new ParseError('expected an object header', 0));
    expect(() => parse(' 1 obj')).toThrow(ParseError);
    expect(() => parse('1 0 obj [1] stream\nx endstream endobj')).toThrow(new ParseError('a stream must follow a dictionary', 12));
    expect(() => parse('1 0 obj 5 6 endobj')).toThrow(new ParseError('expected endobj', 10));
  });

  it('parses an object whose stream crosses segment boundaries', () => {
    const bytes = encode('1 0 obj <</Length 10>> stream\n0123456789\nendstream\nendobj\n');
    const chunks = [bytes.subarray(0, 12), bytes.subarray(12, 35), bytes.subarray(35)];
    const object = new ByteSource(chunks).parseAt(0, { warn: ignore, names: new Map() }, (window, local, context) =>
      parseIndirectObject(window, local, { ...context, maxNesting: 256 }),
    );
    expect([data({ object, warnings: [] }), object.source.objectEnd]).toStrictEqual(['0123456789', bytes.length - 1]);
  });

  it('recovers the extent from endstream when Length is missing or wrong', () => {
    for (const [dictionary, declared] of [
      ['<</Length 3>>', '3'],
      ['<</Length 40>>', '40'],
      ['<<>>', 'missing or unresolvable'],
      ['<</Length -1>>', 'missing or unresolvable'],
      ['<</Length 9 0 R>>', 'missing or unresolvable'],
      ['<</Length --5>>', 'missing or unresolvable'],
    ]) {
      const result = parse(`1 0 obj ${dictionary} stream\r\nabc\ndef\r\nendstream\nendobj`);
      expect([data(result), result.object.source.clean]).toStrictEqual(['abc\ndef', false]);
      expect(result.warnings.at(-1)).toMatchObject({ code: 'stream-length-recovered', detail: `stream Length ${declared}, found 7 bytes before endstream` });
    }
  });

  it('prefers an endstream followed by endobj and strips one end-of-line marker', () => {
    expect(data(parse('1 0 obj <<>> stream\nx endstream y\nendstream endobj'))).toBe('x endstream y');
    expect(data(parse('1 0 obj <<>> stream\nx\n\nendstream'))).toBe('x\n');
    expect(data(parse('1 0 obj <<>> stream\nx\rendstream 2 0 obj'))).toBe('x');
  });

  it('rejects stream data with no endstream', () => {
    expect(() => parse('1 0 obj <<>> stream\nabc')).toThrow(new ParseError('stream data has no endstream keyword', 20));
  });

  it('reads a Length past the end of the source in the segment itself and copies data out of copied windows', () => {
    const first = encode('1 0 obj <</Length 999999>> stream\nabc\nendstream endobj\n');
    const second = encode('2 0 obj <</Length 10>> stream\n0123');
    const third = encode('456789\nendstream endobj\n');
    const source = new ByteSource([first, second, third]);
    const inSegment = dataOf(parseInSource(source, 0));
    const across = dataOf(parseInSource(source, first.length));
    expect([inSegment.buffer === first.buffer, across.buffer.byteLength]).toStrictEqual([true, 10]);
  });
});

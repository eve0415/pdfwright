import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { IndirectObjectContext, ParsedIndirectObject } from './indirectObject.ts';
import type { LoadWarning } from './loadWarning.ts';

import fc from 'fast-check';
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
  warnings: Array<LoadWarning>;
}

type Hooks = Pick<IndirectObjectContext, 'findEndstream' | 'lastEndstream'>;

const parse = (text: string, offset = 0, base = 0, hooks: Hooks = {}, warnings: Array<LoadWarning> = []): Result => {
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const object = parseIndirectObject({ bytes: encode(text), base, final: true }, offset, { ...hooks, warn, names: new Map(), maxNesting: 256 });
  return { object, warnings };
};

const data = (result: Result): string => (result.object.value.kind === 'stream' ? new TextDecoder('latin1').decode(result.object.value.data) : '');

const parseInSource = (source: ByteSource, offset: number): ParsedIndirectObject =>
  source.parseAt(offset, { warn: ignore, names: new Map() }, (window, local, context) => parseIndirectObject(window, local, { ...context, maxNesting: 256 }));

// Parses the object after the comment that starts the file, collecting its warnings.
const parseCollecting = (source: ByteSource): Result => {
  const warnings: Array<LoadWarning> = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const parsedObject = source.parseAt(7, { warn, names: new Map() }, (window, local, context) =>
    parseIndirectObject(window, local, { ...context, maxNesting: 256 }),
  );
  return { object: parsedObject, warnings };
};

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

  it('skips spaces between the keyword stream and its end-of-line marker with a warning', () => {
    const spaced = parse('1 0 obj <</Length 3>> stream \t\r\nq Q\nendstream endobj');
    const bare = parse('1 0 obj <</Length 5>> stream[1 2]\nendstream endobj');
    expect([data(spaced), spaced.warnings.map(warning => warning.code), data(bare), bare.warnings.map(warning => warning.code)]).toStrictEqual([
      'q Q',
      ['stream-keyword-eol'],
      '[1 2]',
      ['stream-keyword-eol'],
    ]);
  });

  it('accepts a missing endobj before another object or the end of the file', () => {
    const next = parse('1 0 obj 5\n2 0 obj 6 endobj');
    expect([next.object.value, next.object.source.objectEnd, next.warnings.map(warning => warning.code)]).toStrictEqual([
      { kind: 'integer', value: 5 },
      9,
      ['missing-endobj'],
    ]);
    expect(next.warnings.map(warning => warning.offset)).toStrictEqual([10]);
    const texts = ['1 0 obj 5 xref', '1 0 obj 5 trailer', '1 0 obj 5 startxref', '1 0 obj 5 '];
    expect(texts.map(text => parse(text).object.source.clean)).toStrictEqual([false, false, false, false]);
  });

  // ParseError carries no reason for PDF syntax, so the words that name the failing construct stand in for one.
  it.each([
    ['a header without the keyword obj', '1 0 5', 0, /header/],
    ['a header with one number', ' 1 obj', 1, /header/],
    ['a negative object number', '-1 0 obj 5 endobj', 0, /header/],
    ['a negative generation', '1 -1 obj 5 endobj', 0, /header/],
    ['a stream after something other than a dictionary', '1 0 obj [1] stream\nx endstream endobj', 12, /dictionary/],
    ['stray content before endobj', '1 0 obj 5 6 endobj', 10, /endobj/],
    ['stream data with no endstream', '1 0 obj <<>> stream\nabc', 20, /endstream/],
  ] as const)('rejects %s at its offset', (_, text, offset, words) => {
    expect(() => parse(text)).toThrow(ParseError);
    expect(() => parse(text)).toThrow(expect.objectContaining({ offset }));
    expect(() => parse(text)).toThrow(words);
  });

  it('reads an empty stream with Length 0 cleanly', () => {
    const result = parse('1 0 obj <</Length 0>> stream\nendstream endobj');
    expect([data(result), result.object.source.clean, result.warnings]).toStrictEqual(['', true, []]);
  });

  it('warns about a stream keyword at the end of the file before rejecting it', () => {
    const warnings: Array<LoadWarning> = [];
    const run = (): void => {
      warnings.length = 0;
      parse('1 0 obj <<>> stream', 0, 0, {}, warnings);
    };
    expect(run).toThrow(ParseError);
    expect(run).toThrow(expect.objectContaining({ offset: 19 }));
    expect(warnings.map(warning => warning.code)).toStrictEqual(['stream-keyword-eol']);
  });

  it('numbers warnings only once the header has been read', () => {
    const before: Array<LoadWarning> = [];
    expect(() => parse('/A#zz 0 obj 5 endobj', 0, 0, {}, before)).toThrow(ParseError);
    const after = parse('1 0 obj /A#zz endobj').warnings;
    expect([before.map(warning => [warning.code, 'objectNumber' in warning]), after.map(warning => [warning.code, warning.objectNumber])]).toStrictEqual([
      [['malformed-name-escape', false]],
      [['malformed-name-escape', 1]],
    ]);
  });

  // The data holds an endstream that a scan would find, so each failure shows that the hook decided it.
  it.each([
    ['the index finds no endstream', { findEndstream: () => undefined }],
    ['the last endstream lies before the data', { lastEndstream: 5 }],
    ['a function places the last endstream before the data', { lastEndstream: () => 5 }],
  ] as const satisfies Array<[string, Hooks]>)('rejects recovery when %s', (_, hooks) => {
    const text = '1 0 obj <<>> stream\nabc\nendstream endobj';
    expect(() => parse(text, 0, 0, hooks)).toThrow(ParseError);
    expect(() => parse(text, 0, 0, hooks)).toThrow(expect.objectContaining({ offset: 20 }));
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
    ] as const satisfies Array<[string, string]>) {
      const result = parse(`1 0 obj ${dictionary} stream\r\nabc\ndef\r\nendstream\nendobj`);
      expect([data(result), result.object.source.clean]).toStrictEqual(['abc\ndef', false]);
      // The warning names the declared Length and the byte count found; the rest of its wording is not part of the contract.
      const warning = result.warnings.at(-1);
      expect([warning?.code, warning?.detail.includes(`Length ${declared},`), warning?.detail.includes(' 7 bytes')]).toStrictEqual([
        'stream-length-recovered',
        true,
        true,
      ]);
    }
  });

  it('prefers an endstream followed by endobj and strips one end-of-line marker', () => {
    expect(data(parse('1 0 obj <<>> stream\nx endstream y\nendstream endobj'))).toBe('x endstream y');
    expect(data(parse('1 0 obj <<>> stream\nx\n\nendstream'))).toBe('x\n');
    expect(data(parse('1 0 obj <<>> stream\nx\rendstream 2 0 obj'))).toBe('x');
    const missingEndobj = '1 0 obj <<>> stream\nx\nendstream\n2 0 obj <<>> stream\ny\nendstream\n3 0 obj <<>> stream\nz\nendstream endobj';
    expect(data(parse(missingEndobj))).toBe('x');
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

describe('properties', () => {
  // The data repeats a short pattern to a drawn length, so that objects both smaller and larger than the first copied window (4,096 bytes) occur.
  const object = fc
    .tuple(fc.integer({ min: 0, max: 10_000 }), fc.uint8Array({ minLength: 1, maxLength: 16 }), fc.constantFrom('exact', 'missing', 'wrong'))
    .map(([length, pattern, declared]) => {
      const bytes = Uint8Array.from({ length }, (_, index) => pattern[index % pattern.length] ?? 0);
      const entry = declared === 'exact' ? `/Length ${String(length)}` : declared === 'wrong' ? `/Length ${String(length + 3)}` : '';
      const head = encode(`% junk\n1 0 obj <</A#zz 1 /A#zz 2 ${entry}>> stream\n`);
      const tail = encode('\nendstream\nendobj\n');
      const whole = new Uint8Array(head.length + bytes.length + tail.length);
      whole.set(head);
      whole.set(bytes, head.length);
      whole.set(tail, head.length + bytes.length);
      return whole;
    });

  it('parses an object the same way however the file is split, warning once', () => {
    fc.assert(
      fc.property(object, fc.array(fc.nat(), { maxLength: 6 }), (whole, cuts) => {
        const points = [...new Set(cuts.map(cut => cut % (whole.length + 1)))].toSorted((left, right) => left - right);
        const segments = [0, ...points].map((start, index) => whole.subarray(start, points[index] ?? whole.length));
        expect(parseCollecting(new ByteSource(segments))).toStrictEqual(parseCollecting(new ByteSource(whole)));
      }),
    );
  });
});

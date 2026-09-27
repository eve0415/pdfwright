import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LoadWarning } from './loadWarning.ts';
import type { SourceNode } from './parseObject.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { Lexer } from './lexer.ts';
import { parseAnnotated, parseObject } from './parseObject.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const ignore = (): void => {
  // Warnings are not under test here.
};

interface Parsed {
  value: PdfDirectObject;
  warnings: LoadWarning[];
  end: number;
}

const parse = (text: string, maxNesting = 256): Parsed => {
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const lexer = new Lexer({ bytes: encode(text), base: 0, final: true }, 0, { warn, names: new Map() });
  const value = parseObject(lexer, maxNesting);
  return { value, warnings, end: lexer.position };
};

const text = (value: PdfDirectObject): string => new TextDecoder('latin1').decode(serializeObject(value, { fractionDigits: 6 }));

const reparse = (source: string): string => text(parse(source).value);

const entry = (value: PdfDirectObject, key: string): PdfDirectObject | undefined =>
  value.kind === 'dictionary' ? value.entries.get(pdfName(key).bytes) : undefined;

const entryText = (value: PdfDirectObject, key: string): string => text(entry(value, key) ?? { kind: 'null' });

const keyLengths = (value: PdfDirectObject): number[] => (value.kind === 'dictionary' ? [...value.entries.entries()].map(([key]) => key.length) : []);

describe('direct object parser', () => {
  it('parses scalars, arrays and dictionaries', () => {
    expect(parse('true').value).toStrictEqual({ kind: 'boolean', value: true });
    expect(parse('null').value).toStrictEqual({ kind: 'null' });
    expect(parse('-.5').value).toStrictEqual({ kind: 'real', value: -0.5 });
    expect(reparse('[1 [2.5 /N] <</A (s) /B <0A>>> ]')).toBe('[1 [2.5 /N] <</A(s)/B<0A>>>]');
    expect(reparse('<<>>')).toBe('<<>>');
  });

  it('reads two integers followed by R as a reference and otherwise as integers', () => {
    expect(parse('12 0 R').value).toStrictEqual({ kind: 'reference', objectNumber: 12, generation: 0 });
    expect(reparse('[1 2 3 0 R 4 5]')).toBe('[1 2 3 0 R 4 5]');
    expect(reparse('[0 0 R -1 0 R]')).toBe('[0 0 R -1 0 R]');
    const single = parse('1 2');
    expect([single.value, single.end]).toStrictEqual([{ kind: 'integer', value: 1 }, 1]);
  });

  it('uses the last of duplicate keys and warns', () => {
    const { value, warnings } = parse('<</MediaBox[0 0 100 100]/MediaBox[0 0 300 300]>>');
    expect(entryText(value, 'MediaBox')).toBe('[0 0 300 300]');
    expect(warnings).toStrictEqual([{ code: 'duplicate-key', detail: 'duplicate dictionary key /MediaBox', offset: 24 }]);
  });

  it('treats null-valued entries as absent', () => {
    const { value } = parse('<</A null /B 1>>');
    expect([entry(value, 'A'), entry(value, 'B')]).toStrictEqual([undefined, { kind: 'integer', value: 1 }]);
  });

  it('keeps malformed tokens and unknown keywords as invalid objects with warnings', () => {
    const { value, warnings } = parse('[--300 300.5.5 foo]');
    expect(value).toStrictEqual({
      kind: 'array',
      items: [
        { kind: 'invalid', bytes: encode('--300'), reason: 'malformed-number' },
        { kind: 'invalid', bytes: encode('300.5.5'), reason: 'malformed-number' },
        { kind: 'invalid', bytes: encode('foo'), reason: 'unknown-keyword' },
      ],
    });
    expect(warnings.map(warning => [warning.code, warning.offset])).toStrictEqual([
      ['invalid-token', 1],
      ['invalid-token', 7],
      ['invalid-token', 15],
    ]);
  });

  it('keeps parsed keys that the public constructors would reject', () => {
    const { value } = parse(`<</A#00B 1 /${'k'.repeat(130)} 2>>`);
    expect(keyLengths(value)).toStrictEqual([3, 130]);
  });

  it('rejects structural errors with the offset of the offending token', () => {
    expect(() => parse('<</A 1 2 3>>')).toThrow(new ParseError('a dictionary key must be a name', 7));
    expect(() => parse('<</A>>')).toThrow(new ParseError('a dictionary key has no value', 4));
    expect(() => parse('[1 2')).toThrow(new ParseError('unexpected end of data', 4));
    expect(() => parse('<</A 1')).toThrow(ParseError);
  });

  it('rejects stray delimiters, keywords and closing brackets', () => {
    expect(() => parse(')')).toThrow(new ParseError('unexpected delimiter', 0));
    expect(() => parse('[1 R]')).toThrow(new ParseError('unexpected keyword R', 3));
    expect(() => parse(']')).toThrow(new ParseError('unexpected end of array', 0));
    expect(() => parse('>>')).toThrow(new ParseError('unexpected end of dictionary', 0));
  });

  it('limits nesting depth', () => {
    expect(parse('[[[1]]]', 3).value.kind).toBe('array');
    expect(() => parse('[[[[1]]]]', 3)).toThrow(ResourceLimitError);
    expect(() => parse('<</A<</B<</C<</D 1>>>>>>>>', 3)).toThrow(ResourceLimitError);
  });
});

const annotated = (source: string): SourceNode => {
  const lexer = new Lexer({ bytes: encode(source), base: 0, final: true }, 0, { warn: ignore, names: new Map() });
  return parseAnnotated(lexer, 256);
};

const spans = (node: SourceNode | undefined, source: string): string[] => [
  source.slice(node?.start, node?.end),
  ...(node?.items ?? []).map(item => source.slice(item.start, item.end)),
  ...(node?.entries ?? []).map(child => `${source.slice(child.keyStart, child.keyEnd)}=${source.slice(child.node.start, child.node.end)}`),
];

describe('annotated parser', () => {
  it('records the byte span of every value, entry and item', () => {
    const source = ' <</A#20B 1 0 R /C [ 0.242187 792.0 ] /D<</E(x)>> >> ';
    const node = annotated(source);
    expect(spans(node, source)).toStrictEqual([source.trim(), '/A#20B=1 0 R', '/C=[ 0.242187 792.0 ]', '/D=<</E(x)>>']);
    expect(spans(node.entries?.[1]?.node, source)).toStrictEqual(['[ 0.242187 792.0 ]', '0.242187', '792.0']);
    expect(text(node.value)).toBe('<</A#20B 1 0 R/C[0.242187 792]/D<</E(x)>>>>');
  });

  it('keeps every occurrence of a duplicate key while the value uses the last', () => {
    const source = '<</K 1/K 2>>';
    const node = annotated(source);
    expect(spans(node, source)).toStrictEqual([source, '/K=1', '/K=2']);
    expect(text(node.value)).toBe('<</K 2>>');
  });
});

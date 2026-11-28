import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LoadWarning } from './loadWarning.ts';
import type { SourceNode } from './parseObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { deepEqual } from '../object/deepEqual.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { Lexer } from './lexer.ts';
import { parseAnnotated, parseObject } from './parseObject.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const ignore = (): void => {
  // Warnings are not under test here.
};

interface Parsed {
  value: PdfDirectObject;
  warnings: Array<LoadWarning>;
  end: number;
}

const parse = (text: string, maxNesting = 256, maxNodes?: number): Parsed => {
  const warnings: Array<LoadWarning> = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const lexer = new Lexer({ bytes: encode(text), base: 0, final: true }, 0, { warn, names: new Map() });
  const value = parseObject(lexer, maxNesting, maxNodes);
  return { value, warnings, end: lexer.position };
};

const text = (value: PdfDirectObject): string => new TextDecoder('latin1').decode(serializeObject(value, { fractionDigits: 6 }));

const reparse = (source: string): string => text(parse(source).value);

const entry = (value: PdfDirectObject, key: string): PdfDirectObject | undefined =>
  value.kind === 'dictionary' ? value.entries.get(pdfName(key).bytes) : undefined;

const entryText = (value: PdfDirectObject, key: string): string => text(entry(value, key) ?? { kind: 'null' });

const keyLengths = (value: PdfDirectObject): Array<number> => (value.kind === 'dictionary' ? [...value.entries.entries()].map(([key]) => key.length) : []);

describe('direct object parser', () => {
  it('parses scalars, arrays and dictionaries', () => {
    expect(parse('true').value).toStrictEqual({ kind: 'boolean', value: true });
    expect(parse('false').value).toStrictEqual({ kind: 'boolean', value: false });
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

  it('reports a warning once when a reference lookahead reads the token', () => {
    const { value, warnings } = parse('[1 2 /A#zz]');
    expect([value.kind, warnings.map(warning => warning.code)]).toStrictEqual(['array', ['malformed-name-escape']]);
  });

  it('uses the last of duplicate keys and warns', () => {
    const { value, warnings } = parse('<</MediaBox[0 0 100 100]/MediaBox[0 0 300 300]>>');
    expect(entryText(value, 'MediaBox')).toBe('[0 0 300 300]');
    // The warning names the key; the rest of its wording is not part of the contract.
    expect(warnings.map(warning => [warning.code, warning.offset, warning.detail.includes('/MediaBox')])).toStrictEqual([['duplicate-key', 24, true]]);
  });

  it('detects duplicate keys by their decoded bytes and warns at each repeat', () => {
    const spelt = parse('<</AB 1 /A#42 2>>');
    expect([entryText(spelt.value, 'AB'), spelt.warnings.map(warning => [warning.code, warning.offset])]).toStrictEqual(['2', [['duplicate-key', 8]]]);
    const three = parse('<</K 1 /K 2 /K 3>>');
    expect([entryText(three.value, 'K'), three.warnings.map(warning => [warning.code, warning.offset])]).toStrictEqual([
      '3',
      [
        ['duplicate-key', 7],
        ['duplicate-key', 12],
      ],
    ]);
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

  // ParseError carries no reason for PDF syntax, so the words that name the failing construct stand in for one.
  it.each([
    ['a dictionary key that is not a name', '<</A 1 2 3>>', 7, /name/],
    ['a dictionary key with no value', '<</A>>', 4, /no value/],
    ['an array at the end of data', '[1 2', 4, /end of data/],
    ['a dictionary value at the end of data', '<</A 1', 6, /end of data/],
    ['a dictionary open at the end of data', '<<', 2, /end of data/],
    ['a dictionary key at the end of data', '<</A', 4, /end of data/],
    ['a stray delimiter', ')', 0, /delimiter/],
    ['the keyword R without two integers', '[1 R]', 3, /keyword R/],
    ['the keyword R after a real generation', '[1 2.0 R]', 7, /keyword R/],
    ['the keyword obj inside an array', '[1 obj]', 3, /keyword obj/],
    ['a closing square bracket', ']', 0, /end of array/],
    ['a closing dictionary bracket', '>>', 0, /end of dictionary/],
  ] as const)('rejects %s at the offset of the offending token', (_, source, offset, words) => {
    expect(() => parse(source)).toThrow(ParseError);
    expect(() => parse(source)).toThrow(expect.objectContaining({ offset }));
    expect(() => parse(source)).toThrow(words);
  });

  it('limits nesting depth', () => {
    expect(parse('[[[1]]]', 3).value.kind).toBe('array');
    expect(parse('<</A<</B<</C 1>>>>>>', 3).value.kind).toBe('dictionary');
    expect(() => parse('[[[[1]]]]', 3)).toThrow(ResourceLimitError);
    expect(() => parse('<</A<</B<</C<</D 1>>>>>>>>', 3)).toThrow(ResourceLimitError);
  });

  it('limits the number of values in a direct object', () => {
    expect(text(parse('[1 2]', 256, 3).value)).toBe('[1 2]');
    expect(() => parse('[1 2 3]', 256, 3)).toThrow(ResourceLimitError);
  });
});

const annotated = (source: string, maxNesting = 256): SourceNode => {
  const lexer = new Lexer({ bytes: encode(source), base: 0, final: true }, 0, { warn: ignore, names: new Map() });
  return parseAnnotated(lexer, maxNesting);
};

const spans = (node: SourceNode | undefined, source: string): Array<string> => [
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

  it('ends a number span at the number, not at the white space after it', () => {
    const source = '[1 2 ]';
    expect(spans(annotated(source), source)).toStrictEqual(['[1 2 ]', '1', '2']);
  });

  it('keeps every occurrence of a duplicate key while the value uses the last', () => {
    const source = '<</K 1/K 2>>';
    const node = annotated(source);
    expect(spans(node, source)).toStrictEqual([source, '/K=1', '/K=2']);
    expect(text(node.value)).toBe('<</K 2>>');
  });

  it.each([
    ['arrays', '[1]', '[[1]]'],
    ['dictionaries', '<</A 1>>', '<</A<</B 1>>>>'],
  ])('limits the nesting depth of %s', (_, atLimit, pastLimit) => {
    expect(text(annotated(atLimit, 1).value)).toBe(atLimit);
    expect(() => annotated(pastLimit, 1)).toThrow(ResourceLimitError);
  });
});

// Uniform bytes rarely hit an escape, so half of the draws use only the bytes that the writer escapes and a few around them.
const special = (bytes: ReadonlyArray<number>, constraints: { minLength: number; maxLength: number }): fc.Arbitrary<Uint8Array> =>
  fc.array(fc.constantFrom(...bytes), constraints).map(items => Uint8Array.from(items));

describe('properties', () => {
  // ISO 32000-1:2008, 7.3.5: a name is 1 to 127 bytes other than null here, and Annex C, Table C.1 bounds integers.
  const name = fc.oneof(
    fc.uint8Array({ min: 1, minLength: 1, maxLength: 127 }),
    special([0x01, 0x09, 0x0a, 0x0d, 0x20, 0x23, 0x25, 0x28, 0x2f, 0x41, 0x7e, 0x7f, 0xff], { minLength: 1, maxLength: 127 }),
  );
  const stringBytes = fc.oneof(
    fc.uint8Array({ maxLength: 64 }),
    special([0x00, 0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x28, 0x29, 0x5c, 0x41, 0x7f, 0xff], { minLength: 0, maxLength: 64 }),
  );
  // A whole real is written without a period and reads back as an integer, so reals are drawn with a nonzero fraction of at most 6 digits.
  const real = fc
    .tuple(fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }), fc.integer({ min: 1, max: 6 }))
    .filter(([numerator, digits]) => numerator % 10 ** digits !== 0)
    .map(([numerator, digits]): PdfDirectObject => ({ kind: 'real', value: numerator / 10 ** digits }));
  const { value } = fc.letrec<{ value: PdfDirectObject }>(tie => ({
    value: fc.oneof(
      { depthSize: 'small', maxDepth: 5 },
      fc.constantFrom<PdfDirectObject>({ kind: 'null' }, { kind: 'boolean', value: true }, { kind: 'boolean', value: false }),
      fc.integer({ min: -2_147_483_647, max: 2_147_483_647 }).map((number): PdfDirectObject => ({ kind: 'integer', value: number })),
      real,
      name.map((bytes): PdfDirectObject => ({ kind: 'name', bytes })),
      fc
        .tuple(stringBytes, fc.constantFrom('literal' as const, 'hex' as const))
        .map(([bytes, encoding]): PdfDirectObject => ({ kind: 'string', bytes, encoding })),
      fc
        .tuple(fc.integer({ min: 1, max: 2_147_483_647 }), fc.integer({ min: 0, max: 65_535 }))
        .map(([objectNumber, generation]): PdfDirectObject => ({ kind: 'reference', objectNumber, generation })),
      fc.array(tie('value'), { maxLength: 4 }).map((items): PdfDirectObject => ({ kind: 'array', items })),
      fc
        .array(fc.tuple(name, tie('value')), { maxLength: 4 })
        .map((entries): PdfDirectObject => ({ kind: 'dictionary', entries: new PdfDictionaryEntries(entries) })),
    ),
  }));

  it('reads back what serializeObject writes', () => {
    fc.assert(
      fc.property(value, original => {
        const written = serializeObject(original, { fractionDigits: 6 });
        const lexer = new Lexer({ bytes: written, base: 0, final: true }, 0, { warn: ignore, names: new Map() });
        expect(deepEqual(parseObject(lexer, 256), original, 'strict')).toBe(true);
      }),
    );
  });
});

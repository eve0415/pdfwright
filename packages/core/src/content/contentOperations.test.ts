import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { ContentOperand, ContentOperation, SpannedContentOperation } from './contentOperations.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { latin1Bytes } from '../testing/pdfBuilder.ts';

import { readContent, readContentSpans } from './contentOperations.ts';

const operations = (content: string | ReadonlyArray<string>): Array<ContentOperation> => [
  ...readContent(typeof content === 'string' ? latin1Bytes(content) : content.map(text => latin1Bytes(text)), 32),
];

const leftOver = (content: string | ReadonlyArray<string>): ReadonlyArray<ContentOperand> => {
  const reader = readContent(typeof content === 'string' ? latin1Bytes(content) : content.map(text => latin1Bytes(text)), 32);
  for (let step = reader.next(); ; step = reader.next()) {
    if (step.done === true) {
      return step.value;
    }
  }
};

// The spanned operations read and the operands left after the last operator.
const spansAndLeftOver = (content: string): readonly [Array<SpannedContentOperation>, ReadonlyArray<ContentOperand>] => {
  const reader = readContentSpans(latin1Bytes(content), 32);
  const read: Array<SpannedContentOperation> = [];
  for (let step = reader.next(); ; step = reader.next()) {
    if (step.done === true) {
      return [read, step.value];
    }
    read.push(step.value);
  }
};

// Arrays nested `depth` deep as the operand of TJ.
const nested = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)} TJ`;
// An open array of count values, the array included, its last value ending the stream. Booleans, because an integer reads ahead for a reference and reaches the token after it before it is counted.
const openArray = (count: number): string => `[${'true '.repeat(count - 2)}true`;

const name = (text: string): ContentOperand => ({ kind: 'name', bytes: latin1Bytes(text) });
const integer = (value: number): ContentOperand => ({ kind: 'integer', value });
const array = (...values: ReadonlyArray<number>): ContentOperand => ({
  kind: 'array',
  items: values.map((value): PdfDirectObject => ({ kind: 'integer', value })),
});

describe('content operations', () => {
  it('reads each operator with its parsed operands and offset', () => {
    expect(operations('1 0 0 1 10 20.5 cm\n/F1 12 Tf [(A) -50 (B)] TJ')).toStrictEqual([
      {
        operator: 'cm',
        operands: [...[1, 0, 0, 1, 10].map(value => ({ kind: 'integer', value })), { kind: 'real', value: 20.5 }],
        stream: 0,
        offset: 16,
      },
      { operator: 'Tf', operands: [name('F1'), { kind: 'integer', value: 12 }], stream: 0, offset: 26 },
      {
        operator: 'TJ',
        operands: [
          {
            kind: 'array',
            items: [
              { kind: 'string', bytes: latin1Bytes('A'), encoding: 'literal' },
              { kind: 'integer', value: -50 },
              { kind: 'string', bytes: latin1Bytes('B'), encoding: 'literal' },
            ],
          },
        ],
        stream: 0,
        offset: 43,
      },
    ]);
  });

  it('keeps one operand stack across streams without joining tokens at their boundaries', () => {
    const [moveTo] = operations(['1', '0 0 m']);
    expect([moveTo?.operands, moveTo?.stream, moveTo?.offset]).toStrictEqual([
      [
        { kind: 'integer', value: 1 },
        { kind: 'integer', value: 0 },
        { kind: 'integer', value: 0 },
      ],
      1,
      4,
    ]);
  });

  describe('an array or dictionary operand split between streams', () => {
    // ISO 32000-1:2008, 7.7.3.3, Table 30, Contents: "The division between streams may occur only at the boundaries between lexical tokens", and these divisions fall between two tokens.
    it('reads the array as one operand without joining the tokens on either side of the division', () => {
      expect(operations(['[1', '2] TJ'])).toStrictEqual([{ operator: 'TJ', operands: [array(1, 2)], stream: 1, offset: 3 }]);
    });

    it('reads a dictionary divided between a key and its value', () => {
      expect(operations(['/Span <</MCID', '7>> BDC'])).toStrictEqual([
        {
          operator: 'BDC',
          operands: [name('Span'), { kind: 'dictionary', entries: new PdfDictionaryEntries([[latin1Bytes('MCID'), { kind: 'integer', value: 7 }]]) }],
          stream: 1,
          offset: 4,
        },
      ]);
    });

    it('reads an array divided over three streams, the middle one empty, and the operations after it', () => {
      expect(operations(['q [1 %c', '', '2]', 'TJ Q'])).toStrictEqual([
        { operator: 'q', operands: [], stream: 0, offset: 0 },
        { operator: 'TJ', operands: [array(1, 2)], stream: 3, offset: 0 },
        { operator: 'Q', operands: [], stream: 3, offset: 3 },
      ]);
    });

    it('reads an array parameter of an inline image divided between streams', () => {
      const [image] = operations(['BI /W 1 /H 1 /BPC 8 /CS /G /D [0', '1] ID A EI']);
      expect(image?.inlineImage?.parameters.slice(-2)).toStrictEqual([name('D'), array(0, 1)]);
    });

    it.each([
      ['a stream division falls between parameters', ['q BI /W 1 /H 1 /BPC 8 /CS /G', '/D [0 1] ID A EI'], 16],
      ['a stream division falls inside an array parameter', ['q BI /W 1 /H 1 /BPC 8 /CS /G /D [0', '1] ID A EI'], 10],
    ])('ends the span of an inline image in the stream of EI when %s', (_, streams, end) => {
      const spans = [...readContentSpans(streams.map(text => latin1Bytes(text)), 32)].map(operation => [
        operation.operator,
        operation.stream,
        operation.start,
        operation.endStream,
        operation.end,
      ]);
      expect(spans).toStrictEqual([
        ['q', 0, 0, 0, 1],
        ['BI', 0, 2, 1, end],
      ]);
    });

    it('places the operation in the stream of its operator, starting the span at the operator', () => {
      const spans = [...readContentSpans([latin1Bytes('[1'), latin1Bytes('2] 0 d')], 32)].map(operation => [
        operation.stream,
        operation.offset,
        operation.start,
        operation.end,
      ]);
      expect(spans).toStrictEqual([[1, 5, 5, 6]]);
    });

    it('reads nesting up to maxNesting and refuses it past maxNesting', () => {
      expect(operations(['['.repeat(32), `${']'.repeat(32)} TJ`]).map(operation => operation.operator)).toStrictEqual(['TJ']);
      expect(() => operations(['['.repeat(33), `${']'.repeat(33)} TJ`])).toThrow(ResourceLimitError);
    });

    it('reads nesting that reaches maxNesting only after the division and refuses it one past', () => {
      expect(operations(['['.repeat(20), `${'['.repeat(12)}${']'.repeat(32)} TJ`]).map(operation => operation.operator)).toStrictEqual(['TJ']);
      expect(() => operations(['['.repeat(20), `${'['.repeat(13)}${']'.repeat(33)} TJ`])).toThrow(ResourceLimitError);
    });

    it('refuses an array still open after the last stream as it refuses the same bytes in one stream', () => {
      // The end of the content is read as one more value, so 16,383 values and the end pass the limit.
      expect(() => operations(['[', '0 '.repeat(16_382)])).toThrow(ParseError);
      expect(() => operations(['[', '0 '.repeat(16_383)])).toThrow(ResourceLimitError);
      expect(() => operations(`[${'0 '.repeat(16_382)}`)).toThrow(ParseError);
      expect(() => operations(`[${'0 '.repeat(16_383)}`)).toThrow(ResourceLimitError);
    });

    it('reads an array of 16,384 values, the array included, and refuses one of 16,385', () => {
      const [operation] = operations([`[${'0 '.repeat(8000)}`, `${'0 '.repeat(8383)}] TJ`]);
      const [read] = operation?.operands ?? [];
      expect(read?.kind === 'array' ? read.items.length : undefined).toBe(16_383);
      expect(() => operations([`[${'0 '.repeat(8000)}`, `${'0 '.repeat(8384)}] TJ`])).toThrow(ResourceLimitError);
    });

    it.each([
      ['16,384 values', [openArray(16_384), '(a'], ParseError],
      ['16,385 values', [openArray(16_385), '(a'], ResourceLimitError],
      ['nesting of 32', ['[', `${'['.repeat(31)}(a`], ParseError],
      ['nesting of 33', ['[', `${'['.repeat(32)}(a`], ResourceLimitError],
      ['nesting of 32 reached in a middle stream', ['[', '['.repeat(31), '(a'], ParseError],
      ['nesting of 33 reached in a middle stream', ['[', '['.repeat(32), '(a'], ResourceLimitError],
    ])('reads %s before an unterminated string in a later stream as the same bytes in one stream', (_, streams, error) => {
      expect(() => operations(streams.join('\n'))).toThrow(error);
      expect(() => operations(streams)).toThrow(error);
    });

    it.each([
      ['a string divided inside the array', ['[(a', 'b)] TJ']],
      ['an array still open after the last stream', ['[1', '2']],
      ['an array closed by a dictionary delimiter', ['[1', '>> TJ']],
    ])('throws ParseError for %s', (_, streams) => {
      expect(() => operations(streams)).toThrow(ParseError);
    });
  });

  it('reads an inline image as one BI operation with its parameters and data', () => {
    const [save, image, restore] = operations('q BI /W 6 /H 1 /BPC 8 /CS /G ID\nA EI B EI Q');
    expect([save?.operator, image, restore]).toStrictEqual([
      'q',
      {
        operator: 'BI',
        operands: [],
        inlineImage: {
          parameters: [name('W'), integer(6), name('H'), integer(1), name('BPC'), integer(8), name('CS'), name('G')],
          data: latin1Bytes('A EI B'),
        },
        stream: 0,
        offset: 2,
      },
      { operator: 'Q', operands: [], stream: 0, offset: 42 },
    ]);
  });

  it('reports byte spans for rewriting without changing ordinary reads', () => {
    const bytes = latin1Bytes('q 0.5 0 0 rg\nBI /W 1 /H 1 /BPC 8 /CS /G ID\nA EI\nQ');
    const ranged = [...readContentSpans(bytes, 32)];
    expect(ranged.map(operation => [operation.start, operation.end, new TextDecoder().decode(bytes.subarray(operation.start, operation.end))])).toStrictEqual([
      [0, 1, 'q'],
      [2, 12, '0.5 0 0 rg'],
      [13, 47, 'BI /W 1 /H 1 /BPC 8 /CS /G ID\nA EI'],
      [48, 49, 'Q'],
    ]);
  });

  it.each([
    ['an inline image', '0 BI /W 1 /H 1 /BPC 8 /CS /G ID A EI', 38],
    ['a BI without ID', '0 BI /W 1 Q', 6],
    ['a BI that the content ends before ID', '0 BI', 6],
  ])('starts the span of %s at the operand before BI', (_, content, end) => {
    // SpannedContentOperation.start: "First operand byte, or the operator byte when it has no operands."
    const [, image] = readContentSpans(latin1Bytes(`q ${content}`), 32);
    expect([image?.operator, image?.operands, image?.offset, image?.start, image?.end]).toStrictEqual(['BI', [integer(0)], 4, 2, end]);
  });

  it('starts the span of a BI at BI when its operand is in an earlier stream', () => {
    const spans = [...readContentSpans([latin1Bytes('0'), latin1Bytes('BI /W 1 /H 1 /BPC 8 /CS /G ID A EI')], 32)].map(operation => [
      operation.stream,
      operation.offset,
      operation.start,
      operation.end,
    ]);
    expect(spans).toStrictEqual([[1, 0, 0, 34]]);
  });

  it('leaves the parameters of a BI without ID to the next operator', () => {
    expect(operations('BI /W 1 Q')).toStrictEqual([
      { operator: 'BI', operands: [], stream: 0, offset: 0 },
      { operator: 'Q', operands: [name('W'), { kind: 'integer', value: 1 }], stream: 0, offset: 8 },
    ]);
  });

  it.each([']', '>>', ')'])('keeps the stray closing delimiter %s as an operand', delimiter => {
    expect(operations(`0 ${delimiter} w`)[0]?.operands).toStrictEqual([integer(0), { kind: 'stray-delimiter', bytes: latin1Bytes(delimiter) }]);
  });

  it('reports a BI that the content ends before ID without an image, leaving its parameters over', () => {
    expect(spansAndLeftOver('BI /W 1')).toStrictEqual([[{ operator: 'BI', operands: [], stream: 0, offset: 0, start: 0, end: 2 }], [name('W'), integer(1)]]);
  });

  it('reports a BI followed by another BI without an image, and gives the second the parameters after it', () => {
    expect(operations('BI /W 1 BI /W 1 /H 1 /BPC 8 /CS /G ID\nA EI Q')).toStrictEqual([
      { operator: 'BI', operands: [], stream: 0, offset: 0 },
      {
        operator: 'BI',
        operands: [name('W'), integer(1)],
        inlineImage: { parameters: [name('W'), integer(1), name('H'), integer(1), name('BPC'), integer(8), name('CS'), name('G')], data: latin1Bytes('A') },
        stream: 0,
        offset: 8,
      },
      { operator: 'Q', operands: [], stream: 0, offset: 43 },
    ]);
  });

  it('refuses operands nested deeper than maxNesting and reads them at it', () => {
    expect(operations(nested(32)).map(operation => operation.operator)).toStrictEqual(['TJ']);
    expect(() => operations(nested(33))).toThrow(ResourceLimitError);
  });

  it('returns the operands left after the last operator', () => {
    expect(leftOver('0 0 m 1 true')).toStrictEqual([
      { kind: 'integer', value: 1 },
      { kind: 'boolean', value: true },
    ]);
  });

  it('refuses an oversized pending operand stack before the operator', () => {
    expect(() => operations('0 '.repeat(16_385))).toThrow(ResourceLimitError);
  });

  it('reads an operator with 16,384 operands', () => {
    const [operation] = operations(`${'0 '.repeat(16_384)}n`);
    expect([operation?.operator, operation?.operands.length]).toStrictEqual(['n', 16_384]);
  });

  it('refuses an array operand of 16,385 values, the array included, while it is parsed', () => {
    expect(() => operations(`[${'0 '.repeat(16_384)}] TJ`)).toThrow(ResourceLimitError);
  });

  it('reads an array operand of 16,384 values, the array included', () => {
    const [operation] = operations(`[${'0 '.repeat(16_383)}] TJ`);
    const [array] = operation?.operands ?? [];
    expect([operation?.operator, array?.kind === 'array' ? array.items.length : undefined]).toStrictEqual(['TJ', 16_383]);
  });

  it('throws ParseError for an operand it cannot read', () => {
    expect(() => operations('(unterminated Tj')).toThrow(ParseError);
  });
});

// Whole objects and operators, so that every boundary between two of them is a boundary between lexical tokens.
const OPERAND_UNITS = ['0', '-12', '1.5', '/A', '/Name#20x', '(a b)', '<41>', '[1 (x) /N]', '<</K 1/L[2]>>', 'true', 'null'];
const OPERATOR_UNITS = ['m', 'Tj', 're', 'q', 'foo', "'"];
// Operands as their lexical tokens, arrays and dictionaries included, so that a division can fall inside an array or dictionary.
const { operandTokens } = fc.letrec<{ operandTokens: ReadonlyArray<string> }>(tie => ({
  operandTokens: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    fc.constantFrom('0', '-12', '1.5', '/A', '/Name#20x', '(a b)', '<41>', 'true', 'null').map(token => [token]),
    fc.array(tie('operandTokens'), { maxLength: 3 }).map(items => ['[', ...items.flat(), ']']),
    fc
      .array(fc.tuple(fc.constantFrom('/K', '/L'), tie('operandTokens')), { maxLength: 3 })
      .map(entries => ['<<', ...entries.flatMap(([key, value]) => [key, ...value]), '>>']),
  ),
}));
const tokens = fc
  .array(
    fc.oneof(
      operandTokens,
      fc.constantFrom(...OPERATOR_UNITS).map(operator => [operator]),
    ),
    { maxLength: 20 },
  )
  .map(units => units.flat());

const withoutPlaces = (read: ReadonlyArray<ContentOperation>): Array<Pick<ContentOperation, 'operator' | 'operands' | 'inlineImage'>> =>
  read.map(({ operator, operands, inlineImage }) => (inlineImage === undefined ? { operator, operands } : { operator, operands, inlineImage }));

describe('properties', () => {
  it('reads the same operations from content split into streams at any token boundaries', () => {
    // ISO 32000-1:2008, 7.7.3.3, Table 30, Contents: "The division between streams may occur only at the boundaries between lexical tokens".
    fc.assert(
      fc.property(tokens, fc.array(fc.boolean(), { maxLength: 60 }), (sequence, cuts) => {
        const streams: Array<Array<string>> = [[]];
        for (const [index, unit] of sequence.entries()) {
          if (cuts[index] === true) {
            streams.push([]);
          }
          streams.at(-1)?.push(unit);
        }
        const whole = [...readContent(latin1Bytes(sequence.join(' ')), 32)];
        const split = [
          ...readContent(
            streams.map(stream => latin1Bytes(stream.join(' '))),
            32,
          ),
        ];
        expect(withoutPlaces(split)).toStrictEqual(withoutPlaces(whole));
        expect(leftOver(streams.map(stream => stream.join(' ')))).toStrictEqual(leftOver(sequence.join(' ')));
      }),
    );
  });

  it('reads each operation again from its span alone', () => {
    // An inline image follows an operator, an operand that BI then carries, or whatever unit comes before it.
    const image = fc
      .tuple(fc.constantFrom('q ', '0 ', ''), fc.integer({ min: 0, max: 255 }))
      .map(([before, sample]) => `${before}BI /W 1 /H 1 /BPC 8 /CS /G ID ${String.fromCodePoint(sample)} EI`);
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.constantFrom(...OPERAND_UNITS, ...OPERATOR_UNITS), image), { maxLength: 30 }), sequence => {
        const bytes = latin1Bytes(sequence.join(' '));
        for (const operation of readContentSpans(bytes, 32)) {
          const again = [...readContent(bytes.subarray(operation.start, operation.end), 32)];
          expect(withoutPlaces(again)).toStrictEqual(withoutPlaces([operation]));
        }
      }),
    );
  });
});

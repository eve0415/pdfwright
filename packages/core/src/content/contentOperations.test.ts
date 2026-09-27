import type { ContentOperand, ContentOperation } from './contentOperations.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { latin1Bytes } from '../testing/pdfBuilder.ts';

import { readContent } from './contentOperations.ts';

const operations = (content: string | readonly string[]): ContentOperation[] => [
  ...readContent(typeof content === 'string' ? latin1Bytes(content) : content.map(text => latin1Bytes(text)), 32),
];

const leftOver = (content: string): readonly ContentOperand[] => {
  const reader = readContent(latin1Bytes(content), 32);
  for (let step = reader.next(); ; step = reader.next()) if (step.done === true) return step.value;
};

const name = (text: string): ContentOperand => ({ kind: 'name', bytes: latin1Bytes(text) });

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

  it('reads an inline image as one BI operation with its parameters and data', () => {
    const [save, image, restore] = operations('q BI /W 6 /H 1 /BPC 8 /CS /G ID\nA EI B EI Q');
    expect([save?.operator, image?.operator, image?.offset, image?.inlineImage?.parameters.length, image?.inlineImage?.data, restore]).toStrictEqual([
      'q',
      'BI',
      2,
      8,
      latin1Bytes('A EI B'),
      { operator: 'Q', operands: [], stream: 0, offset: 42 },
    ]);
  });

  it('leaves the parameters of a BI without ID to the next operator', () => {
    expect(operations('BI /W 1 Q')).toStrictEqual([
      { operator: 'BI', operands: [], stream: 0, offset: 0 },
      { operator: 'Q', operands: [name('W'), { kind: 'integer', value: 1 }], stream: 0, offset: 8 },
    ]);
  });

  it('keeps stray closing delimiters as operands', () => {
    expect(operations('0 ] w')[0]?.operands).toStrictEqual([
      { kind: 'integer', value: 0 },
      { kind: 'stray-delimiter', bytes: latin1Bytes(']') },
    ]);
  });

  it('returns the operands left after the last operator', () => {
    expect(leftOver('0 0 m 1 true')).toStrictEqual([
      { kind: 'integer', value: 1 },
      { kind: 'boolean', value: true },
    ]);
  });

  it('throws ParseError for an operand it cannot read', () => {
    expect(() => operations('(unterminated Tj')).toThrow(ParseError);
  });
});

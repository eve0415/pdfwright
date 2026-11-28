import type { ContentOperand } from './contentOperations.ts';

import { describe, expect, it } from 'vitest';

import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { latin1Bytes } from '../testing/pdfBuilder.ts';

import { checkOperands } from './operands.ts';

const integer = (value: number): ContentOperand => ({ kind: 'integer', value });
const real = (value: number): ContentOperand => ({ kind: 'real', value });
const name = (text: string): ContentOperand => ({ kind: 'name', bytes: latin1Bytes(text) });
const string = (text: string): ContentOperand => ({ kind: 'string', bytes: latin1Bytes(text), encoding: 'literal' });
const stray = (text: string): ContentOperand => ({ kind: 'stray-delimiter', bytes: latin1Bytes(text) });
const TRUE: ContentOperand = { kind: 'boolean', value: true };
const EMPTY_DICTIONARY: ContentOperand = { kind: 'dictionary', entries: new PdfDictionaryEntries() };

describe('operand checking', () => {
  it('takes the last operands an operator needs and leaves the ones before them', () => {
    // ISO 32000-1:2008, Annex A, Table A.1: cm takes six numbers; the 5 before them is not one of its operands.
    expect(checkOperands('cm', [integer(5), ...[1, 0, 0, 1, 10, 20].map(value => integer(value))])).toStrictEqual({
      kind: 'known',
      values: [1, 0, 0, 1, 10, 20].map(value => integer(value)),
    });
  });

  it.each([
    ['/F1 10 Tf', 'known', 'Tf', [name('F1'), integer(10)]],
    ['(x) 10 Tf', 'bad', 'Tf', [string('x'), integer(10)]],
    ['0.5 1 1 rg', 'known', 'rg', [real(0.5), integer(1), integer(1)]],
    ['/A 1 1 rg', 'bad', 'rg', [name('A'), integer(1), integer(1)]],
    ['true w', 'bad', 'w', [TRUE]],
    ['/Im1 Do', 'known', 'Do', [name('Im1')]],
    ['1 Do', 'bad', 'Do', [integer(1)]],
    ['/P <<>> BDC', 'known', 'BDC', [name('P'), EMPTY_DICTIONARY]],
    ['/P /MC0 BDC', 'known', 'BDC', [name('P'), name('MC0')]],
    ['/P (x) BDC', 'bad', 'BDC', [name('P'), string('x')]],
    ['0 0 10 re', 'bad', 're', [integer(0), integer(0), integer(10)]],
  ] as const)('reads the operands of %s as %s', (_, kind, operator, operands) => {
    expect(checkOperands(operator, operands)).toStrictEqual(kind === 'known' ? { kind, values: operands } : { kind });
  });

  it.each([
    ['inside the operands taken', 'w', [integer(0), stray(']')], { kind: 'bad' }],
    ['before the operands taken', 'w', [stray(']'), integer(0)], { kind: 'known', values: [integer(0)] }],
    ['anywhere in the operands of an operator with a variable count', 'sc', [stray(']'), real(0.5)], { kind: 'bad' }],
  ] as const)('reads a stray delimiter %s', (_, operator, operands, expected) => {
    expect(checkOperands(operator, operands)).toStrictEqual(expected);
  });

  it('gives an operator with a variable count all its operands, and an operator it does not know none', () => {
    expect([checkOperands('scn', [real(0.5), name('P')]), checkOperands('foo', [integer(1)])]).toStrictEqual([
      { kind: 'known', values: [real(0.5), name('P')] },
      { kind: 'unknown' },
    ]);
  });
});

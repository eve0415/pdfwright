import type { PdfObject } from './pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { mm } from '../length/length.ts';

import { deepEqual } from './deepEqual.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference, pdfString } from './pdfObject.ts';

const dictionary = (entries: [string, PdfObject & { kind: Exclude<PdfObject['kind'], 'stream'> }][]): PdfObject =>
  pdfDictionary(new PdfDictionaryEntries(entries.map(([key, value]) => [pdfName(key).bytes, value])));

const invalid = (text: string): PdfObject => ({ kind: 'invalid', bytes: new TextEncoder().encode(text), reason: 'malformed-number' });

const both = (left: PdfObject, right: PdfObject): [boolean, boolean] => [deepEqual(left, right, 'strict'), deepEqual(left, right, 'lenient')];

const stream = (data: string, length: number): PdfObject => ({
  kind: 'stream',
  dictionary: new PdfDictionaryEntries([[pdfName('Length').bytes, pdfInteger(length)]]),
  data: new TextEncoder().encode(data),
});

describe('structural equality', () => {
  it('compares integers and reals by kind in strict mode and by value in lenient mode', () => {
    expect(both(pdfInteger(1), pdfReal(1))).toStrictEqual([false, true]);
    expect(both(pdfReal(0.5), pdfReal(0.5))).toStrictEqual([true, true]);
    const inch = pdfReal(mm(25.4));
    const millimetre = pdfReal(mm(1));
    expect(both(inch, pdfReal(72))).toStrictEqual([true, true]);
    expect(both(millimetre, pdfReal(2.83465))).toStrictEqual([false, false]);
  });

  it('compares strings by bytes, and by encoding only in strict mode', () => {
    const bytes = new Uint8Array([1, 2]);
    const other = pdfString(new Uint8Array([1, 3]));
    expect(both(pdfString(bytes), pdfString(bytes, 'hex'))).toStrictEqual([false, true]);
    expect(both(pdfString(bytes), other)).toStrictEqual([false, false]);
  });

  it('compares names, invalid tokens and references by their bytes and numbers', () => {
    expect([both(pdfName('A'), pdfName('A')), both(pdfName('A'), pdfName('B'))]).toStrictEqual([
      [true, true],
      [false, false],
    ]);
    expect([both(invalid('--3'), invalid('--3')), both(invalid('--3'), invalid('-3'))]).toStrictEqual([
      [true, true],
      [false, false],
    ]);
    expect([both(pdfReference(1, 0), pdfReference(1, 0)), both(pdfReference(1, 0), pdfReference(1, 1))]).toStrictEqual([
      [true, true],
      [false, false],
    ]);
  });

  it('compares dictionaries as key sets with null values absent, and arrays element by element', () => {
    const left = dictionary([
      ['A', pdfInteger(1)],
      ['B', pdfArray([pdfName('X')])],
      ['C', { kind: 'null' }],
    ]);
    const right = dictionary([
      ['B', pdfArray([pdfName('X')])],
      ['A', pdfInteger(1)],
    ]);
    expect(both(left, right)).toStrictEqual([true, true]);
    const smaller = dictionary([['A', pdfInteger(1)]]);
    const one = pdfArray([pdfInteger(1)]);
    const two = pdfArray([pdfInteger(1), pdfInteger(2)]);
    expect(both(left, smaller)).toStrictEqual([false, false]);
    expect(both(one, two)).toStrictEqual([false, false]);
  });

  it('compares streams by dictionary and data', () => {
    expect(both(stream('ab', 2), stream('ab', 2))).toStrictEqual([true, true]);
    expect(both(stream('ab', 2), stream('ac', 2))).toStrictEqual([false, false]);
    expect(both(stream('ab', 2), stream('ab', 3))).toStrictEqual([false, false]);
    expect(both(stream('ab', 2), pdfInteger(2))).toStrictEqual([false, false]);
  });
});

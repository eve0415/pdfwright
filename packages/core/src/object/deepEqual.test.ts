import type { PdfDirectObject, PdfObject } from './pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mm } from '../length/length.ts';

import { cloneObject } from './cloneObject.ts';
import { deepEqual } from './deepEqual.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference, pdfString } from './pdfObject.ts';

const dictionary = (entries: Array<[string, PdfObject & { kind: Exclude<PdfObject['kind'], 'stream'> }]>): PdfObject =>
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
    expect(both(pdfReal(1), pdfInteger(1))).toStrictEqual([false, true]);
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

  it.each([
    ['equal names', pdfName('A'), pdfName('A'), [true, true]],
    ['different names', pdfName('A'), pdfName('B'), [false, false]],
    ['a name and a longer name it prefixes', pdfName('A'), pdfName('AB'), [false, false]],
    ['a name and a shorter name that prefixes it', pdfName('AB'), pdfName('A'), [false, false]],
    ['a name and an invalid token of the same bytes', pdfName('A'), invalid('A'), [false, false]],
    ['equal invalid tokens', invalid('--3'), invalid('--3'), [true, true]],
    ['different invalid tokens', invalid('--3'), invalid('-3'), [false, false]],
    ['equal references', pdfReference(1, 0), pdfReference(1, 0), [true, true]],
    ['references with different generations', pdfReference(1, 0), pdfReference(1, 1), [false, false]],
    ['references with different object numbers', pdfReference(1, 0), pdfReference(2, 0), [false, false]],
    ['booleans of different values', { kind: 'boolean', value: true }, { kind: 'boolean', value: false }, [false, false]],
    ['two nulls', { kind: 'null' }, { kind: 'null' }, [true, true]],
    ['null and false', { kind: 'null' }, { kind: 'boolean', value: false }, [false, false]],
  ] as const satisfies Array<[string, PdfObject, PdfObject, [boolean, boolean]]>)(
    'compares %s by their kind, bytes and numbers',
    (_, left, right, expected) => {
      expect(both(left, right)).toStrictEqual(expected);
    },
  );

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
    expect(both(smaller, left)).toStrictEqual([false, false]);
    expect(both(one, two)).toStrictEqual([false, false]);
    expect(both(two, pdfArray([pdfInteger(1), pdfInteger(3)]))).toStrictEqual([false, false]);
  });

  it('compares numbers by value inside containers in lenient mode', () => {
    expect(both(pdfArray([pdfInteger(1)]), pdfArray([pdfReal(1)]))).toStrictEqual([false, true]);
    expect(both(dictionary([['A', pdfInteger(1)]]), dictionary([['A', pdfReal(1)]]))).toStrictEqual([false, true]);
  });

  it('compares streams by dictionary and data', () => {
    expect(both(stream('ab', 2), stream('ab', 2))).toStrictEqual([true, true]);
    expect(both(stream('ab', 2), stream('ac', 2))).toStrictEqual([false, false]);
    expect(both(stream('ab', 2), stream('ab', 3))).toStrictEqual([false, false]);
    expect(both(stream('ab', 2), pdfInteger(2))).toStrictEqual([false, false]);
    expect(both(stream('ab', 2), dictionary([['Length', pdfInteger(2)]]))).toStrictEqual([false, false]);
  });
});

describe('properties', () => {
  // Values drawn from two choices per kind, so that two independent draws are often equal or differ in one place.
  const { value } = fc.letrec<{ value: PdfDirectObject }>(tie => ({
    value: fc.oneof(
      { depthSize: 'small' },
      fc.constantFrom<PdfDirectObject>(
        { kind: 'null' },
        { kind: 'boolean', value: false },
        pdfInteger(1),
        pdfInteger(2),
        pdfReal(1),
        pdfReal(0.5),
        pdfName('A'),
        pdfName('B'),
        pdfString(Uint8Array.of(1)),
        pdfString(Uint8Array.of(1), 'hex'),
        pdfReference(1, 0),
        pdfReference(2, 0),
        { kind: 'invalid', bytes: Uint8Array.of(0x2d), reason: 'malformed-number' },
      ),
      fc.array(tie('value'), { maxLength: 2 }).map(items => pdfArray(items)),
      fc
        .array(fc.tuple(fc.constantFrom('A', 'B'), tie('value')), { maxLength: 2 })
        .map(entries => pdfDictionary(new PdfDictionaryEntries(entries.map(([key, item]) => [pdfName(key).bytes, item])))),
    ),
  }));
  const object = fc.oneof(
    value,
    fc
      .tuple(value, fc.constantFrom(Uint8Array.of(), Uint8Array.of(1)))
      .map(([item, data]): PdfObject => ({ kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('K').bytes, item]]), data })),
  );
  const mode = fc.constantFrom('strict' as const, 'lenient' as const);

  // Writes every whole number in the other numeric kind, so that a pair differs in strict mode and agrees in lenient mode.
  const swapNumbers = (item: PdfDirectObject): PdfDirectObject => {
    if (item.kind === 'integer') {
      return pdfReal(item.value);
    }
    if (item.kind === 'real' && typeof item.value === 'number' && Number.isInteger(item.value)) {
      return pdfInteger(item.value);
    }
    if (item.kind === 'array') {
      return pdfArray(item.items.map(child => swapNumbers(child)));
    }
    if (item.kind === 'dictionary') {
      return pdfDictionary(new PdfDictionaryEntries([...item.entries.entries()].map(([key, child]) => [key, swapNumbers(child)])));
    }
    return item;
  };

  // Independent draws are rarely equal, so a pair is also drawn as a value and its clone, or a value and its numbers swapped.
  const pair = fc.oneof(
    fc.tuple(object, object),
    object.map(left => [left, cloneObject(left)] as const),
    value.map(left => [left, swapNumbers(left)] as const),
  );

  it('is reflexive, also against a clone', () => {
    fc.assert(
      fc.property(object, mode, (left, chosen) => {
        expect([deepEqual(left, left, chosen), deepEqual(left, cloneObject(left), chosen)]).toStrictEqual([true, true]);
      }),
    );
  });

  it('is symmetric, and strict equality implies lenient equality', () => {
    fc.assert(
      fc.property(pair, ([left, right]) => {
        const strict = deepEqual(left, right, 'strict');
        const lenient = deepEqual(left, right, 'lenient');
        expect([deepEqual(right, left, 'strict'), deepEqual(right, left, 'lenient'), strict && !lenient]).toStrictEqual([strict, lenient, false]);
      }),
    );
  });
});

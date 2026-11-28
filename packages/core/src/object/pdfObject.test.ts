import type { PdfObject } from './pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import {
  PdfDictionaryEntries,
  pdfArray,
  pdfDictionary,
  pdfInteger,
  pdfLiteralString,
  pdfName,
  pdfNameFromBytes,
  pdfReal,
  pdfReference,
  pdfString,
} from './pdfObject.ts';

describe('pdf objects', () => {
  it('validates name bytes and preserves non-ASCII names', () => {
    expect(pdfName('').bytes).toStrictEqual(new Uint8Array());
    // ISO 32000-1:2008, 7.3.5: the printable range of regular characters runs from ! (21h) to ~ (7Eh).
    expect(pdfName('!~').bytes).toStrictEqual(Uint8Array.of(0x21, 0x7e));
    expect(pdfNameFromBytes(new Uint8Array([0x82, 0xa0])).bytes).toStrictEqual(new Uint8Array([0x82, 0xa0]));
    for (const name of ['a b', 'é', '\0', '\t', '\u007f', 'A'.repeat(128)]) {
      expect(() => pdfName(name)).toThrow(InvalidArgumentError);
    }
    expect(() => pdfNameFromBytes(new Uint8Array([0])).bytes).toThrow(InvalidArgumentError);
    // Annex C, Table C.1 limits a name to 127 bytes; the bytes are printable so that only the length can reject them.
    expect(() => pdfNameFromBytes(new Uint8Array(128).fill(65))).toThrow(InvalidArgumentError);
    expect(pdfNameFromBytes(new Uint8Array(127).fill(65)).bytes).toHaveLength(127);
  });

  it('rejects dictionary keys that are not valid name bytes', () => {
    const entries = new PdfDictionaryEntries();
    expect(() => entries.set(new Uint8Array([0x41, 0]), pdfInteger(1))).toThrow(InvalidArgumentError);
    expect(() => entries.set(new Uint8Array(128).fill(0x41), pdfInteger(1))).toThrow(InvalidArgumentError);
    expect(() => new PdfDictionaryEntries([[new Uint8Array([0]), pdfInteger(1)]])).toThrow(InvalidArgumentError);
    expect(entries.set(new Uint8Array(127).fill(0x41), pdfInteger(1)).size).toBe(1);
  });

  it('reads null dictionary values as absent and keeps insertion order', () => {
    const entries = new PdfDictionaryEntries();
    // B is inserted before A, so insertion order and sorted order differ.
    const first = new Uint8Array([66]);
    const second = new Uint8Array([65]);
    entries.set(first, pdfInteger(1));
    entries.set(second, { kind: 'null' });
    expect(entries.get(second)).toBeUndefined();
    expect([entries.has(second), entries.size]).toStrictEqual([false, 1]);
    entries.set(second, pdfInteger(3));
    expect([...entries.entries()].map(([key]) => key)).toStrictEqual([first, second]);
    // Replacing a value keeps the key where it was, so a rewritten dictionary keeps its byte order.
    entries.set(first, pdfInteger(2));
    expect([...entries.entries()]).toStrictEqual([
      [first, pdfInteger(2)],
      [second, pdfInteger(3)],
    ]);
    expect([entries.delete(first), entries.size]).toStrictEqual([true, 1]);
  });

  it('constructs plain discriminated objects', () => {
    expect(pdfString(new Uint8Array([1]))).toStrictEqual({ kind: 'string', bytes: new Uint8Array([1]), encoding: 'literal' });
    expect(pdfLiteralString('ABC').bytes).toStrictEqual(new Uint8Array([65, 66, 67]));
    expect(pdfArray([pdfReal(0.5)])).toStrictEqual({ kind: 'array', items: [{ kind: 'real', value: 0.5 }] });
    expect(pdfDictionary().entries.size).toBe(0);
    expect(pdfReference(7, 2)).toStrictEqual({ kind: 'reference', objectNumber: 7, generation: 2 });
  });

  it('copies the bytes it is given', () => {
    const input = Uint8Array.of(0x41, 0x42);
    const name = pdfNameFromBytes(input);
    const string = pdfString(input);
    input.fill(0x5a);
    expect([name.bytes, string.bytes]).toStrictEqual([Uint8Array.of(0x41, 0x42), Uint8Array.of(0x41, 0x42)]);
  });

  it('rejects invalid object inputs', () => {
    expect(() => pdfLiteralString('é')).toThrow(InvalidArgumentError);
    expect(() => pdfInteger(1.5)).toThrow(InvalidArgumentError);
    expect(() => pdfReal(Infinity)).toThrow(InvalidArgumentError);
    expect(() => pdfReal({ numerator: 1n, denominator: 0n })).toThrow(InvalidArgumentError);
    expect(() => pdfReference(0, 0)).toThrow(InvalidArgumentError);
  });

  // ISO 32000-1:2008, Annex C, Table C.1: integers within ±2,147,483,647, object numbers up to 2,147,483,647 and generations up to 65,535.
  it.each([
    ['the largest integer', () => pdfInteger(2_147_483_647), { kind: 'integer', value: 2_147_483_647 }],
    ['the smallest integer', () => pdfInteger(-2_147_483_647), { kind: 'integer', value: -2_147_483_647 }],
    ['the largest reference', () => pdfReference(2_147_483_647, 65_535), { kind: 'reference', objectNumber: 2_147_483_647, generation: 65_535 }],
    ['the smallest reference', () => pdfReference(1, 0), { kind: 'reference', objectNumber: 1, generation: 0 }],
    ['the largest ASCII literal string', () => pdfLiteralString('\u007f'), { kind: 'string', bytes: Uint8Array.of(0x7f), encoding: 'literal' }],
  ] as const satisfies Array<[string, () => PdfObject, PdfObject]>)('accepts %s', (_, build, expected) => {
    expect(build()).toStrictEqual(expected);
  });

  it.each([
    ['an integer one above the range', () => pdfInteger(2_147_483_648)],
    ['an integer one below the range', () => pdfInteger(-2_147_483_648)],
    ['an integer that is NaN', () => pdfInteger(Number.NaN)],
    ['a real that is NaN', () => pdfReal(Number.NaN)],
    ['a real that is negative infinity', () => pdfReal(-Infinity)],
    ['a length with a negative denominator', () => pdfReal({ numerator: 1n, denominator: -1n })],
    ['an object number one above the range', () => pdfReference(2_147_483_648, 0)],
    ['a fractional object number', () => pdfReference(1.5, 0)],
    ['a generation one above the range', () => pdfReference(1, 65_536)],
    ['a negative generation', () => pdfReference(1, -1)],
    ['a fractional generation', () => pdfReference(1, 0.5)],
    ['a literal string character above ASCII', () => pdfLiteralString('\u0080')],
  ] as const)('rejects %s', (_, build) => {
    expect(build).toThrow(InvalidArgumentError);
  });
});

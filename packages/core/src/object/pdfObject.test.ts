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
    expect(pdfNameFromBytes(new Uint8Array([0x82, 0xa0])).bytes).toStrictEqual(new Uint8Array([0x82, 0xa0]));
    for (const name of ['a b', 'é', '\0', '\t']) expect(() => pdfName(name)).toThrow(InvalidArgumentError);
    expect(() => pdfNameFromBytes(new Uint8Array([0])).bytes).toThrow(InvalidArgumentError);
    expect(() => pdfNameFromBytes(new Uint8Array(128))).toThrow(InvalidArgumentError);
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
    const first = new Uint8Array([65]);
    const second = new Uint8Array([66]);
    entries.set(first, pdfInteger(1));
    entries.set(second, { kind: 'null' });
    expect(entries.get(second)).toBeUndefined();
    expect([entries.has(second), entries.size]).toStrictEqual([false, 1]);
    entries.set(first, pdfInteger(2));
    expect([...entries.entries()].map(([key]) => key)).toStrictEqual([first]);
    entries.set(second, pdfInteger(3));
    expect([...entries.entries()].map(([key]) => key)).toStrictEqual([first, second]);
    expect([entries.delete(first), entries.size]).toStrictEqual([true, 1]);
  });

  it('constructs plain discriminated objects and checks numeric ranges', () => {
    expect(pdfString(new Uint8Array([1]))).toStrictEqual({ kind: 'string', bytes: new Uint8Array([1]), encoding: 'literal' });
    expect(pdfLiteralString('ABC').bytes).toStrictEqual(new Uint8Array([65, 66, 67]));
    expect(pdfArray([pdfReal(0.5)])).toStrictEqual({ kind: 'array', items: [{ kind: 'real', value: 0.5 }] });
    expect(pdfDictionary().entries.size).toBe(0);
    expect(pdfReference(7, 2)).toStrictEqual({ kind: 'reference', objectNumber: 7, generation: 2 });
  });

  it('rejects invalid object inputs', () => {
    expect(() => pdfLiteralString('é')).toThrow(InvalidArgumentError);
    expect(() => pdfInteger(1.5)).toThrow(InvalidArgumentError);
    expect(() => pdfReal(Infinity)).toThrow(InvalidArgumentError);
    expect(() => pdfReal({ numerator: 1n, denominator: 0n })).toThrow(InvalidArgumentError);
    expect(() => pdfReference(0, 0)).toThrow(InvalidArgumentError);
  });
});

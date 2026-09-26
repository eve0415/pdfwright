import { describe, expect, it } from 'vitest';

import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfNameFromBytes, pdfReal, pdfReference, pdfString } from '../object/pdfObject.ts';

import { serializeObject } from './serializeObject.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const write = (object: Parameters<typeof serializeObject>[0]): string => ascii(serializeObject(object, { fractionDigits: 5 }));
const xor = (left: number, right: number): number => {
  let result = 0;
  let place = 1;
  for (let index = 0; index < 32; index++) {
    if (Math.floor(left / place) % 2 !== Math.floor(right / place) % 2) result += place;
    place *= 2;
  }
  return result;
};

describe('object serialization', () => {
  it('writes primitive objects and arrays', () => {
    expect(write({ kind: 'null' })).toBe('null');
    expect(write({ kind: 'boolean', value: false })).toBe('false');
    expect(write(pdfInteger(-5))).toBe('-5');
    expect(write(pdfReal(0.000015))).toBe('0.00002');
    const array = pdfArray([pdfInteger(1), pdfName('X'), { kind: 'null' }]);
    expect(write(array)).toBe('[1 /X null]');
  });

  it('escapes names without losing their original bytes', () => {
    const special = pdfNameFromBytes(new Uint8Array([0x41, 0x23, 0x20, 0xff]));
    const shiftJis = pdfNameFromBytes(new Uint8Array([0x82, 0xa0]));
    const delimiters = pdfNameFromBytes(new Uint8Array([0x28, 0x29, 0x2f, 0x25]));
    expect(write(special)).toBe('/A#23#20#FF');
    expect(write(shiftJis)).toBe('/#82#A0');
    expect(write(delimiters)).toBe('/#28#29#2F#25');
    expect(write(pdfName(''))).toBe('/');
  });

  it('writes literal and hex strings with exact escapes', () => {
    const controls = pdfString(new Uint8Array([0x0d, 0x0a, 0x09, 0x08, 0x0c]));
    const escaped = pdfString(new Uint8Array([0x5c, 0x28, 0x29, 0x00, 0xff]));
    const hex = pdfString(new Uint8Array([0x00, 0xff]), 'hex');
    expect(write(controls)).toBe(String.raw`(\r\n\t\b\f)`);
    expect(write(escaped)).toBe(String.raw`(\\\(\)\000\377)`);
    expect(write(hex)).toBe('<00FF>');
  });

  it('skips null entries and keeps dictionary insertion order', () => {
    const entries = new PdfDictionaryEntries();
    entries.set(pdfName('A').bytes, pdfInteger(1));
    entries.set(pdfName('Ignored').bytes, { kind: 'null' });
    entries.set(pdfName('B').bytes, pdfReference(2, 0));
    expect(write(pdfDictionary(entries))).toBe('<</A 1/B 2 0 R>>');
  });

  it('writes streams with encoded byte lengths and LF line endings', () => {
    const entries = new PdfDictionaryEntries();
    entries.set(pdfName('Length').bytes, pdfInteger(999));
    expect(write({ kind: 'stream', dictionary: entries, data: new Uint8Array([65, 66]) })).toBe('<</Length 2>>\nstream\nAB\nendstream');
    expect(entries.get(pdfName('Length').bytes)).toStrictEqual(pdfInteger(999));
  });

  it('never writes exponent notation for real values', () => {
    let state = 123456789;
    for (let index = 0; index < 10_000; index++) {
      state = xor(state, (state * 8192) % 4294967296);
      state = xor(state, Math.floor(state / 131072));
      state = xor(state, (state * 32) % 4294967296);
      const value = (state / 4294967296) * 10 ** ((index % 20) - 8);
      expect(write(pdfReal(value))).not.toMatch(/[eE]/u);
    }
  });
});

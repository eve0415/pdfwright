import type { PdfDirectObject } from '../object/pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { formatLength, mm, pt } from '../length/length.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfNameFromBytes, pdfReal, pdfReference, pdfString } from '../object/pdfObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';

import { serializeObject } from './serializeObject.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const write = (object: Parameters<typeof serializeObject>[0]): string => ascii(serializeObject(object, { fractionDigits: 5 }));
const xor = (left: number, right: number): number => {
  let result = 0;
  let place = 1;
  for (let index = 0; index < 32; index++) {
    if (Math.floor(left / place) % 2 !== Math.floor(right / place) % 2) {
      result += place;
    }
    place *= 2;
  }
  return result;
};

describe('object serialization', () => {
  it('writes primitive objects and arrays', () => {
    expect(write({ kind: 'null' })).toBe('null');
    expect(write({ kind: 'boolean', value: false })).toBe('false');
    expect(write({ kind: 'boolean', value: true })).toBe('true');
    expect(write(pdfInteger(-5))).toBe('-5');
    expect(write(pdfReal(0.000015))).toBe('0.00002');
    const array = pdfArray([pdfInteger(1), pdfName('X'), { kind: 'null' }]);
    expect(write(array)).toBe('[1 /X null]');
  });

  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [2_147_483_647, '2147483647'],
    [-2_147_483_647, '-2147483647'],
  ])('writes an in-range whole real %s as the integer token %s', (value, expected) => {
    for (const fractionDigits of [0, 5, 10]) {
      for (const real of [pdfReal(value), pdfReal(pt(value))]) {
        expect(ascii(serializeObject(real, { fractionDigits }))).toBe(expected);
      }
    }
  });

  it.each([
    [2_147_483_648, '2147483648.0'],
    [-2_147_483_648, '-2147483648.0'],
    [3e9, '3000000000.0'],
    [-3e9, '-3000000000.0'],
    [1e21, '1000000000000000000000.0'],
    [3.403e38, '340300000000000000000000000000000000000.0'],
  ])('preserves the real type of %s as %s', (value, expected) => {
    for (const fractionDigits of [0, 5, 10]) {
      for (const real of [pdfReal(value), pdfReal(pt(value))]) {
        const bytes = serializeObject(real, { fractionDigits });
        expect(ascii(bytes)).toBe(expected);
        const lexer = new Lexer({ bytes, base: 0, final: true }, 0, { names: new Map(), warn: warning => expect.unreachable(warning.detail) });
        const parsed = parseObject(lexer, 256);
        const expectedReal = pdfReal(Number(expected));
        expect(parsed).toStrictEqual(expectedReal);
      }
    }
  });

  it.each([
    [2.5, 0, '2'],
    [-0.000005, 5, '0'],
    [2_147_483_647.4, 0, '2147483647'],
    [-2_147_483_647.4, 0, '-2147483647'],
    [2_147_483_647.5, 0, '2147483648.0'],
    [-2_147_483_647.5, 0, '-2147483648.0'],
    [2_147_483_648.5, 5, '2147483648.5'],
    [-2_147_483_648.5, 5, '-2147483648.5'],
  ])('writes the rounded value of %s at %i digits as %s', (value, fractionDigits, expected) => {
    for (const real of [pdfReal(value), pdfReal(pt(value))]) {
      expect(ascii(serializeObject(real, { fractionDigits }))).toBe(expected);
    }
  });

  it('writes invalid tokens verbatim, separated from what precedes them', () => {
    const bytes = new TextEncoder().encode('--300');
    const invalid = { kind: 'invalid', bytes, reason: 'malformed-number' } as const;
    const entries = new PdfDictionaryEntries([[pdfName('Count').bytes, invalid]]);
    const array = pdfArray([pdfInteger(1), invalid]);
    expect(write(array)).toBe('[1 --300]');
    expect(write(pdfDictionary(entries))).toBe('<</Count --300>>');
  });

  it('rejects invalid tokens that are not one run of regular characters', () => {
    for (const text of ['', '1 2', '1/2', '(x)', '%', '\n']) {
      const bytes = new TextEncoder().encode(text);
      expect(() => write({ kind: 'invalid', bytes, reason: 'malformed-number' })).toThrow(InvalidArgumentError);
    }
  });

  it('escapes names without losing their original bytes', () => {
    const special = pdfNameFromBytes(new Uint8Array([0x41, 0x23, 0x20, 0xff]));
    const shiftJis = pdfNameFromBytes(new Uint8Array([0x82, 0xa0]));
    const delimiters = pdfNameFromBytes(new Uint8Array([0x28, 0x29, 0x2f, 0x25]));
    expect(write(special)).toBe('/A#23#20#FF');
    expect(write(shiftJis)).toBe('/#82#A0');
    expect(write(delimiters)).toBe('/#28#29#2F#25');
    expect(write(pdfNameFromBytes(new Uint8Array([0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x7f])))).toBe('/#3C#3E#5B#5D#7B#7D#7F');
    expect(write(pdfNameFromBytes(new Uint8Array([0x21, 0x7e])))).toBe('/!~');
    expect(write(pdfName(''))).toBe('/');
  });

  it('rejects hand-built names with a null byte or more than 127 bytes', () => {
    expect(() => write({ kind: 'name', bytes: new Uint8Array([0x41, 0]) })).toThrow(InvalidArgumentError);
    expect(() => write({ kind: 'name', bytes: new Uint8Array(128).fill(0x41) })).toThrow(InvalidArgumentError);
    expect(write({ kind: 'name', bytes: new Uint8Array(127).fill(0x41) })).toBe(`/${'A'.repeat(127)}`);
  });

  it('writes literal and hex strings with exact escapes', () => {
    const controls = pdfString(new Uint8Array([0x0d, 0x0a, 0x09, 0x08, 0x0c]));
    const escaped = pdfString(new Uint8Array([0x5c, 0x28, 0x29, 0x00, 0xff]));
    const hex = pdfString(new Uint8Array([0x00, 0xff]), 'hex');
    expect(write(controls)).toBe(String.raw`(\r\n\t\b\f)`);
    expect(write(escaped)).toBe(String.raw`(\\\(\)\000\377)`);
    expect(write(hex)).toBe('<00FF>');
  });

  // ISO 32000-1:2008, 7.3.4.2: bytes outside the printable range 0x20 to 0x7e are written as octal escapes.
  it.each([
    [[0x1f], String.raw`(\037)`],
    [[0x20], '( )'],
    [[0x7e], '(~)'],
    [[0x7f], String.raw`(\177)`],
    [[], '()'],
  ])('writes the literal string of bytes %o as %s', (bytes, expected) => {
    expect(write(pdfString(Uint8Array.from(bytes)))).toBe(expected);
  });

  it('writes an empty hex string', () => {
    expect(write(pdfString(new Uint8Array(), 'hex'))).toBe('<>');
  });

  // ISO 32000-1:2008, 7.2.2: a name followed by a regular character would read as a longer name, so such values are separated by a space.
  it('separates dictionary values that start with a regular character from their key', () => {
    const invalid = { kind: 'invalid', bytes: new TextEncoder().encode('--1'), reason: 'malformed-number' } as const;
    const entries = new PdfDictionaryEntries([
      [pdfName('A').bytes, { kind: 'boolean', value: true }],
      [pdfName('B').bytes, pdfReal(1.5)],
      [pdfName('C').bytes, pdfReference(2, 0)],
      [pdfName('D').bytes, invalid],
      [pdfName('E').bytes, pdfName('N')],
      [pdfName('F').bytes, pdfArray([pdfInteger(1)])],
      [pdfName('G').bytes, pdfDictionary()],
      [pdfName('H').bytes, pdfString(new Uint8Array([0x78]))],
      [pdfName('I').bytes, pdfString(new Uint8Array([0]), 'hex')],
    ]);
    expect(write(pdfDictionary(entries))).toBe('<</A true/B 1.5/C 2 0 R/D --1/E/N/F[1]/G<<>>/H(x)/I<00>>>');
  });

  it('nests arrays and dictionaries', () => {
    const inner = new PdfDictionaryEntries([[pdfName('A').bytes, pdfInteger(1)]]);
    expect(write(pdfArray([pdfArray([pdfInteger(1)]), pdfDictionary(inner)]))).toBe('[[1] <</A 1>>]');
  });

  it('rejects a hand-built reference outside the integer range', () => {
    expect(() => write({ kind: 'reference', objectNumber: 2_147_483_648, generation: 0 })).toThrow(InvalidArgumentError);
    expect(write({ kind: 'reference', objectNumber: 2_147_483_647, generation: 0 })).toBe('2147483647 0 R');
  });

  it('skips null entries and keeps dictionary insertion order', () => {
    const entries = new PdfDictionaryEntries();
    entries.set(pdfName('B').bytes, pdfReference(2, 0));
    entries.set(pdfName('Ignored').bytes, { kind: 'null' });
    entries.set(pdfName('A').bytes, pdfInteger(1));
    expect(write(pdfDictionary(entries))).toBe('<</B 2 0 R/A 1>>');
  });

  it('rejects a stream nested in an array or dictionary', () => {
    const stream = { kind: 'stream', dictionary: new PdfDictionaryEntries(), data: new Uint8Array([65]) } as const;
    // @ts-expect-error ISO 32000-1:2008, 7.3.8.1 requires every stream to be an indirect object, so array items exclude streams.
    expect(() => write(pdfArray([stream]))).toThrow(InvalidArgumentError);
    const entries = new PdfDictionaryEntries();
    // @ts-expect-error Dictionary values exclude streams for the same reason.
    entries.set(pdfName('Data').bytes, stream);
    expect(() => write(pdfDictionary(entries))).toThrow(InvalidArgumentError);
    expect(() => write({ kind: 'stream', dictionary: entries, data: new Uint8Array() })).toThrow(InvalidArgumentError);
  });

  it('writes streams with encoded byte lengths and LF line endings', () => {
    const entries = new PdfDictionaryEntries();
    entries.set(pdfName('Length').bytes, pdfInteger(999));
    expect(write({ kind: 'stream', dictionary: entries, data: new Uint8Array([65, 66]) })).toBe('<</Length 2>>\nstream\nAB\nendstream');
    expect(entries.get(pdfName('Length').bytes)).toStrictEqual(pdfInteger(999));
  });

  it('writes an empty stream, and keeps a caller Length in its place among the other entries', () => {
    expect(write({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: new Uint8Array() })).toBe('<</Length 0>>\nstream\n\nendstream');
    const entries = new PdfDictionaryEntries([
      [pdfName('Type').bytes, pdfName('XObject')],
      [pdfName('Length').bytes, pdfInteger(999)],
      [pdfName('Filter').bytes, pdfName('FlateDecode')],
    ]);
    expect(write({ kind: 'stream', dictionary: entries, data: new Uint8Array([65, 66]) })).toBe(
      '<</Type/XObject/Length 2/Filter/FlateDecode>>\nstream\nAB\nendstream',
    );
  });

  it('writes a length real from its exact value, rounded once', () => {
    const kilometre = mm(1_000_000);
    const written = ascii(serializeObject(pdfReal(kilometre), { fractionDigits: 10 }));
    expect([written, formatLength(kilometre, 10)]).toStrictEqual(['2834645.6692913386', '2834645.6692913386']);
    const a4Width = pdfReal(mm(210));
    expect(write(a4Width)).toBe('595.27559');
  });

  it('never writes exponent notation for real values', () => {
    let state = 123_456_789;
    for (let index = 0; index < 10_000; index++) {
      state = xor(state, (state * 8192) % 4_294_967_296);
      state = xor(state, Math.floor(state / 131_072));
      state = xor(state, (state * 32) % 4_294_967_296);
      const value = (state / 4_294_967_296) * 10 ** ((index % 20) - 8);
      expect(write(pdfReal(value))).not.toMatch(/[eE]/u);
    }
  });
});

describe('properties', () => {
  // ISO 32000-1:2008, 7.3.4.2 and 7.3.5: bytes that need an escape in a literal string or a name are drawn as often as all the others together.
  const escaped = fc.constantFrom(0x23, 0x28, 0x29, 0x5c, 0x25, 0x2f, 0x0a, 0x0d);
  const name = fc.array(fc.oneof(escaped, fc.integer({ min: 1, max: 255 })), { maxLength: 127 }).map(bytes => pdfNameFromBytes(Uint8Array.from(bytes)));
  const direct = fc.letrec<{ object: PdfDirectObject }>(tie => ({
    object: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.boolean().map(value => ({ kind: 'boolean', value }) as const),
      fc.integer({ min: -2_147_483_647, max: 2_147_483_647 }).map(value => pdfInteger(value)),
      name,
      fc
        .tuple(fc.array(fc.oneof(escaped, fc.integer({ min: 0, max: 255 })), { maxLength: 40 }), fc.constantFrom('literal', 'hex'))
        .map(([bytes, encoding]) => pdfString(Uint8Array.from(bytes), encoding)),
      fc
        .tuple(fc.integer({ min: 1, max: 2_147_483_647 }), fc.integer({ min: 0, max: 65_535 }))
        .map(([objectNumber, generation]) => pdfReference(objectNumber, generation)),
      fc.array(tie('object'), { maxLength: 5 }).map(items => pdfArray(items)),
      fc
        .uniqueArray(fc.tuple(name, tie('object')), { maxLength: 5, selector: ([key]) => ascii(key.bytes) })
        .map(pairs => pdfDictionary(new PdfDictionaryEntries(pairs.map(([key, value]) => [key.bytes, value])))),
    ),
  })).object;

  it('reads back every direct object it writes', () => {
    fc.assert(
      fc.property(direct, object => {
        const bytes = serializeObject(object, { fractionDigits: 5 });
        const lexer = new Lexer({ bytes, base: 0, final: true }, 0, { names: new Map(), warn: warning => expect.unreachable(warning.detail) });
        expect(parseObject(lexer, 256)).toStrictEqual(object);
      }),
    );
  });
});

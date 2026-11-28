import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { latin1Bytes } from '../../testing/pdfBuilder.ts';

import { decodeTextString } from './textUnits.ts';

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../gu) ?? [], pair => Number.parseInt(pair, 16));

// The UTF-16BE code units of a text, high byte first.
const utf16 = (text: string): Array<number> =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)).flatMap(unit => [unit >> 8, unit & 0xff]);

// 7.9.2.2: a language escape is U+001B, the codes as ASCII bytes, and U+001B.
const escaped = (codes: string): Array<number> => [0x00, 0x1b, ...Array.from(codes, character => character.charCodeAt(0)), 0x00, 0x1b];

describe('text strings', () => {
  it('decodes PDFDocEncoding, with undefined codes as U+FFFD', () => {
    // Annex D, D.3: code 0x93 is U+FB01 and 0x7F is undefined.
    expect(decodeTextString(Uint8Array.of(0x41, 0x93, 0x7f))).toStrictEqual({ text: 'Aﬁ�', language: undefined });
  });

  it('decodes every byte of a PDFDocEncoding string as one character', () => {
    const lengths = Array.from({ length: 256 }, (_, byte) => Array.from(decodeTextString(Uint8Array.of(byte)).text).length);
    expect(lengths).toStrictEqual(Array.from({ length: 256 }, () => 1));
  });

  it('decodes UTF-16BE after the byte order marker, with surrogate pairs', () => {
    expect(decodeTextString(hex('feff5c71d842dfb7'))).toStrictEqual({ text: '山𠮷', language: undefined });
  });

  it('removes language escapes and reports the first one', () => {
    // 7.9.2.2: U+001B, a 2-byte ISO 639 code, an optional 2-byte ISO 3166 code, and U+001B.
    expect(decodeTextString(hex('feff001b6a614a50001b845bdb40dd00001b656e001b0041'))).toStrictEqual({ text: '葛󠄀A', language: 'ja-JP' });
  });

  it.each([
    // 7.9.2.2: the country code is optional, so an escape may close after the language code alone.
    ['a language code without a country code', 'feff001b6a61001b5c71', { text: '山', language: 'ja' }],
    // An escape whose codes are not ISO 639 letters is still removed, and names no language.
    ['codes that are not letters', 'feff001b3132001b5c71', { text: '山', language: undefined }],
    // An escape that never closes is not an escape: its code units stay in the text.
    ['no closing escape', 'feff001b6a61', { text: '\u001B橡', language: undefined }],
  ] as const)('reads an escape with %s', (_, bytes, expected) => {
    expect(decodeTextString(hex(bytes))).toStrictEqual(expected);
  });

  it('drops an odd byte after the last UTF-16 code unit', () => {
    expect(decodeTextString(hex('feff5c7100'))).toStrictEqual({ text: '山', language: undefined });
  });

  it('keeps a byte order marker without text as empty text', () => {
    expect(decodeTextString(latin1Bytes('þÿ'))).toStrictEqual({ text: '', language: undefined });
  });
});

describe('properties', () => {
  // Any text without U+001B, astral characters included and lone surrogates excluded.
  const text = fc.string({ unit: 'binary', maxLength: 20 }).filter(value => !value.includes('\u001B'));
  // 7.9.2.2: a 2-byte ISO 639 language code and an optional 2-byte ISO 3166 country code, as ASCII.
  const code = fc.stringMatching(/^[A-Za-z]{2}(?:[A-Za-z]{2})?$/u);

  it('decodes the UTF-16BE of any text without escapes to that text', () => {
    fc.assert(
      fc.property(text, value => {
        expect(decodeTextString(Uint8Array.from([0xfe, 0xff, ...utf16(value)]))).toStrictEqual({ text: value, language: undefined });
      }),
    );
  });

  it('removes language escapes between any characters and reports the first', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(text, fc.option(code, { nil: undefined })), { maxLength: 6 }), parts => {
        const bytes = [0xfe, 0xff, ...parts.flatMap(([chunk, escape]) => [...utf16(chunk), ...(escape === undefined ? [] : escaped(escape))])];
        const first = parts.find(([, escape]) => escape !== undefined)?.[1];
        const language = first === undefined || first.length === 2 ? first : `${first.slice(0, 2)}-${first.slice(2)}`;
        expect(decodeTextString(Uint8Array.from(bytes))).toStrictEqual({ text: parts.map(([chunk]) => chunk).join(''), language });
      }),
    );
  });
});

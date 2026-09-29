import { describe, expect, it } from 'vitest';

import { isDelimiter, isRegular, isWhitespace } from './characterClass.ts';

describe('pdf character classes', () => {
  it('classifies the six white-space bytes of Table 1', () => {
    const whitespace = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
    for (let byte = 0; byte < 256; byte++) expect([byte, isWhitespace(byte)]).toStrictEqual([byte, whitespace.has(byte)]);
  });

  it('classifies the ten delimiters of Table 2', () => {
    const delimiters = new Set(Array.from('()<>[]{}/%', character => character.codePointAt(0)));
    for (let byte = 0; byte < 256; byte++) expect([byte, isDelimiter(byte)]).toStrictEqual([byte, delimiters.has(byte)]);
  });

  it('treats every other byte as regular, including bytes above 0x7F', () => {
    expect([isRegular(0x41), isRegular(0x23), isRegular(0x80), isRegular(0xff)]).toStrictEqual([true, true, true, true]);
    expect([isRegular(0x20), isRegular(0x2f), isRegular(0x00)]).toStrictEqual([false, false, false]);
  });
});

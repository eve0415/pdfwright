import { describe, expect, it } from 'vitest';

import { isFullWidthOrWide } from './fullWidth.ts';

const wide = (text: string): Array<boolean> => Array.from(text, character => isFullWidthOrWide(character.codePointAt(0) ?? 0));

describe('full-width and wide characters', () => {
  it('samples the characters Unicode 18.0.0 marks F or W, and others it does not', () => {
    // EastAsianWidth.txt: Ａ and ！ are F; 山, あ, ヤ, ・, 、 and 𠮷 are W; A, 1, ｶ and ･ are Na or H, and ‧ is A.
    expect([wide('Ａ！山あヤ・、𠮷'), wide('A1ｶ･‧')]).toStrictEqual([
      [true, true, true, true, true, true, true, true],
      [false, false, false, false, false],
    ]);
  });

  it.each([
    // EastAsianWidth.txt ranges FF01..FF60 (F), 3041..3096 (W) and 2FF0..303E (W); U+FF00 and U+3097 are unassigned, U+3040 too, U+FF61 is H and U+303F is N.
    ['the first of FF01..FF60', 0xff_01, true],
    ['the code point before FF01..FF60', 0xff_00, false],
    ['the last of FF01..FF60', 0xff_60, true],
    ['the code point after FF01..FF60', 0xff_61, false],
    ['the first of 3041..3096', 0x30_41, true],
    ['the code point before 3041..3096', 0x30_40, false],
    ['the last of 3041..3096', 0x30_96, true],
    ['the code point after 3041..3096', 0x30_97, false],
    ['the last of 2FF0..303E', 0x30_3e, true],
    ['the code point after 2FF0..303E', 0x30_3f, false],
  ])('includes both ends of a range: %s', (_, codePoint, expected) => {
    expect(isFullWidthOrWide(codePoint)).toBe(expected);
  });
});

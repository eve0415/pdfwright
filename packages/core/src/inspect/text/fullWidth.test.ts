import { describe, expect, it } from 'vitest';

import { isFullWidthOrWide } from './fullWidth.ts';

const wide = (text: string): boolean[] => Array.from(text, character => isFullWidthOrWide(character.codePointAt(0) ?? 0));

describe('full-width and wide characters', () => {
  it('lists the characters Unicode 18.0.0 marks F or W, and no others', () => {
    // EastAsianWidth.txt: Ａ and ！ are F; 山, あ, ヤ, ・, 、 and 𠮷 are W; A, 1, ｶ and ･ are Na or H, and ‧ is A.
    expect([wide('Ａ！山あヤ・、𠮷'), wide('A1ｶ･‧')]).toStrictEqual([
      [true, true, true, true, true, true, true, true],
      [false, false, false, false, false],
    ]);
  });
});

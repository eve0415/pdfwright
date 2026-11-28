import { describe, expect, it } from 'vitest';

import { hasVerticalAlternate } from './verticalAlternates.ts';

const alternates = (text: string): Array<boolean> => Array.from(text, character => hasVerticalAlternate(character.codePointAt(0) ?? 0));

describe('vertical alternates', () => {
  it('samples the characters Unicode 18.0.0 marks Tu or Tr, and others it does not', () => {
    // VerticalOrientation.txt: 、 and 。 are Tu, 「 and ー Tr, the full-width ！ Tu and （ Tr; ・, Ａ, 1, A and 山 are U or R.
    expect([alternates('、。「」ー（！'), alternates('・Ａ1A山')]).toStrictEqual([
      [true, true, true, true, true, true, true],
      [false, false, false, false, false],
    ]);
  });
});

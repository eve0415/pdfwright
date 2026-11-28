import type { EmbeddedCmap } from './glyphEvidence.ts';

import { describe, expect, it } from 'vitest';

import { cmapEvidence, variantConfirmed } from './glyphEvidence.ts';

// A cmap that maps 葛 (U+845B) to glyph 4 and a (U+0061) to glyph 9; its format 14 entries give 葛 with U+E0100 glyph 5, with U+E0101 the default glyph, and 辻 (U+8FBB), which it does not map, with U+E0100 glyph 6.
const GLYPHS: ReadonlyMap<number, number> = new Map([
  [0x84_5b, 4],
  [0x61, 9],
]);
const VARIANTS: ReadonlyMap<string, number | 'default'> = new Map<string, number | 'default'>([
  ['845b e0100', 5],
  ['845b e0101', 'default'],
  ['8fbb e0100', 6],
]);
const CMAP: EmbeddedCmap = {
  glyph: codePoint => GLYPHS.get(codePoint),
  characters: glyph => [...GLYPHS].flatMap(([codePoint, mapped]) => (mapped === glyph ? [codePoint] : [])),
  variant: (codePoint, selector) => VARIANTS.get(`${codePoint.toString(16)} ${selector.toString(16)}`),
};

describe('glyph evidence', () => {
  it.each([
    ['a character the cmap maps to the glyph drawn', 4, '葛', { kind: 'confirmed' }],
    ['a character the cmap maps to another glyph', 5, '葛', { kind: 'disagrees', expected: 4 }],
    ['a character the cmap does not map', 4, '辻', { kind: 'silent' }],
    ['no text', 4, '', { kind: 'silent' }],
    ['two characters', 9, 'ab', { kind: 'silent' }],
    ['a character followed by one that is not a variation selector', 4, '葛a', { kind: 'silent' }],
    ['a base, a selector and a third character', 5, '葛\u{E0100}a', { kind: 'silent' }],
    ['a variation sequence the format 14 subtable maps to the glyph drawn', 5, '葛\u{E0100}', { kind: 'confirmed' }],
    ['a variation sequence mapped to another glyph', 4, '葛\u{E0100}', { kind: 'disagrees', expected: 5 }],
    ['a sequence that uses the default glyph, the base character’s', 4, '葛\u{E0101}', { kind: 'confirmed' }],
    ['a default sequence against a variant glyph', 5, '葛\u{E0101}', { kind: 'disagrees', expected: 4 }],
    ['a sequence the subtable does not list', 4, '葛\u{FE00}', { kind: 'silent' }],
  ] as const)('reads %s', (_, drawn, text, expected) => {
    expect(cmapEvidence(CMAP, drawn, text)).toStrictEqual(expected);
  });

  it.each([
    ['a variant glyph', 0x84_5b, 0xe_01_00, 5, true],
    ['another glyph than the variant', 0x84_5b, 0xe_01_00, 4, false],
    ['the default glyph', 0x84_5b, 0xe_01_01, 4, true],
    ['a variant of a base the cmap does not map', 0x8f_bb, 0xe_01_00, 6, true],
    ['a sequence not listed, of a base the cmap does not map', 0x8f_bb, 0xe_01_01, 6, false],
    ['a sequence not listed, against the base character’s glyph', 0x84_5b, 0xfe_00, 4, false],
  ] as const)('confirms a variation sequence by %s', (_, base, selector, drawn, expected) => {
    expect(variantConfirmed(CMAP, drawn, [base, selector])).toBe(expected);
  });
});

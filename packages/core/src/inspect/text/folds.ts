import { EQUIVALENT_UNIFIED_IDEOGRAPHS } from './equivalentIdeographs.ts';

/**
 * A fold matchText applies to the text a page shows, never to the intended text, for characters a font can draw in place of the intended ones.
 * `radicals` reads CJK radicals and strokes as their equivalent unified ideographs, `vertical-forms` reads vertical presentation forms as the characters they stand for, `ligatures` reads Latin ligatures as their letters, and `shared-glyphs` reads U+2027 HYPHENATION POINT as U+30FB KATAKANA MIDDLE DOT.
 */
export type TextFold = 'radicals' | 'vertical-forms' | 'ligatures' | 'shared-glyphs';

/** Every fold, in the order they are tried. */
export const TEXT_FOLDS: readonly TextFold[] = ['radicals', 'vertical-forms', 'ligatures', 'shared-glyphs'];

// Noto Sans JP draws U+2F2C and U+2F3E, and Noto Serif JP U+2F2A, with the glyph of a different ideograph than the one the table gives, so a glyph mapped to them may show another character.
const RADICAL_EXCEPTIONS = new Set([0x2f2a, 0x2f2c, 0x2f3e]);

const RADICALS: ReadonlyMap<number, string> = new Map(
  EQUIVALENT_UNIFIED_IDEOGRAPHS.split('\n').flatMap(line => {
    const [from = '', to = ''] = line.split(';');
    const codePoint = Number.parseInt(from, 16);
    return RADICAL_EXCEPTIONS.has(codePoint) ? [] : [[codePoint, String.fromCodePoint(Number.parseInt(to, 16))] as const];
  }),
);

// The full-width form of an ASCII character, U+FF01–U+FF5E, is the ASCII code point plus 0xFEE0.
const FULL_WIDTH_OFFSET = 0xfee0;

// The Unicode Character Database's decompositions tagged <vertical> that give one character, U+FE10–U+FE19, U+FE30–U+FE44, U+FE47 and U+FE48; U+309F and U+30FF, whose decompositions are two characters, are not folded.
// A form whose decomposition is an ASCII character is read as its full-width form: in vertical CJK text Chromium's ActualText gives the full-width character over these forms, while an ASCII character in vertical text is set sideways rather than as a presentation form.
const VERTICAL_FORMS: ReadonlyMap<number, string> = new Map(
  [
    'FE10 002C',
    'FE11 3001',
    'FE12 3002',
    'FE13 003A',
    'FE14 003B',
    'FE15 0021',
    'FE16 003F',
    'FE17 3016',
    'FE18 3017',
    'FE19 2026',
    'FE30 2025',
    'FE31 2014',
    'FE32 2013',
    'FE33 005F',
    'FE34 005F',
    'FE35 0028',
    'FE36 0029',
    'FE37 007B',
    'FE38 007D',
    'FE39 3014',
    'FE3A 3015',
    'FE3B 3010',
    'FE3C 3011',
    'FE3D 300A',
    'FE3E 300B',
    'FE3F 3008',
    'FE40 3009',
    'FE41 300C',
    'FE42 300D',
    'FE43 300E',
    'FE44 300F',
    'FE47 005B',
    'FE48 005D',
  ].map(pair => {
    const [from = '', to = ''] = pair.split(' ');
    const target = Number.parseInt(to, 16);
    return [Number.parseInt(from, 16), String.fromCodePoint(target < 0x80 ? target + FULL_WIDTH_OFFSET : target)] as const;
  }),
);

// The Alphabetic Presentation Forms ligatures U+FB00–U+FB06 and the letters each joins.
const LIGATURES: ReadonlyMap<number, string> = new Map([
  [0xfb00, 'ff'],
  [0xfb01, 'fi'],
  [0xfb02, 'fl'],
  [0xfb03, 'ffi'],
  [0xfb04, 'ffl'],
  [0xfb05, 'ſt'],
  [0xfb06, 'st'],
]);

// Noto Sans JP draws U+2027 and U+30FB with one glyph, and Chromium's ToUnicode gives U+2027 for a katakana middle dot set vertically.
const SHARED_GLYPHS: ReadonlyMap<number, string> = new Map([[0x2027, '・']]);

const TABLES: Readonly<Record<TextFold, ReadonlyMap<number, string>>> = {
  radicals: RADICALS,
  'vertical-forms': VERTICAL_FORMS,
  ligatures: LIGATURES,
  'shared-glyphs': SHARED_GLYPHS,
};

/** A fold applied to one character. */
export interface FoldUse {
  readonly fold: TextFold;
  readonly from: string;
  readonly to: string;
}

/** The character a fold reads a code point as, or undefined when the fold leaves it alone. */
export const foldOf = (fold: TextFold, codePoint: number): string | undefined => TABLES[fold].get(codePoint);

/** A text with folds applied, and each fold used. */
export interface FoldedText {
  readonly text: string;
  readonly uses: readonly FoldUse[];
}

/** Applies the folds to each code point of a text, and lists each fold used. */
export const foldText = (text: string, folds: readonly TextFold[]): FoldedText => {
  const uses: FoldUse[] = [];
  const folded = Array.from(text, character => {
    const codePoint = character.codePointAt(0) ?? 0;
    for (const fold of folds) {
      const to = foldOf(fold, codePoint);
      if (to !== undefined) {
        uses.push({ fold, from: character, to });
        return to;
      }
    }
    return character;
  });
  return { text: folded.join(''), uses };
};

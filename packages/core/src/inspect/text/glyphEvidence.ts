import type { TrueTypeCmap } from '../../font/trueType/cmapTable.ts';

/** The Unicode `cmap` subtable of a font's embedded TrueType program: the glyph index it maps a code point to, and for a variation sequence its format 14 entry (the OpenType specification's `cmap` chapter). */
export type EmbeddedCmap = Pick<TrueTypeCmap, 'glyph' | 'characters' | 'variant'>;

/** What an embedded cmap says about a drawn glyph: it maps the glyph's text to that glyph, it maps it to another glyph, or it says nothing. */
export type CmapEvidence = { readonly kind: 'confirmed' } | { readonly kind: 'silent' } | { readonly kind: 'disagrees'; readonly expected: number };

const isSelector = (codePoint: number): boolean => (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);

// The glyph a cmap gives a base character with a variation selector: the variant's own glyph, or the base character's glyph when the sequence uses the default one.
const variantGlyph = (cmap: EmbeddedCmap, base: number, selector: number): number | undefined => {
  const variant = cmap.variant(base, selector);
  return variant === 'default' ? cmap.glyph(base) : variant;
};

/**
 * Checks a drawn glyph against the cmap of its font's program, for text that is one character, optionally followed by one variation selector: the cmap must map it to the glyph drawn.
 * Text of several characters (a ligature's letters) and characters the cmap does not map give no evidence, since a subset's cmap lists only the characters mapped back from its glyphs.
 */
export const cmapEvidence = (cmap: EmbeddedCmap, drawn: number, text: string): CmapEvidence => {
  const codePoints = Array.from(text, character => character.codePointAt(0) ?? 0);
  const [base, selector, ...rest] = codePoints;
  if (base === undefined || rest.length > 0 || (selector !== undefined && !isSelector(selector))) return { kind: 'silent' };
  const expected = selector === undefined ? cmap.glyph(base) : variantGlyph(cmap, base, selector);
  if (expected === undefined) return { kind: 'silent' };
  return expected === drawn ? { kind: 'confirmed' } : { kind: 'disagrees', expected };
};

/** Whether the cmap's format 14 subtable maps a base character with a variation selector to the glyph drawn. */
export const variantConfirmed = (cmap: EmbeddedCmap, drawn: number, [base, selector]: readonly [number, number]): boolean =>
  variantGlyph(cmap, base, selector) === drawn;

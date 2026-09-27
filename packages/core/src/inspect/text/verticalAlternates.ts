import { TRANSFORMED_VERTICAL_ORIENTATION } from './verticalOrientation.ts';

const RANGES: readonly (readonly [number, number])[] = TRANSFORMED_VERTICAL_ORIENTATION.split('\n').map(line => {
  const [first = '', last = ''] = line.split(';');
  return [Number.parseInt(first, 16), Number.parseInt(last, 16)] as const;
});

/**
 * Whether a code point's Unicode Vertical_Orientation is Tu or Tr (UAX #50: "Transformed typographically"), so that a font sets it in vertical text with a vertical alternate glyph.
 * Chromium's subsets drop the substitution tables, so their cmap does not list such alternates.
 */
export const hasVerticalAlternate = (codePoint: number): boolean => RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);

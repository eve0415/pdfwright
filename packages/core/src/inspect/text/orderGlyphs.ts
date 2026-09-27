import type { PageGlyph } from './extractText.ts';

import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';

/** How glyphs are ordered: as the content draws them, in rows top to bottom and left to right, or in columns right to left and top to bottom. */
export type GlyphLayout = 'content' | 'rows' | 'columns-rtl';

interface Placed {
  readonly glyph: PageGlyph;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

// Glyphs whose tops differ by less than this share a top.
const SAME_TOP = 0.01;

const placed = (glyph: PageGlyph): Placed => {
  const xs = [glyph.quad[0], glyph.quad[2], glyph.quad[4], glyph.quad[6]];
  const ys = [glyph.quad[1], glyph.quad[3], glyph.quad[5], glyph.quad[7]];
  return { glyph, left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
};

// Splits glyphs, already sorted along the grouping axis, into groups whose extents on that axis overlap by at least half the smaller extent.
const groups = (sorted: readonly Placed[], extent: (item: Placed) => readonly [number, number]): Placed[][] => {
  const result: Placed[][] = [];
  let current: Placed[] = [];
  let [low, high] = [Infinity, -Infinity];
  for (const item of sorted) {
    const [start, end] = extent(item);
    const overlap = Math.min(high, end) - Math.max(low, start);
    if (current.length > 0 && overlap >= 0 && overlap >= Math.min(end - start, high - low) / 2) {
      current.push(item);
      [low, high] = [Math.min(low, start), Math.max(high, end)];
    } else {
      if (current.length > 0) result.push(current);
      current = [item];
      [low, high] = [start, end];
    }
  }
  if (current.length > 0) result.push(current);
  return result;
};

const LAYOUTS: readonly GlyphLayout[] = ['content', 'rows', 'columns-rtl'];

const byIndex = (a: Placed, b: Placed): number => a.glyph.index - b.glyph.index;

/**
 * Orders glyphs for reading. `content` keeps the order the content stream draws them in, which is the logical order of Chromium's print output.
 * `rows` groups glyphs whose boxes' vertical extents overlap by at least half the smaller extent into rows, orders the rows top to bottom and each row left to right.
 * `columns-rtl` groups by horizontal overlap into columns, orders the columns right to left and each column top to bottom, glyphs that share a top (a tate-chu-yoko pair) left to right.
 * A layout outside GlyphLayout throws InvalidArgumentError.
 * The layout is not detected: mixed layouts on one page, rotated pages and bidirectional text are not handled, and ruby set beside its base text becomes a row or column of its own; select the glyphs to order (by region, font or size) first.
 */
export const orderGlyphs = (glyphs: readonly PageGlyph[], layout: GlyphLayout): readonly PageGlyph[] => {
  if (!LAYOUTS.includes(layout)) throw new InvalidArgumentError(`orderGlyphs: layout ${JSON.stringify(layout)} is not one of ${LAYOUTS.join(', ')}`);
  const items = glyphs.map(glyph => placed(glyph));
  if (layout === 'content') return items.toSorted(byIndex).map(item => item.glyph);
  if (layout === 'rows') {
    const sorted = items.toSorted((a, b) => b.top - a.top || byIndex(a, b));
    const rows = groups(sorted, item => [item.bottom, item.top]);
    return rows.flatMap(row => row.toSorted((a, b) => a.left - b.left || byIndex(a, b)).map(item => item.glyph));
  }
  const sorted = items.toSorted((a, b) => b.right - a.right || byIndex(a, b));
  const columns = groups(sorted, item => [item.left, item.right]);
  return columns.flatMap(column =>
    column.toSorted((a, b) => (Math.abs(b.top - a.top) < SAME_TOP ? a.left - b.left : b.top - a.top) || byIndex(a, b)).map(item => item.glyph),
  );
};

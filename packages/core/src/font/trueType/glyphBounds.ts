import type { Rectangle } from '../fontModel.ts';

import { ParseError } from '../../error/parseError.ts';

import { findTable, sfntReader } from './sfnt.ts';

// A glyph box wider or taller than this many ems is taken as damage rather than an outline.
const MAX_GLYPH_EMS = 16;

// The OpenType specification's head chapter: unitsPerEm is "Set to a value from 16 to 16384".
const MIN_UNITS_PER_EM = 16;
const MAX_UNITS_PER_EM = 16_384;

/** The bounding boxes of the glyphs of an embedded TrueType program, from the headers of its `glyf` entries. */
export interface TrueTypeGlyphBounds {
  readonly unitsPerEm: number;
  /**
   * The glyph's bounding box [xMin yMin xMax yMax] in ems (font units divided by unitsPerEm), as its `glyf` header gives it; `empty` for a glyph without outline data, whose `loca` entry has no length.
   * Undefined for an index past numGlyphs, an entry the `loca` or `glyf` table does not hold, a box whose minimum exceeds its maximum, and a box wider or taller than 16 ems.
   */
  readonly bounds: (glyph: number) => Rectangle | 'empty' | undefined;
}

export type GlyphBoundsReading =
  | { readonly kind: 'bounds'; readonly bounds: TrueTypeGlyphBounds }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string };

const signed = (value: number): number => (value >= 32_768 ? value - 65_536 : value);

/**
 * Reads the glyph bounding boxes of a TrueType program: `absent` when it has no `glyf` outlines (the OpenType specification's `head`, `maxp`, `loca` and `glyf` chapters), `unreadable` with a reason when those tables are damaged.
 * Only the fixed fields and the requested entries are read, each checked against the bytes present, so a lookup costs constant work and a damaged entry gives no box instead of an exception.
 */
export const readTrueTypeGlyphBounds = (program: Uint8Array): GlyphBoundsReading => {
  try {
    const [head, maxp, loca, glyf] = ['head', 'maxp', 'loca', 'glyf'].map(tag => findTable(program, tag));
    if (loca === undefined || glyf === undefined) return { kind: 'absent' };
    if (head === undefined || maxp === undefined) return { kind: 'unreadable', reason: 'the program has glyf outlines but no head or maxp table' };
    const unitsPerEm = sfntReader(head).u16(18);
    const locaFormat = sfntReader(head).u16(50);
    if (locaFormat !== 0 && locaFormat !== 1) return { kind: 'unreadable', reason: 'the indexToLocFormat is neither short nor long' };
    const long = locaFormat === 1;
    const count = sfntReader(maxp).u16(4);
    if (unitsPerEm < MIN_UNITS_PER_EM || unitsPerEm > MAX_UNITS_PER_EM) {
      return { kind: 'unreadable', reason: `unitsPerEm ${String(unitsPerEm)} is out of range` };
    }
    const locations = sfntReader(loca);
    const outlines = sfntReader(glyf);
    const offset = (index: number): number => (long ? locations.u32(4 * index) : 2 * locations.u16(2 * index));
    const bounds = (glyph: number): Rectangle | 'empty' | undefined => {
      if (!Number.isInteger(glyph) || glyph < 0 || glyph >= count) return undefined;
      try {
        const [start, end] = [offset(glyph), offset(glyph + 1)];
        if (start > glyf.length || end > glyf.length) return undefined;
        if (end === start) return 'empty';
        if (end < start || end > glyf.length || start + 10 > end) return undefined;
        const [xMin, yMin, xMax, yMax] = [2, 4, 6, 8].map(field => signed(outlines.u16(start + field)) / unitsPerEm);
        if (xMin === undefined || yMin === undefined || xMax === undefined || yMax === undefined) return undefined;
        if (xMin > xMax || yMin > yMax || xMax - xMin > MAX_GLYPH_EMS || yMax - yMin > MAX_GLYPH_EMS) return undefined;
        return [xMin, yMin, xMax, yMax];
      } catch (error) {
        if (error instanceof ParseError) return undefined;
        throw error;
      }
    };
    return { kind: 'bounds', bounds: { unitsPerEm, bounds } };
  } catch (error) {
    if (error instanceof ParseError) return { kind: 'unreadable', reason: error.message };
    throw error;
  }
};

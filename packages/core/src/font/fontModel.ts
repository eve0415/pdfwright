import type { Matrix } from '../content/matrix.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { CmapReading } from './trueType/cmapTable.ts';
import type { GlyphBoundsReading } from './trueType/glyphBounds.ts';

/** The font subtypes of ISO 32000-1:2008, Table 110, and `other` for any other value. */
export type FontSubtype = 'Type0' | 'Type1' | 'MMType1' | 'TrueType' | 'Type3' | 'other';

/** The CIDFont subtypes of Table 117, and `other` for any other value. */
export type CidFontSubtype = 'CIDFontType0' | 'CIDFontType2' | 'other';

/** Why part of a font could not be read; the codes are the font subset of the inspection warnings. */
export type FontWarningCode = 'font-unreadable' | 'cmap-unavailable' | 'to-unicode-unreadable' | 'to-unicode-range-overflow' | 'widths-unknown';

export interface FontWarning {
  readonly code: FontWarningCode;
  readonly detail: string;
}

/** A Type 0 font's descendant CIDFont (Table 121, DescendantFonts). */
export interface DescendantFont {
  readonly subtype: CidFontSubtype;
  readonly dictionary: PdfDictionaryEntries;
  readonly reference: PdfReference | undefined;
}

/** A rectangle [llx lly urx ury] with its corners ordered. */
export type Rectangle = readonly [number, number, number, number];

/** What a Type 3 font's glyphs are drawn from (Table 112). */
export interface Type3Parts {
  /** The CharProcs dictionary, whose keys are glyph names and whose values are glyph procedures. */
  readonly charProcs: PdfDictionaryEntries | undefined;
  /** The font's Resources entry as stored; absent when the glyph procedures take the page's resources. */
  readonly resources: PdfDirectObject | undefined;
  /** Whether the font has Chromium's shape: a font descriptor and every Differences name `g` followed by uppercase hexadecimal digits. */
  readonly chromium: boolean;
  /** The font dictionary's FontBBox in glyph space, normalised (ISO 32000-1:2008, 7.9.5); undefined when absent or all zero, which Table 112 says gives no size. */
  readonly fontBBox: Rectangle | undefined;
}

/** The vertical extent of the font's glyphs in glyph space, for advance boxes; `estimated` when neither the descriptor nor the font's bounding box gives one. Like any glyph-space value, it is mapped to text space by the font's `glyphMatrix` before it is combined with a text-space width. */
export interface VerticalExtent {
  readonly descent: number;
  readonly ascent: number;
  readonly estimated: boolean;
}

/** A CIDFont glyph's metrics for writing mode 1 (ISO 32000-1:2008, 9.7.4.3): the vertical component of its displacement w1, and the position vector v from origin 0 to origin 1. */
export interface VerticalMetrics {
  readonly w1: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * One character code of a shown string and what the font says about it.
 * Displacements are in text space: a width of 0.5 moves the text position by half the font size before horizontal scaling.
 */
export interface FontGlyph {
  /** The code's bytes as shown. */
  readonly bytes: Uint8Array;
  /** The code as a big-endian number. */
  readonly code: number;
  /** False for a Type 0 code that matched no codespace range (ISO 32000-1:2008, 9.7.6.3). */
  readonly valid: boolean;
  /** The CID a Type 0 font's CMap selects. */
  readonly cid: number | undefined;
  /** The glyph index a CIDFontType2 font's CIDToGIDMap gives the CID. */
  readonly gid: number | undefined;
  /** The glyph name a simple or Type 3 font's encoding gives the code. */
  readonly glyphName: string | undefined;
  /** Whether the code selects the font's .notdef glyph: CID 0, GID 0, the name `.notdef`, a Type 3 name without a glyph procedure, or `g0` in a Chromium-shaped Type 3 font. */
  readonly notdef: boolean;
  /** Whether a Type 3 glyph procedure paints nothing: no painting, text-showing, `Do` or inline-image operator. */
  readonly empty: boolean;
  /** The bounding box a Type 3 glyph procedure's d1 operator gives, normalised, in glyph space; undefined for d0, for an unreadable procedure and for other fonts, where the font's FontBBox stands in. */
  readonly type3Box: Rectangle | undefined;
  /** The text the font's ToUnicode CMap maps the code to. */
  readonly toUnicode: string | undefined;
  /** The text the code's glyph name or CID collection stands for. */
  readonly encodingText: string | undefined;
  /** The horizontal displacement w0 in text space, or undefined when the font gives no width for the code. */
  readonly width: number | undefined;
  /** The code's writing mode 1 metrics in text space, for a Type 0 font whose width for the code is known; undefined for simple fonts. */
  readonly vertical: VerticalMetrics | undefined;
  /** Whether word spacing applies: ISO 32000-1:2008, 9.3.3, "the single-byte character code 32 in a string when using a simple font or a composite font that defines code 32 as a single-byte code". */
  readonly wordSpace: boolean;
  /** The name of a predefined CMap a usecmap named and no provider supplied, when this code's CID depends on it. */
  readonly cmapUnavailable: string | undefined;
}

/**
 * A font's Encoding entry: for a simple font a predefined encoding name, an encoding dictionary with the count of names its Differences array gives, or none, when the font program's built-in encoding applies (ISO 32000-1:2008, 9.6.6); for a Type 0 font its CMap (9.7.5), predefined or embedded as a stream.
 * `available` says whether a predefined CMap other than Identity-H and Identity-V, and any CMap a usecmap names, was supplied by the CMap provider.
 */
export type FontEncodingSummary =
  | {
      readonly kind: 'named';
      readonly name: 'StandardEncoding' | 'MacRomanEncoding' | 'WinAnsiEncoding' | 'MacExpertEncoding' | 'other';
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'differences'; readonly base: Uint8Array | undefined; readonly differences: number }
  | { readonly kind: 'font-program' }
  | {
      readonly kind: 'cmap';
      readonly name: Uint8Array;
      readonly predefined: boolean;
      readonly embedded: boolean;
      readonly writingMode: 0 | 1;
      readonly available: boolean;
    }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The glyphs of a shown string; or why the string cannot be split, when the font's encoding is a predefined CMap no provider supplied or cannot be read. */
export type FontString =
  | { readonly kind: 'glyphs'; readonly glyphs: readonly FontGlyph[] }
  | { readonly kind: 'cmap-unavailable'; readonly cmap: string }
  | { readonly kind: 'undecodable'; readonly reason: string };

/**
 * A font as text showing and text extraction use it: how strings split into codes, and each code's CID, glyph index, notdef state, text and width.
 * The content interpreter advances the text matrix with `width` (and the vertical metrics of writing mode 1); text extraction reads the rest.
 */
export interface FontModel {
  /** The key the font is cached under: `objectNumber.generation` for an indirect font; for a direct one, `direct:<owner>:<name hex>`, where the owner names the nearest indirect object holding the font dictionary (see `fontResourceOwner` and `graphicsStateFontOwner` in `loadFont.ts`). */
  readonly key: string;
  readonly reference: PdfReference | undefined;
  readonly dictionary: PdfDictionaryEntries;
  readonly subtype: FontSubtype;
  readonly descendant: DescendantFont | undefined;
  /** BaseFont as stored. */
  readonly baseFont: Uint8Array | undefined;
  /** 0 for horizontal writing, 1 for vertical, from the Type 0 font's CMap (9.7.5.1); 0 for simple fonts. */
  readonly writingMode: 0 | 1;
  /** Glyph space to text space: FontMatrix for a Type 3 font (9.2.4), [0.001 0 0 0.001 0 0] for every other font. */
  readonly glyphMatrix: Matrix;
  readonly verticalExtent: VerticalExtent;
  readonly toUnicode: 'present' | 'absent' | 'unreadable';
  readonly encoding: FontEncodingSummary;
  /** The registry–ordering–UCS2 map a Type 0 font's encoding text comes from (ISO 32000-1:2008, 9.10.2), and whether the provider supplied it. */
  readonly collectionMap: { readonly name: string; readonly available: boolean } | undefined;
  readonly type3: Type3Parts | undefined;
  readonly warnings: readonly FontWarning[];
  /**
   * The Unicode `cmap` subtable of the font's embedded TrueType program (FontFile2, ISO 32000-1:2008, Table 122), read on the first call; undefined for a font that embeds no such program.
   * For a simple TrueType font the descriptor is the font's own, for a Type 0 font its CIDFontType2 descendant's.
   */
  readonly embeddedCmap: () => CmapReading | undefined;
  /** The glyph bounding boxes of the same embedded TrueType program, read on the first call; undefined for a font that embeds no such program. */
  readonly embeddedGlyphBounds: () => GlyphBoundsReading | undefined;
  /** Splits a shown string into its codes, checking maxGlyphs before each glyph is appended. */
  readonly glyphs: (string: Uint8Array, maxGlyphs?: number) => FontString;
}

import type { ClipClass, Quad } from '../../content/clip.ts';
import type { InspectWarning } from '../../content/inspectWarning.ts';
import type { ContentSource, CoverEvent, GraphicsState, MarkedContent, TextShowEvent } from '../../content/interpreter.ts';
import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { LoadedDocument } from '../../document/loadDocument.ts';
import type { CMapProvider } from '../../font/cmap/cmapProvider.ts';
import type { FontGlyph, FontModel } from '../../font/fontModel.ts';
import type { PdfReference } from '../../object/pdfObject.ts';
import type { EmbeddedCmap } from './glyphEvidence.ts';
import type { ActualTextSpan } from './textUnits.ts';

import { Clip } from '../../content/clip.ts';
import { FILLING_MODES, STROKING_MODES, interpretPage } from '../../content/interpreter.ts';
import { unreadable } from '../../content/unreadable.ts';
import { internalsOf } from '../../document/documentInternals.ts';
import { createInheritedCache, effectiveBoxes } from '../../document/loadedPage.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { ResourceLimitError } from '../../error/resourceLimitError.ts';
import { numberOf } from '../../font/fontValues.ts';
import { FontCache } from '../../font/loadFont.ts';
import { pdfName } from '../../object/pdfObject.ts';

import { CoverIndex, quadBounds } from './coverIndex.ts';
import { glyphGeometry } from './glyphGeometry.ts';
import { ActualTextSpans } from './textUnits.ts';

const MCID = pdfName('MCID').bytes;

/** The content stream a glyph was shown in: the page's own content, a form XObject, a tiling pattern's cell, an annotation's appearance, or a soft mask's transparency group. */
export type GlyphSource =
  | { readonly kind: 'page' }
  | { readonly kind: 'form'; readonly reference: PdfReference | undefined }
  | { readonly kind: 'pattern'; readonly reference: PdfReference | undefined }
  | { readonly kind: 'annotation'; readonly index: number }
  | { readonly kind: 'soft-mask'; readonly group: PdfReference | undefined };

/**
 * Why a glyph has no text, or `notdef` for a .notdef glyph whatever its text: its code selects the font's .notdef glyph; nothing maps it; its text depends on a predefined CMap or a registry–ordering–UCS2 map the CMap provider did not supply; or the font cannot decode the string.
 */
export type GlyphTextReason = 'notdef' | 'no-mapping' | 'predefined-cmap-unavailable' | 'undecodable';

/** Why a glyph paints nothing that can be seen; the first that applies, in this order. */
export type InvisibleBecause = 'render-mode' | 'alpha' | 'soft-mask-group' | 'degenerate' | 'empty-glyph';

/** A marked-content sequence a glyph lies in (ISO 32000-1:2008, 14.6), with the MCID its property list gives (14.7.4.2). */
export interface GlyphMarkedContent {
  readonly tag: Uint8Array;
  readonly mcid: number | undefined;
}

/**
 * One character code shown on the page, in content order.
 * Positions are in the page's default user space (ISO 32000-1:2008, 7.7.3.3), before the page's Rotate and UserUnit, which `page.boxes()` reports.
 */
export interface PageGlyph {
  /** The glyph's position in content order. */
  readonly index: number;
  /** The character code's bytes as shown; for a string the font could not split, the whole string. */
  readonly code: Uint8Array;
  readonly cid: number | undefined;
  readonly gid: number | undefined;
  /** The key of the font, as `listFonts` reports it. */
  readonly font: string;
  /** The glyph's own text: its ToUnicode text, else its encoding text; never ActualText. */
  readonly text: string | null;
  /** The text the font's ToUnicode CMap maps the code to. */
  readonly toUnicode: string | null;
  /** The text the code's glyph name or CID collection stands for. */
  readonly encodingText: string | null;
  /** Why `text` is null, or `notdef` whenever the glyph is a .notdef glyph. */
  readonly reason: GlyphTextReason | undefined;
  /** Whether the code selects the font's .notdef glyph. */
  readonly notdef: boolean;
  /** Whether the glyph is a Type 3 glyph whose procedure paints nothing. */
  readonly empty: boolean;
  /** The index in `PageText.actualText` of the outermost ActualText span the glyph is shown in. */
  readonly actualText: number | undefined;
  /** The font's writing mode, as stored. */
  readonly writingMode: 0 | 1;
  /** Where the glyph is painted: in horizontal writing, origin 0. */
  readonly origin: readonly [number, number];
  /** The glyph's own displacement, without the TJ numbers after it. */
  readonly advance: readonly [number, number];
  /** The advance box's corners: origin side bottom, far side bottom, far side top, origin side top. */
  readonly quad: Quad;
  /** The length of the text-space unit along the glyph's vertical axis on the page, which is Tfs scaled by the text matrix and the CTM. */
  readonly fontSize: number;
  /** Tr, 0 to 7 (ISO 32000-1:2008, 9.3.6, Table 106). */
  readonly renderMode: number;
  /**
   * False for render modes 3 and 7, text whose render mode paints only at alpha 0, text inside a soft mask's transparency group, a degenerate rendering matrix, and an empty Type 3 glyph.
   * Text painted under a soft mask stays visible, with `softMasked` set.
   */
  readonly visible: boolean;
  readonly invisibleBecause: InvisibleBecause | undefined;
  /** The nonstroking alpha the glyph is seen at: the ExtGState ca in force times the alpha of the transparency groups it is drawn in. */
  readonly fillAlpha: number;
  /** The stroking alpha, CA, times the alpha of the enclosing transparency groups. */
  readonly strokeAlpha: number;
  /** Whether a soft mask was active where the glyph was painted, by an ExtGState SMask or on an enclosing transparency group. */
  readonly softMasked: boolean;
  /** Whether later opaque fills of rectangles with sides parallel to the page axes cover the advance box where the clip shows it, tested at a grid of points. Fills of other shapes, images and shadings are not considered. */
  readonly covered: boolean;
  /** How the advance box lies against the clipping path it was painted under; `unknown` past the clip's vertex limit, under a clip made from glyph outlines (render modes 4 to 7), which are not read, and in a tiling pattern's cell, whose placement depends on where the pattern is painted. */
  readonly clip: ClipClass;
  /** False after a glyph whose width is unknown or a string that could not be split, until a text-positioning operator sets the position again. */
  readonly positionKnown: boolean;
  /** Whether the box's vertical extent is the default guess, because neither the font descriptor nor a bounding box gives one. */
  readonly extentEstimated: boolean;
  readonly source: GlyphSource;
  /** The open marked-content sequences, outermost first. */
  readonly markedContent: readonly GlyphMarkedContent[];
}

/** A font the page shows glyphs with. */
export interface TextFont {
  /** The font's key, as `listFonts` reports it. */
  readonly key: string;
  /**
   * The Unicode cmap of the font's embedded TrueType program (FontFile2, ISO 32000-1:2008, Table 122), for a Type 0 font with a CIDFontType2 descendant, whose glyph indexes are known from CIDToGIDMap (Table 117).
   * Undefined for other fonts, and when the program has no readable Unicode cmap.
   */
  readonly cmap: EmbeddedCmap | undefined;
  /** Whether such a font embeds a TrueType program whose Unicode cmap is absent or cannot be read, so that nothing in the program confirms which glyph a code shows. */
  readonly cmapMissing: boolean;
}

export interface PageText {
  /** The 0-based page index. */
  readonly page: number;
  readonly glyphs: readonly PageGlyph[];
  /** The fonts glyphs are shown with, in the order of first use. */
  readonly fonts: readonly TextFont[];
  /** The ActualText spans glyphs are shown in, in the order their first glyphs are shown. */
  readonly actualText: readonly ActualTextSpan[];
  /** The page's CropBox, [llx lly urx ury]; undefined when the page's boxes cannot be read. */
  readonly cropBox: readonly [number, number, number, number] | undefined;
  /** The page's MediaBox, [llx lly urx ury]; undefined when the page's boxes cannot be read. */
  readonly mediaBox: readonly [number, number, number, number] | undefined;
  /** False when some content could not be read or interpreted. */
  readonly complete: boolean;
  readonly warnings: readonly InspectWarning[];
}

export interface ExtractTextOptions {
  /** Which annotations' normal appearances are read after the page content: none (the default, as pdftotext and mutool do), those that print (Table 165), or all. */
  readonly annotations?: 'printable' | 'none' | 'all';
  /** Supplies predefined CMaps other than Identity-H and Identity-V, and registry–ordering–UCS2 maps. */
  readonly cmapProvider?: CMapProvider;
  /** The glyphs the page may show, counting those of a form each time it is drawn; past it ResourceLimitError is thrown. Default 1,000,000. */
  readonly maxGlyphs?: number;
}

/** The default for `ExtractTextOptions.maxGlyphs`. */
const MAX_GLYPHS = 1_000_000;

// The innermost content stream other than the page's own.
const sourceOf = (sources: readonly ContentSource[]): GlyphSource => {
  for (const source of sources.toReversed()) {
    if (source.kind === 'form') return { kind: 'form', reference: source.reference };
    if (source.kind === 'tiling-pattern') return { kind: 'pattern', reference: source.reference };
    if (source.kind === 'annotation') return { kind: 'annotation', index: source.index };
    if (source.kind === 'soft-mask') return { kind: 'soft-mask', group: source.group };
  }
  return { kind: 'page' };
};

// An MCID that cannot be read is reported as absent: the glyph is still shown.
const mcidOf = (document: DocumentInternals, properties: MarkedContent['properties']): number | undefined => {
  try {
    const mcid = numberOf(document.objects.deref(properties?.get(MCID)));
    return mcid !== undefined && Number.isInteger(mcid) ? mcid : undefined;
  } catch (error: unknown) {
    if (!unreadable(error)) throw error;
    return undefined;
  }
};

const markedContentOf = (document: DocumentInternals, sequences: readonly MarkedContent[]): GlyphMarkedContent[] =>
  sequences.map(({ tag, properties }) => ({ tag, mcid: mcidOf(document, properties) }));

/**
 * A glyph's own text and why it has none, by the order of ISO 32000-1:2008, 9.10.2: the ToUnicode CMap; then, for a simple font, the Unicode value of the glyph name its encoding gives the code, and for a composite font the CID mapped through the registry–ordering–UCS2 map, both of which the font model reads as the encoding text.
 * 9.10.2: "If these methods fail to produce a Unicode value, there is no way to determine what the character code represents".
 */
const glyphText = (font: FontModel, glyph: FontGlyph): Pick<PageGlyph, 'text' | 'reason'> => {
  const text = glyph.toUnicode ?? glyph.encodingText ?? null;
  if (glyph.notdef) return { text, reason: 'notdef' };
  if (text !== null) return { text, reason: undefined };
  const unavailable = glyph.cmapUnavailable !== undefined || font.collectionMap?.available === false;
  return { text, reason: unavailable ? 'predefined-cmap-unavailable' : 'no-mapping' };
};

// A string the font cannot split has no text: its CMap was not supplied, or it cannot be decoded.
const unsplitText = (unsplit: NonNullable<TextShowEvent['unsplit']>): Pick<PageGlyph, 'text' | 'reason'> => ({
  text: null,
  reason: unsplit.kind === 'cmap-unavailable' ? 'predefined-cmap-unavailable' : 'undecodable',
});

// ISO 32000-1:2008, 9.3.6, Table 106 and 8.4.5, Table 58: what a glyph's render mode paints with, and whether any of it is seen; a transparency group's alpha applies to everything in it (11.6.4.4).
const invisibility = (
  state: GraphicsState,
  { sources, degenerate, empty }: { sources: readonly ContentSource[]; degenerate: boolean; empty: boolean },
): InvisibleBecause | undefined => {
  const { renderMode } = state;
  const fills = FILLING_MODES.has(renderMode);
  const strokes = STROKING_MODES.has(renderMode);
  if (!fills && !strokes) return 'render-mode';
  const seen = (fills && state.fillAlpha * state.group.alpha > 0) || (strokes && state.strokeAlpha * state.group.alpha > 0);
  if (!seen) return 'alpha';
  if (sources.some(source => source.kind === 'soft-mask')) return 'soft-mask-group';
  if (degenerate) return 'degenerate';
  return empty ? 'empty-glyph' : undefined;
};

// The advance box is sampled on a grid of this many points per side to test what covers it.
const COVER_SAMPLES = 5;

// Points spread evenly over the quad, corners and edges included.
const samples = (quad: Quad): (readonly [number, number])[] => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
  const points: (readonly [number, number])[] = [];
  for (let row = 0; row < COVER_SAMPLES; row++) {
    for (let column = 0; column < COVER_SAMPLES; column++) {
      const [u, v] = [column / (COVER_SAMPLES - 1), row / (COVER_SAMPLES - 1)];
      const bottom = [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u] as const;
      const top = [x3 + (x2 - x3) * u, y3 + (y2 - y3) * u] as const;
      points.push([bottom[0] + (top[0] - bottom[0]) * v, bottom[1] + (top[1] - bottom[1]) * v]);
    }
  }
  return points;
};

/**
 * Whether later opaque rectangles cover the glyph's box where the clip lets it show: every sampled point of the box inside the glyph's clip lies in one of them, inside that rectangle's own clip.
 * Rectangles are tested together, so adjacent fills that hide a glyph between them count, and the part of the box a clip hides needs no cover.
 */
const coveredBy = (covers: CoverIndex, { quad, clip }: { quad: Quad; clip: Clip }): boolean => {
  const shown = samples(quad).filter(([x, y]) => clip.classifyPoint(x, y) !== 'outside');
  return shown.length > 0 && shown.every(([x, y]) => covers.hides(x, y));
};

// The embedded cmap of a CIDFontType2 font, and whether it embeds a TrueType program without a usable one; a program that cannot be read has none.
const embeddedCmapOf = (font: FontModel): Pick<TextFont, 'cmap' | 'cmapMissing'> => {
  if (font.descendant?.subtype !== 'CIDFontType2') return { cmap: undefined, cmapMissing: false };
  try {
    const reading = font.embeddedCmap();
    if (reading === undefined) return { cmap: undefined, cmapMissing: false };
    return reading.kind === 'cmap' ? { cmap: reading.cmap, cmapMissing: false } : { cmap: undefined, cmapMissing: true };
  } catch (error: unknown) {
    if (!unreadable(error)) throw error;
    return { cmap: undefined, cmapMissing: true };
  }
};

class TextCollector {
  readonly glyphs: PageGlyph[] = [];
  private readonly fontModels = new Map<string, FontModel>();
  // The interpreter's event sequence of each glyph's text-show event, so that only fills after it can cover it.
  readonly sequences: number[] = [];
  // The clip each glyph was painted under, so that only the part of its box the clip shows needs covering.
  private readonly clips: Clip[] = [];
  readonly spans: ActualTextSpans;
  private readonly document: DocumentInternals;
  private readonly maxGlyphs: number;

  constructor(document: DocumentInternals, maxGlyphs: number) {
    this.document = document;
    this.maxGlyphs = maxGlyphs;
    this.spans = new ActualTextSpans(document);
  }

  add(event: TextShowEvent): void {
    const { font, state } = event;
    // One Tj is one operation however many glyphs it shows, so maxOperations does not bound the glyphs a page collects.
    if (this.glyphs.length + event.glyphs.length + (event.unsplit === undefined ? 0 : 1) > this.maxGlyphs) {
      throw new ResourceLimitError(`the page shows more than maxGlyphs (${String(this.maxGlyphs)}) glyphs`);
    }
    if (!this.fontModels.has(font.key)) this.fontModels.set(font.key, font);
    const source = sourceOf(event.context.sources);
    const markedContent = markedContentOf(this.document, event.markedContent);
    const { unsplit } = event;
    // ISO 32000-1:2008, 8.7.3.1: "Painting with the pattern replicates the cell at fixed horizontal and vertical intervals to fill an area"; the area is not tracked, so where the cell's glyphs land is unknown.
    const inPattern = event.context.sources.some(({ kind }) => kind === 'tiling-pattern');
    const push = (
      glyph: FontGlyph | undefined,
      place: { textMatrix: TextShowEvent['textMatrix']; positionKnown: boolean },
      layers: Pick<PageGlyph, 'text' | 'reason'>,
    ): void => {
      const geometry = glyphGeometry(font, glyph, { state, textMatrix: place.textMatrix });
      const index = this.glyphs.length;
      const empty = glyph?.empty ?? false;
      const invisibleBecause = invisibility(state, { sources: event.context.sources, degenerate: geometry.degenerate, empty });
      this.sequences.push(event.sequence);
      this.clips.push(state.clip);
      this.glyphs.push({
        index,
        code: glyph?.bytes ?? event.string,
        cid: glyph?.cid,
        gid: glyph?.gid,
        font: font.key,
        ...layers,
        toUnicode: glyph?.toUnicode ?? null,
        encodingText: glyph?.encodingText ?? null,
        notdef: glyph?.notdef ?? false,
        empty,
        actualText: this.spans.add(index, event.markedContent),
        writingMode: font.writingMode,
        origin: geometry.origin,
        advance: geometry.advance,
        quad: geometry.quad,
        fontSize: geometry.fontSize,
        renderMode: state.renderMode,
        visible: invisibleBecause === undefined,
        invisibleBecause,
        fillAlpha: state.fillAlpha * state.group.alpha,
        strokeAlpha: state.strokeAlpha * state.group.alpha,
        softMasked: state.softMask !== undefined || state.group.softMasked,
        covered: false,
        clip: inPattern ? 'unknown' : state.clip.classifyQuad(geometry.quad),
        positionKnown: place.positionKnown,
        extentEstimated: geometry.extentEstimated,
        source,
        markedContent,
      });
    };
    if (unsplit !== undefined) push(undefined, event, unsplitText(unsplit));
    for (const shown of event.glyphs) push(shown.glyph, shown, glyphText(font, shown.glyph));
  }

  fonts(): TextFont[] {
    return [...this.fontModels.values()].map(font => {
      const { cmap, cmapMissing } = embeddedCmapOf(font);
      return { key: font.key, cmap, cmapMissing };
    });
  }

  /** The glyphs, each marked covered when opaque rectangle fills after it cover its box; covers come in content order. */
  covered(covers: readonly CoverEvent[]): PageGlyph[] {
    const bounds = quadBounds(this.glyphs.map(glyph => glyph.quad));
    if (covers.length === 0 || bounds === undefined) return this.glyphs;
    const index = new CoverIndex(bounds, this.glyphs.length);
    const result = [...this.glyphs];
    let next = covers.length - 1;
    // From the last glyph back, adding each fill before the glyphs shown ahead of it, so that each glyph is tested against the fills after it only.
    for (let at = result.length - 1; at >= 0; at--) {
      const glyph = result[at];
      const sequence = this.sequences[at] ?? Infinity;
      for (let cover = covers[next]; cover !== undefined && cover.sequence > sequence; cover = covers[--next]) index.add(cover);
      if (glyph !== undefined && coveredBy(index, { quad: glyph.quad, clip: this.clips[at] ?? Clip.NONE })) result[at] = { ...glyph, covered: true };
    }
    return result;
  }
}

// ISO 32000-1:2008, 14.11.2.1: "The crop box defines the region to which the contents of the page shall be clipped (cropped) when displayed or printed".
const boxesOf = (document: DocumentInternals, pageIndex: number, warnings: InspectWarning[]): Pick<PageText, 'cropBox' | 'mediaBox'> => {
  const page = document.pages[pageIndex];
  if (page === undefined) return { cropBox: undefined, mediaBox: undefined };
  try {
    const boxes = effectiveBoxes(document.objects, page, createInheritedCache());
    return { cropBox: boxes.CropBox.rect, mediaBox: boxes.MediaBox.rect };
  } catch (error: unknown) {
    if (!unreadable(error)) throw error;
    warnings.push({ code: 'content-unreadable', detail: `the page boxes cannot be read: ${error.message}` });
    return { cropBox: undefined, mediaBox: undefined };
  }
};

/**
 * The glyphs a page shows, in content order, each with its code, font, text layers and advance box in the page's default user space.
 * Damaged content never throws: it becomes warnings and `complete: false`. A page index that is not a page throws InvalidArgumentError, and content past the interpreter's limits or `maxGlyphs` ResourceLimitError.
 */
export const extractText = (document: LoadedDocument, pageIndex: number, options: ExtractTextOptions = {}): PageText => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new InvalidArgumentError('the document was not loaded by loadDocument');
  const collector = new TextCollector(parts, options.maxGlyphs ?? MAX_GLYPHS);
  const covers: CoverEvent[] = [];
  const result = interpretPage(parts, pageIndex, {
    fonts: new FontCache(parts, options.cmapProvider),
    annotations: options.annotations ?? 'none',
    text: event => {
      collector.add(event);
    },
    cover: event => {
      covers.push(event);
    },
  });
  const warnings = [...result.warnings];
  const { cropBox, mediaBox } = boxesOf(parts, pageIndex, warnings);
  return {
    page: pageIndex,
    glyphs: collector.covered(covers),
    fonts: collector.fonts(),
    actualText: collector.spans.spans,
    cropBox,
    mediaBox,
    complete: result.complete && cropBox !== undefined,
    warnings,
  };
};

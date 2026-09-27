import type { Quad } from '../../content/clip.ts';
import type { InspectWarning } from '../../content/inspectWarning.ts';
import type { ContentSource, MarkedContent, TextShowEvent } from '../../content/interpreter.ts';
import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { LoadedDocument } from '../../document/loadDocument.ts';
import type { CMapProvider } from '../../font/cmap/cmapProvider.ts';
import type { FontGlyph, FontModel } from '../../font/fontModel.ts';
import type { PdfReference } from '../../object/pdfObject.ts';

import { interpretPage } from '../../content/interpreter.ts';
import { unreadable } from '../../content/unreadable.ts';
import { internalsOf } from '../../document/documentInternals.ts';
import { createInheritedCache, effectiveBoxes } from '../../document/loadedPage.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { numberOf } from '../../font/fontValues.ts';
import { FontCache } from '../../font/loadFont.ts';
import { pdfName } from '../../object/pdfObject.ts';

import { glyphGeometry } from './glyphGeometry.ts';

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
  /** False after a glyph whose width is unknown or a string that could not be split, until a text-positioning operator sets the position again. */
  readonly positionKnown: boolean;
  /** Whether the box's vertical extent is the default guess, because neither the font descriptor nor a bounding box gives one. */
  readonly extentEstimated: boolean;
  readonly source: GlyphSource;
  /** The open marked-content sequences, outermost first. */
  readonly markedContent: readonly GlyphMarkedContent[];
}

export interface PageText {
  /** The 0-based page index. */
  readonly page: number;
  readonly glyphs: readonly PageGlyph[];
  /** The page's CropBox, [llx lly urx ury]; undefined when the page's boxes cannot be read. */
  readonly cropBox: readonly [number, number, number, number] | undefined;
  /** False when some content could not be read or interpreted. */
  readonly complete: boolean;
  readonly warnings: readonly InspectWarning[];
}

export interface ExtractTextOptions {
  /** Which annotations' normal appearances are read after the page content: none (the default, as pdftotext and mutool do), those that print (Table 165), or all. */
  readonly annotations?: 'printable' | 'none' | 'all';
  /** Supplies predefined CMaps other than Identity-H and Identity-V, and registry–ordering–UCS2 maps. */
  readonly cmapProvider?: CMapProvider;
}

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

class TextCollector {
  readonly glyphs: PageGlyph[] = [];
  private readonly document: DocumentInternals;

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  add(event: TextShowEvent): void {
    const { font, state } = event;
    const source = sourceOf(event.context.sources);
    const markedContent = markedContentOf(this.document, event.markedContent);
    const { unsplit } = event;
    const push = (
      glyph: FontGlyph | undefined,
      place: { textMatrix: TextShowEvent['textMatrix']; positionKnown: boolean },
      layers: Pick<PageGlyph, 'text' | 'reason'>,
    ): void => {
      const geometry = glyphGeometry(font, glyph, { state, textMatrix: place.textMatrix });
      this.glyphs.push({
        index: this.glyphs.length,
        code: glyph?.bytes ?? event.string,
        cid: glyph?.cid,
        gid: glyph?.gid,
        font: font.key,
        ...layers,
        toUnicode: glyph?.toUnicode ?? null,
        encodingText: glyph?.encodingText ?? null,
        notdef: glyph?.notdef ?? false,
        writingMode: font.writingMode,
        origin: geometry.origin,
        advance: geometry.advance,
        quad: geometry.quad,
        fontSize: geometry.fontSize,
        renderMode: state.renderMode,
        positionKnown: place.positionKnown,
        extentEstimated: geometry.extentEstimated,
        source,
        markedContent,
      });
    };
    if (unsplit !== undefined) push(undefined, event, unsplitText(unsplit));
    for (const shown of event.glyphs) push(shown.glyph, shown, glyphText(font, shown.glyph));
  }
}

// ISO 32000-1:2008, 14.11.2.1: "The crop box defines the region to which the contents of the page shall be clipped (cropped) when displayed or printed".
const cropBoxOf = (document: DocumentInternals, pageIndex: number, warnings: InspectWarning[]): PageText['cropBox'] => {
  const page = document.pages[pageIndex];
  if (page === undefined) return undefined;
  try {
    return effectiveBoxes(document.objects, page, createInheritedCache()).CropBox.rect;
  } catch (error: unknown) {
    if (!unreadable(error)) throw error;
    warnings.push({ code: 'content-unreadable', detail: `the page boxes cannot be read: ${error.message}` });
    return undefined;
  }
};

/**
 * The glyphs a page shows, in content order, each with its code, font, text layers and advance box in the page's default user space.
 * Damaged content never throws: it becomes warnings and `complete: false`. A page index that is not a page throws InvalidArgumentError, and content past the interpreter's limits ResourceLimitError.
 */
export const extractText = (document: LoadedDocument, pageIndex: number, options: ExtractTextOptions = {}): PageText => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new InvalidArgumentError('the document was not loaded by loadDocument');
  const collector = new TextCollector(parts);
  const result = interpretPage(parts, pageIndex, {
    fonts: new FontCache(parts, options.cmapProvider),
    annotations: options.annotations ?? 'none',
    text: event => {
      collector.add(event);
    },
  });
  const warnings = [...result.warnings];
  const cropBox = cropBoxOf(parts, pageIndex, warnings);
  return { page: pageIndex, glyphs: collector.glyphs, cropBox, complete: result.complete && cropBox !== undefined, warnings };
};

import type { AlignmentStep } from './alignment.ts';
import type { GlyphTextReason, PageGlyph, PageText } from './extractText.ts';
import type { TextFold } from './folds.ts';
import type { EmbeddedCmap } from './glyphEvidence.ts';
import type { GlyphLayout } from './orderGlyphs.ts';

import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';

import { align } from './alignment.ts';
import { TEXT_FOLDS, foldText } from './folds.ts';
import { isFullWidthOrWide } from './fullWidth.ts';
import { cmapEvidence, variantConfirmed } from './glyphEvidence.ts';
import { orderGlyphs } from './orderGlyphs.ts';
import { hasVerticalAlternate } from './verticalAlternates.ts';

export interface MatchTextOptions {
  /** Which glyphs count; by default those that are visible or only empty, not covered, whose core box is not entirely hidden, not clipped out or under a clip whose shape is unknown, and whose box's centre lies inside the CropBox reduced to the MediaBox. */
  readonly select?: (glyph: PageGlyph) => boolean;
  /** The order the glyphs are read in; `content` by default. */
  readonly order?: GlyphLayout;
  /** `ignore` (the default) removes every White_Space character from both texts; `exact` compares them. */
  readonly whitespace?: 'ignore' | 'exact';
  /** The folds applied to the page's text; all by default. */
  readonly folds?: readonly TextFold[];
  /** Further pairs a caller has verified are drawn with one glyph in its font, as [found, intended]: a glyph whose folded text is `found` is read as `intended`. */
  readonly equivalents?: readonly (readonly [string, string])[];
  /**
   * `require-glyph-evidence` (the default): a variation selector of the intended text counts only when the glyph's own text carries it.
   * `ignore` removes variation selectors from both texts.
   */
  readonly variationSelectors?: 'require-glyph-evidence' | 'ignore';
  /**
   * `checked` (the default): the text of an ActualText span is used only when it equals the folded text of the span's glyphs, apart from variation selectors only the span has; otherwise the glyphs' text is compared and the result is at best `unverified`.
   * `ignore`: spans are not used.
   */
  readonly actualText?: 'checked' | 'ignore';
  /**
   * `collapse` (the default): when the selected glyphs are two or more consecutive runs of the same codes in the same fonts, each a translation of the first, to within 0.005 of the font size, by less than a quarter of the font size and half the run's advance, only the last run drawn is compared.
   * `keep`: every run is compared.
   */
  readonly duplicates?: 'collapse' | 'keep';
}

/**
 * How the page's text differs from the intended text. Glyph indexes are those of `PageText.glyphs`, and `intendedIndex` is the UTF-16 offset in the intended text of the character concerned.
 */
export type TextDifference =
  /** A .notdef glyph, or a Type 3 glyph that paints nothing, stands where text is shown: the print shows a box or nothing. */
  | { readonly kind: 'missing-glyph'; readonly glyphs: readonly number[]; readonly intendedIndex: number | undefined }
  /** A glyph without text, or whose text is the empty string, as a ToUnicode mapping to `<>` gives. */
  | { readonly kind: 'unmapped'; readonly glyphs: readonly number[]; readonly reason: GlyphTextReason }
  | { readonly kind: 'substituted'; readonly intended: string; readonly found: string; readonly intendedIndex: number; readonly glyphs: readonly number[] }
  | { readonly kind: 'missing'; readonly intended: string; readonly intendedIndex: number }
  | { readonly kind: 'extra'; readonly found: string; readonly glyphs: readonly number[] }
  /** An ActualText span whose text differs from its glyphs' own text; the glyphs' text was compared. `span` indexes `PageText.actualText`. */
  | {
      readonly kind: 'actual-text-disagrees';
      readonly actualText: string;
      readonly glyphText: string;
      readonly span: number;
      readonly glyphs: readonly number[];
    }
  /** An intended variation selector that only an ActualText span, not the glyph's own text, carries. */
  | { readonly kind: 'variant-unverified'; readonly intended: string; readonly intendedIndex: number; readonly glyphs: readonly number[] }
  /**
   * A glyph of an embedded TrueType font whose cmap maps the glyph's text to another glyph than the one drawn, `expectedGid`.
   * `expectedGid` is undefined when the cmap does not list the glyph's folded text but maps its own text, before folds, to the glyph drawn: the font tells the two characters apart.
   * The glyph also disagrees when the cmap cannot confirm it and its width is half an em while its ToUnicode character is full-width or wide, the width of a half-width form such as a half-width form.
   */
  | {
      readonly kind: 'glyph-disagrees';
      readonly text: string;
      readonly expectedGid: number | undefined;
      readonly drawnGid: number;
      readonly glyphs: readonly number[];
    }
  /**
   * Glyphs of a Type 0 font with a CIDFontType2 descendant whose embedded TrueType program has no usable Unicode cmap, so that the program gives no evidence that the glyph drawn is the one the text names.
   */
  | { readonly kind: 'glyph-unchecked'; readonly font: string; readonly glyphs: readonly number[] }
  /** An ActualText span none of whose glyphs is compared, between compared glyphs. */
  | { readonly kind: 'no-glyph-evidence'; readonly text: string; readonly span: number }
  /** Some of the page's content could not be read (`PageText.complete` is false), so what it would have drawn over or beside the text is unknown. */
  | { readonly kind: 'page-incomplete' }
  /** A run of compared glyphs, adjacent in the order compared, whose core boxes the clip or later opaque rectangles hide in part (`PageGlyph.coreHidden`): the print shows only part of each. */
  | { readonly kind: 'partly-hidden'; readonly glyphs: readonly number[] };

/** A fold used on the page's text, with the glyphs it was used for. */
export interface FoldApplied {
  /** A fold of `folds`, a caller's equivalent, or `embedded-cmap` for a character the glyph's embedded cmap maps to exactly the glyph drawn. */
  readonly fold: TextFold | 'caller' | 'embedded-cmap';
  readonly from: string;
  readonly to: string;
  readonly glyphs: readonly number[];
}

/** Runs of glyphs drawn as copies of one text: the glyphs of each copy, and the index of the copy compared. */
export interface DuplicateRuns {
  readonly copies: readonly (readonly number[])[];
  readonly kept: number;
}

export interface TextMatch {
  /**
   * `match` when every compared glyph is a real, painting glyph of its font whose text, after the folds listed, equals the intended text in the chosen order.
   * `mismatch` when a glyph is missing or unmapped or the texts differ; `unverified` when they agree only through ActualText a glyph does not confirm, with glyphs a clip or rectangle hides in part, or on a page whose content could not all be read, which a person must check.
   */
  readonly status: 'match' | 'mismatch' | 'unverified';
  readonly intended: string;
  /** The page's compared text, folds applied, for display; U+FFFD stands for a glyph without text. */
  readonly found: string;
  readonly differences: readonly TextDifference[];
  readonly folds: readonly FoldApplied[];
  readonly duplicates: readonly DuplicateRuns[];
  /** The keys of the fonts of the compared glyphs, in the order of first use. */
  readonly fonts: readonly string[];
  /** The compared glyphs in the order compared. */
  readonly glyphs: readonly number[];
  /** `glyph-checked` when the embedded cmap of every compared glyph's font maps the glyph's text to the glyph drawn; `glyph-text-only` when some glyph was checked by its text alone, as a Type 3 glyph or a simple font's always is. */
  readonly evidence: 'glyph-checked' | 'glyph-text-only';
}

// Variation selectors: U+FE00–U+FE0F and U+E0100–U+E01EF.
const isSelector = (codePoint: number): boolean => (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);

const WHITE_SPACE = /\p{White_Space}/u;

const REPLACEMENT = '�';

/** A character with the variation selectors after it. */
interface Cluster {
  readonly text: string;
  readonly offset: number;
}

// Splits text into clusters: a base character and the variation selectors that follow it.
const clusters = (text: string, keep: (character: string) => boolean): Cluster[] => {
  const result: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const character of text) {
    if (keep(character)) {
      const last = result.at(-1);
      if (last !== undefined && isSelector(character.codePointAt(0) ?? 0)) last.text += character;
      else result.push({ text: character, offset });
    }
    offset += character.length;
  }
  return result;
};

/** A cluster of the page's text, or a glyph that stands for no text. */
interface FoundCluster {
  readonly text: string;
  readonly glyphs: readonly number[];
  /** Whether the cluster's variation selectors come from ActualText only. */
  readonly variantFromActualText: boolean;
  /** The text without the variation selectors only ActualText gives, which an intended text without them compares with; the text itself when there are none. */
  readonly plain: string;
  readonly failure: { readonly kind: 'missing-glyph' } | { readonly kind: 'unmapped'; readonly reason: GlyphTextReason } | undefined;
}

const centre = (glyph: PageGlyph): readonly [number, number] => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = glyph.quad;
  return [(x0 + x1 + x2 + x3) / 4, (y0 + y1 + y2 + y3) / 4];
};

type Box = readonly [number, number, number, number];

// ISO 32000-1:2008, 14.11.2.1: "The crop, bleed, trim, and art boxes shall not ordinarily extend beyond the boundaries of the media box. If they do, they are effectively reduced to their intersection with the media box."
const visibleBox = (cropBox: Box | undefined, mediaBox: Box | undefined): Box | undefined => {
  if (cropBox === undefined || mediaBox === undefined) return cropBox ?? mediaBox;
  return [Math.max(cropBox[0], mediaBox[0]), Math.max(cropBox[1], mediaBox[1]), Math.min(cropBox[2], mediaBox[2]), Math.min(cropBox[3], mediaBox[3])];
};

/**
 * The default selection: glyphs that paint (or are empty Type 3 glyphs, which matchText reports as missing), not covered, whose core box is not entirely hidden, not clipped out or under a clip whose shape is unknown, and whose box's centre lies inside the CropBox reduced to the MediaBox.
 * ISO 32000-1:2008, 14.11.2.1: "The crop box defines the region to which the contents of the page shall be clipped (cropped) when displayed or printed".
 */
const defaultSelection = ({ cropBox, mediaBox }: PageText): ((glyph: PageGlyph) => boolean) => {
  const box = visibleBox(cropBox, mediaBox);
  return (glyph: PageGlyph): boolean => {
    if (!(glyph.visible || glyph.invisibleBecause === 'empty-glyph') || glyph.covered || glyph.coreHidden === 'entirely') return false;
    if (glyph.clip === 'outside' || glyph.clip === 'unknown') return false;
    if (box === undefined) return true;
    const [x, y] = centre(glyph);
    const [left, bottom, right, top] = box;
    return x >= left && x <= right && y >= bottom && y <= top;
  };
};

const onlyWhiteSpace = (text: string): boolean => /^\p{White_Space}*$/u.test(text);

type GlyphFailure = NonNullable<FoundCluster['failure']>;

// A glyph that stands for no text: .notdef, or an empty glyph that claims text, is a missing glyph; a glyph without text, or whose text layer maps it to the empty string, is unmapped; an empty glyph without text stands for nothing (null).
const glyphFailure = (glyph: PageGlyph): GlyphFailure | null | undefined => {
  const { text } = glyph;
  if (glyph.notdef || (glyph.empty && text !== null && !onlyWhiteSpace(text))) return { kind: 'missing-glyph' };
  if (text === null || text === '') return glyph.empty ? null : { kind: 'unmapped', reason: glyph.reason ?? 'no-mapping' };
  return undefined;
};

const isFailure = (failure: GlyphFailure | null | undefined): failure is GlyphFailure => failure !== undefined && failure !== null;

const SELECTORS = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

// A CJK font draws full-width and wide characters one em wide and their half-width forms half an em wide, to within these many ems; Chromium's W arrays give 1 and 0.5 exactly for Noto Sans JP, with or without palt, halt, vpal, vhal and text-spacing-trim.
const FULL_EM_TOLERANCE = 0.02;
const HALF_EM_TOLERANCE = 0.1;

// The ToUnicode character of a composite font's glyph when it is one full-width or wide character.
const wideCharacter = (glyph: PageGlyph): number | undefined => {
  if (glyph.cid === undefined || glyph.toUnicode === null) return undefined;
  const [character, ...rest] = Array.from(glyph.toUnicode, value => value.codePointAt(0) ?? 0);
  return character !== undefined && rest.length === 0 && isFullWidthOrWide(character) ? character : undefined;
};

// Whether a glyph whose ToUnicode character is full-width or wide is half an em wide.
const halfWidthOfWide = (glyph: PageGlyph): boolean =>
  wideCharacter(glyph) !== undefined && glyph.width !== undefined && Math.abs(glyph.width - 0.5) <= HALF_EM_TOLERANCE;

/** The fonts that show a full-width or wide character at a width neither one em nor half an em, so that a half-em width says nothing about which glyph is drawn. */
const proportionalFonts = (glyphs: readonly PageGlyph[]): Set<string> => {
  const fonts = new Set<string>();
  for (const glyph of glyphs) {
    const { width } = glyph;
    if (wideCharacter(glyph) === undefined || width === undefined) continue;
    if (Math.abs(width - 1) > FULL_EM_TOLERANCE && Math.abs(width - 0.5) > HALF_EM_TOLERANCE) fonts.add(glyph.font);
  }
  return fonts;
};

interface Settings {
  readonly actualText: 'checked' | 'ignore';
  readonly whitespace: 'ignore' | 'exact';
  readonly folds: readonly TextFold[];
  readonly equivalents: ReadonlyMap<string, string>;
  readonly selectors: 'require-glyph-evidence' | 'ignore';
  readonly cmaps: ReadonlyMap<string, EmbeddedCmap>;
  /** The keys of fonts whose embedded program has no usable cmap. */
  readonly uncheckable: ReadonlySet<string>;
  /** The compared glyphs set upright in a vertical column. */
  readonly upright: ReadonlySet<number>;
  /** The keys of Type 0 fonts that show a full-width or wide character at a width other than one em or half an em, as proportional fonts do. */
  readonly proportional: ReadonlySet<string>;
}

class FoundText {
  readonly clusters: FoundCluster[] = [];
  /** Differences that are not about alignment: spans that disagree with their glyphs or have none compared. */
  readonly notes: TextDifference[] = [];
  /** The glyphs whose font's embedded cmap maps their text to the glyph drawn. */
  readonly confirmed = new Set<number>();
  /** By font, the glyphs whose font's embedded program has no usable cmap to check them against. */
  readonly unchecked = new Map<string, number[]>();
  private readonly settings: Settings;
  private readonly folds = new Map<string, { fold: FoldApplied['fold']; from: string; to: string; glyphs: Set<number> }>();
  /** The glyphs added, by index. */
  private readonly shown = new Map<number, PageGlyph>();
  /** Clusters shown as another text, after a fold decided once the texts are aligned. */
  private readonly displayed = new Map<FoundCluster, string>();

  constructor(settings: Settings) {
    this.settings = settings;
  }

  foldsApplied(): FoldApplied[] {
    return [...this.folds.values()].map(({ fold, from, to, glyphs }) => ({ fold, from, to, glyphs: [...glyphs] }));
  }

  private recordFold(fold: FoldApplied['fold'], { from, to }: { from: string; to: string }, glyphs: readonly number[]): void {
    const key = `${fold}\u0000${from}\u0000${to}`;
    const entry = this.folds.get(key) ?? { fold, from, to, glyphs: new Set<number>() };
    for (const glyph of glyphs) entry.glyphs.add(glyph);
    this.folds.set(key, entry);
  }

  private keep(character: string): boolean {
    const codePoint = character.codePointAt(0) ?? 0;
    if (this.settings.whitespace === 'ignore' && WHITE_SPACE.test(character)) return false;
    return !(this.settings.selectors === 'ignore' && isSelector(codePoint));
  }

  // The page's reading of one glyph's text with folds applied, which is checked against the font's embedded cmap; the caller's equivalents come after.
  private read(glyph: PageGlyph, text: string): string {
    const folded = foldText(text, this.settings.folds);
    for (const use of folded.uses) this.recordFold(use.fold, use, [glyph.index]);
    this.check(glyph, folded.text);
    return folded.text;
  }

  // The caller's equivalent of a glyph's folded text, recorded as a fold, or the folded text itself.
  private equivalent(glyph: PageGlyph, folded: string): string {
    const equivalent = this.settings.equivalents.get(folded);
    if (equivalent === undefined) return folded;
    this.recordFold('caller', { from: folded, to: equivalent }, [glyph.index]);
    return equivalent;
  }

  /**
   * Checks a glyph's folded text against the embedded cmap of its font. A character with vertical alternates (Vertical_Orientation Tu or Tr) may be drawn with a glyph other than the one the cmap gives when it is set upright in a vertical column, as Chromium stacks such text.
   * A single character the cmap does not list, other than one with vertical alternates, is checked by `unlisted`.
   */
  private check(glyph: PageGlyph, text: string): void {
    if (this.settings.uncheckable.has(glyph.font) && glyph.gid !== undefined && !onlyWhiteSpace(text)) {
      const glyphs = this.unchecked.get(glyph.font);
      if (glyphs === undefined) this.unchecked.set(glyph.font, [glyph.index]);
      else glyphs.push(glyph.index);
      return;
    }
    const cmap = this.settings.cmaps.get(glyph.font);
    if (cmap === undefined || glyph.gid === undefined) return;
    const evidence = cmapEvidence(cmap, glyph.gid, text);
    const [character, ...rest] = Array.from(text, value => value.codePointAt(0) ?? 0);
    const single = character !== undefined && rest.length === 0 ? character : undefined;
    const alternate = single !== undefined && hasVerticalAlternate(single);
    if (evidence.kind === 'confirmed') this.confirmed.add(glyph.index);
    else if (evidence.kind === 'disagrees') {
      if (!(alternate && this.settings.upright.has(glyph.index))) {
        this.notes.push({ kind: 'glyph-disagrees', text, expectedGid: evidence.expected, drawnGid: glyph.gid, glyphs: [glyph.index] });
      }
    } else if (single !== undefined && !alternate) this.unlisted(glyph, { text, cmap, character: single });
  }

  /**
   * Checks a glyph whose one folded character the cmap does not list. When the cmap maps the glyph's own character, before folds, to the glyph drawn, the font tells the two apart, since Chromium's subset cmap lists every character of a retained glyph, so the glyph is not the folded character.
   * When the glyph is half an em wide while its ToUnicode character is full-width or wide, it is a half-width form, as Chromium's hwid draws without a span, unless its font shows such characters at proportional widths.
   */
  private unlisted(glyph: PageGlyph, { text, cmap, character }: { text: string; cmap: EmbeddedCmap; character: number }): void {
    if (glyph.gid === undefined) return;
    const own = glyph.text !== null && glyph.text !== text && cmapEvidence(cmap, glyph.gid, glyph.text).kind === 'confirmed';
    if (own || (halfWidthOfWide(glyph) && !this.settings.proportional.has(glyph.font))) {
      this.notes.push({ kind: 'glyph-disagrees', text, expectedGid: own ? undefined : cmap.glyph(character), drawnGid: glyph.gid, glyphs: [glyph.index] });
    }
  }

  // Whether a selector a span gives a one-glyph unit is confirmed by the format 14 subtable of the glyph's font.
  private variantByCmap(glyphs: readonly PageGlyph[], cluster: string): boolean {
    const [glyph] = glyphs;
    const cmap = glyph === undefined ? undefined : this.settings.cmaps.get(glyph.font);
    const [base, selector] = Array.from(cluster, character => character.codePointAt(0) ?? 0);
    if (glyph?.gid === undefined || cmap === undefined || glyphs.length > 1 || base === undefined || selector === undefined) return false;
    return variantConfirmed(cmap, glyph.gid, [base, selector]);
  }

  // Adds the clusters of a text; `plainOf` gives a cluster without the variation selectors only ActualText gives it.
  private push(text: string, glyphs: readonly number[], plainOf: (cluster: string) => string): void {
    for (const cluster of clusters(text, character => this.keep(character))) {
      const plain = plainOf(cluster.text);
      const variantFromActualText = plain !== cluster.text;
      this.clusters.push({ text: cluster.text, plain, glyphs, variantFromActualText, failure: undefined });
    }
  }

  /** Displays a cluster without the variation selectors only ActualText gives, as it was compared. */
  showPlain(cluster: FoundCluster): void {
    this.displayed.set(cluster, cluster.plain);
  }

  /** The compared text, with each cluster as it is displayed. */
  text(): string {
    return this.clusters.map(cluster => this.displayed.get(cluster) ?? cluster.text).join('');
  }

  /**
   * Accepts a found cluster of one glyph in place of an intended character when the glyph's font's embedded cmap maps that character to exactly the glyph drawn, since the font program itself says the glyph is that character; the fold is recorded.
   * Noto Sans JP draws 戸 with the glyph it also maps from U+2F3E, which Chromium's ToUnicode gives.
   */
  acceptByCmap(want: Cluster, have: FoundCluster): boolean {
    const [index] = have.glyphs;
    const glyph = index === undefined || have.glyphs.length > 1 ? undefined : this.shown.get(index);
    const cmap = glyph === undefined ? undefined : this.settings.cmaps.get(glyph.font);
    const [character, ...rest] = Array.from(want.text, value => value.codePointAt(0) ?? 0);
    if (have.failure !== undefined || glyph?.gid === undefined || cmap === undefined || character === undefined || rest.length > 0) return false;
    if (cmap.glyph(character) !== glyph.gid) return false;
    this.recordFold('embedded-cmap', { from: have.text, to: want.text }, have.glyphs);
    this.displayed.set(have, want.text);
    return true;
  }

  // Whether the embedded cmap of a one-glyph span's font maps the span's one character to exactly the glyph drawn, which then shows that character whatever its own text says; the fold is recorded.
  private spanByCmap(glyphs: readonly PageGlyph[], { glyphText, text }: { glyphText: string; text: string }): boolean {
    const [glyph] = glyphs;
    const cmap = glyph === undefined ? undefined : this.settings.cmaps.get(glyph.font);
    const [character, ...rest] = Array.from(text, value => value.codePointAt(0) ?? 0);
    if (glyphs.length !== 1 || glyph?.gid === undefined || cmap === undefined || character === undefined || rest.length > 0) return false;
    if (cmap.glyph(character) !== glyph.gid) return false;
    this.recordFold('embedded-cmap', { from: glyphText, to: text }, [glyph.index]);
    return true;
  }

  /** Adds a glyph outside any span used: a failure, nothing, or its clusters. */
  add(glyph: PageGlyph): void {
    this.shown.set(glyph.index, glyph);
    const glyphs = [glyph.index];
    const failure = glyphFailure(glyph);
    if (failure === null) return;
    if (failure !== undefined) {
      const shown = failure.kind === 'missing-glyph' ? (glyph.text ?? REPLACEMENT) : REPLACEMENT;
      this.clusters.push({ text: shown, plain: shown, glyphs, variantFromActualText: false, failure });
      return;
    }
    this.push(this.equivalent(glyph, this.read(glyph, glyph.text ?? '')), glyphs, cluster => cluster);
  }

  /**
   * Adds the glyphs of an ActualText span as one unit (ISO 32000-1:2008, 14.9.4: "The value of ActualText shall be considered to be a character substitution for the structure element or marked-content sequence").
   * A missing glyph fails the unit whatever the span claims, and the span's text is compared only when it agrees with the glyphs' folded text.
   */
  addSpan(glyphs: readonly PageGlyph[], { index, text }: { index: number; text: string }): void {
    for (const glyph of glyphs) this.shown.set(glyph.index, glyph);
    const indexes = glyphs.map(glyph => glyph.index);
    const failures = glyphs.map(glyph => glyphFailure(glyph)).filter(found => isFailure(found));
    const failure = failures.find(found => found.kind === 'missing-glyph') ?? failures[0];
    if (failure !== undefined) {
      const shown = failure.kind === 'missing-glyph' ? text : REPLACEMENT;
      this.clusters.push({ text: shown, plain: shown, glyphs: indexes, variantFromActualText: false, failure });
      return;
    }
    const folded = glyphs.map(glyph => (glyph.text === null ? '' : this.read(glyph, glyph.text)));
    const glyphText = folded.join('');
    const glyphSelectors = new Set(glyphText.match(SELECTORS));
    // ISO 32000-1:2008, 14.9.4 makes the span a character substitution; it is used only when its text equals the glyphs' own, apart from variation selectors the span has and the glyphs lack anywhere, which are set aside here and reported by the alignment.
    const lacking = (character: string): boolean => isSelector(character.codePointAt(0) ?? 0) && !glyphSelectors.has(character);
    const comparable = (value: string, setAside: (character: string) => boolean): string =>
      clusters(value, character => this.keep(character) && !setAside(character))
        .map(cluster => cluster.text)
        .join('');
    if (comparable(text, lacking) === comparable(glyphText, () => false) || this.spanByCmap(glyphs, { glyphText, text: comparable(text, () => false) })) {
      // The caller's equivalents apply after the check; where one applies, the glyphs' text with it takes the span's place.
      const equivalents = glyphs.map((glyph, at) => (glyph.text === null ? '' : this.equivalent(glyph, folded[at] ?? ''))).join('');
      if (equivalents !== glyphText) {
        this.push(equivalents, indexes, cluster => cluster);
        return;
      }
      this.push(text, indexes, cluster =>
        this.variantByCmap(glyphs, cluster) ? cluster : cluster.replaceAll(SELECTORS, selector => (lacking(selector) ? '' : selector)),
      );
      return;
    }
    this.notes.push({ kind: 'actual-text-disagrees', actualText: text, glyphText, span: index, glyphs: indexes });
    this.push(glyphs.map((glyph, at) => (glyph.text === null ? '' : this.equivalent(glyph, folded[at] ?? ''))).join(''), indexes, cluster => cluster);
  }

  /** Notes a span with no compared glyph between compared glyphs, unless its text is only white space that is ignored. */
  addUnseenSpan({ index, text }: { index: number; text: string }): void {
    if (this.settings.whitespace === 'ignore' && onlyWhiteSpace(text)) return;
    this.notes.push({ kind: 'no-glyph-evidence', text, span: index });
  }
}

// A failure placed against an intended character, or on its own.
const failureDifference = (found: FoundCluster, intendedIndex?: number): TextDifference | undefined => {
  if (found.failure?.kind === 'missing-glyph') return { kind: 'missing-glyph', glyphs: found.glyphs, intendedIndex };
  if (found.failure?.kind === 'unmapped') return { kind: 'unmapped', glyphs: found.glyphs, reason: found.failure.reason };
  return undefined;
};

// The unmatched intended and found clusters between two matches: pairs in order are substitutions, unless the found text accepts the intended character, and the rest missing or extra.
const gapDifferences = (intended: readonly Cluster[], found: readonly FoundCluster[], text: FoundText): TextDifference[] => {
  const differences: TextDifference[] = [];
  const paired = Math.min(intended.length, found.length);
  for (let index = 0; index < Math.max(intended.length, found.length); index++) {
    const want = intended[index];
    const have = found[index];
    if (index < paired && want !== undefined && have !== undefined) {
      const failure = failureDifference(have, want.offset);
      if (failure !== undefined) differences.push(failure);
      else if (!text.acceptByCmap(want, have)) {
        differences.push({ kind: 'substituted', intended: want.text, found: have.text, intendedIndex: want.offset, glyphs: have.glyphs });
      }
    } else if (want !== undefined) differences.push({ kind: 'missing', intended: want.text, intendedIndex: want.offset });
    else if (have !== undefined) differences.push(failureDifference(have) ?? { kind: 'extra', found: have.text, glyphs: have.glyphs });
  }
  return differences;
};

const differencesOf = (steps: readonly AlignmentStep[], intended: readonly Cluster[], text: FoundText): TextDifference[] => {
  const found = text.clusters;
  const differences: TextDifference[] = [];
  let wanted: Cluster[] = [];
  let had: FoundCluster[] = [];
  const flush = (): void => {
    for (const difference of gapDifferences(wanted, had, text)) differences.push(difference);
    wanted = [];
    had = [];
  };
  for (const step of steps) {
    if (step.kind === 'equal') {
      flush();
      const want = intended[step.intended];
      const have = found[step.found];
      // A cluster matched by its text without the selectors only ActualText gives is compared as the glyphs show it.
      if (have !== undefined && have.text !== want?.text) text.showPlain(have);
      else if (want !== undefined && have?.variantFromActualText === true) {
        differences.push({ kind: 'variant-unverified', intended: want.text, intendedIndex: want.offset, glyphs: have.glyphs });
      }
    } else if (step.kind === 'missing') {
      const cluster = intended[step.intended];
      if (cluster !== undefined) wanted.push(cluster);
    } else {
      const cluster = found[step.found];
      if (cluster !== undefined) had.push(cluster);
    }
  }
  flush();
  return differences;
};

// Copies of a run must repeat its glyph origins within this fraction of the font size.
const TRANSLATION_TOLERANCE = 0.005;

// A copy lies closer than this fraction of the font size to the first run: a shadow's offset, not a character set beside another.
const COPY_DISTANCE = 0.25;

const sameCode = (a: PageGlyph, b: PageGlyph): boolean =>
  a.font === b.font && a.code.length === b.code.length && a.code.every((byte, index) => byte === b.code[index]);

// Whether the runs are copies of the first: the same codes in the same fonts, with origins moved by one translation per copy, shorter than a quarter of the font size and half the run's advance so that the copies overlap.
const copies = (runs: readonly (readonly PageGlyph[])[]): boolean => {
  const [first, ...rest] = runs;
  if (first === undefined) return false;
  const length = first.reduce((sum, glyph) => sum + Math.hypot(...glyph.advance), 0);
  return rest.every(run => {
    const [head] = run;
    const [base] = first;
    if (head === undefined || base === undefined) return false;
    const [dx, dy] = [head.origin[0] - base.origin[0], head.origin[1] - base.origin[1]];
    const distance = Math.hypot(dx, dy);
    if (distance >= length / 2 || distance >= COPY_DISTANCE * base.fontSize) return false;
    return run.every((glyph, index) => {
      const original = first[index];
      if (original === undefined || !sameCode(glyph, original) || !glyph.positionKnown || !original.positionKnown) return false;
      const drift = Math.hypot(glyph.origin[0] - original.origin[0] - dx, glyph.origin[1] - original.origin[1] - dy);
      return drift <= TRANSLATION_TOLERANCE * original.fontSize;
    });
  });
};

/** Splits the glyphs into the most consecutive equal-length runs that are copies of the first, when there are two or more. */
const duplicateRuns = (glyphs: readonly PageGlyph[]): (readonly PageGlyph[])[] | undefined => {
  for (let count = glyphs.length; count >= 2; count--) {
    if (glyphs.length % count !== 0) continue;
    const size = glyphs.length / count;
    const runs = Array.from({ length: count }, (_, index) => glyphs.slice(index * size, (index + 1) * size));
    if (copies(runs)) return runs;
  }
  return undefined;
};

// Each run of adjacent glyphs, in the order compared, whose core box is partly hidden.
const partlyHidden = (selected: readonly PageGlyph[]): TextDifference[] => {
  const runs: number[][] = [];
  let run: number[] | undefined = undefined;
  for (const glyph of selected) {
    if (glyph.coreHidden !== 'partly') run = undefined;
    else if (run === undefined) {
      run = [glyph.index];
      runs.push(run);
    } else run.push(glyph.index);
  }
  return runs.map(glyphs => ({ kind: 'partly-hidden', glyphs }));
};

const MISMATCHES = new Set<TextDifference['kind']>(['missing-glyph', 'unmapped', 'substituted', 'missing', 'extra']);

/** A glyph compared on its own, or the compared glyphs of an ActualText span, or a span none of whose glyphs is compared. */
type Unit =
  | { readonly kind: 'glyph'; readonly glyph: PageGlyph }
  | { readonly kind: 'span'; readonly index: number; readonly glyphs: readonly PageGlyph[] }
  | { readonly kind: 'unseen'; readonly index: number };

// Whether a span's compared glyphs are read one after another, with no other glyph between them.
const readTogether = (glyphs: readonly PageGlyph[], positions: ReadonlyMap<number, number>): boolean => {
  const read = glyphs.map(glyph => positions.get(glyph.index) ?? -1).toSorted((a, b) => a - b);
  return read.every((position, index) => index === 0 || position === (read[index - 1] ?? 0) + 1);
};

// The smallest and largest of the values, by a loop, since spreading a long array into Math.min exceeds the call stack.
const extent = (values: readonly number[]): readonly [number, number] => {
  let [low, high] = [Infinity, -Infinity];
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return [low, high];
};

// Units in reading order: a span is taken whole where its first compared glyph is read, when its compared glyphs are read together, and otherwise its glyphs are compared one by one; a span with no compared glyph lies between compared glyphs when compared glyphs come before and after it in content order.
const unitsOf = (page: PageText, selected: readonly PageGlyph[], actualText: 'checked' | 'ignore'): Unit[] => {
  if (actualText === 'ignore') return selected.map(glyph => ({ kind: 'glyph', glyph }));
  const bySpan = new Map<number, PageGlyph[]>();
  for (const glyph of selected) {
    if (glyph.actualText === undefined) continue;
    const glyphs = bySpan.get(glyph.actualText);
    if (glyphs === undefined) bySpan.set(glyph.actualText, [glyph]);
    else glyphs.push(glyph);
  }
  const positions = new Map(selected.map((glyph, position) => [glyph.index, position]));
  for (const [index, glyphs] of bySpan) if (!readTogether(glyphs, positions)) bySpan.delete(index);
  const [first, last] = extent(selected.map(glyph => glyph.index));
  const unseen = page.actualText
    .flatMap((span, index) => {
      if (span.glyphs.some(glyph => positions.has(glyph)) || span.glyphs.length === 0) return [];
      const [start, end] = extent(span.glyphs);
      return first < start && last > end ? [{ index, start }] : [];
    })
    .toSorted((a, b) => a.start - b.start);
  const units: Unit[] = [];
  const taken = new Set<number>();
  let next = 0;
  for (const glyph of selected) {
    for (let note = unseen[next]; note !== undefined && note.start < glyph.index; note = unseen[++next]) units.push({ kind: 'unseen', index: note.index });
    const spanIndex = glyph.actualText;
    if (spanIndex === undefined || !bySpan.has(spanIndex)) units.push({ kind: 'glyph', glyph });
    else if (!taken.has(spanIndex)) {
      taken.add(spanIndex);
      units.push({ kind: 'span', index: spanIndex, glyphs: bySpan.get(spanIndex) ?? [glyph] });
    }
  }
  return units;
};

// An option value outside its type, as a caller without type checking can pass, is refused rather than read as some other value; the first allowed value is the default.
const choice = <T extends string>(name: string, value: T | undefined, allowed: readonly [T, ...T[]]): T => {
  if (value === undefined) return allowed[0];
  if (!allowed.includes(value)) throw new InvalidArgumentError(`matchText: ${name} ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`);
  return value;
};

const settingsOf = (page: PageText, options: MatchTextOptions): Settings => ({
  actualText: choice('actualText', options.actualText, ['checked', 'ignore']),
  whitespace: choice('whitespace', options.whitespace, ['ignore', 'exact']),
  folds: (options.folds ?? TEXT_FOLDS).map(fold => choice('folds', fold, ['radicals', 'vertical-forms', 'ligatures', 'shared-glyphs'])),
  equivalents: new Map(options.equivalents),
  selectors: choice('variationSelectors', options.variationSelectors, ['require-glyph-evidence', 'ignore']),
  cmaps: new Map(page.fonts.flatMap(font => (font.cmap === undefined ? [] : [[font.key, font.cmap] as const]))),
  uncheckable: new Set(page.fonts.filter(font => font.cmapMissing).map(font => font.key)),
  upright: new Set(),
  proportional: proportionalFonts(page.glyphs),
});

// A glyph read after another lies in the same column when its origin is between half an em and two ems further down the first glyph's vertical axis and less than half an em across it.
const COLUMN_STEP: readonly [number, number] = [0.5, 2];
const COLUMN_OFFSET = 0.5;

const direction = (x: number, y: number): readonly [number, number] | undefined => {
  const length = Math.hypot(x, y);
  return length === 0 ? undefined : [x / length, y / length];
};

/** The glyphs that, with the glyph read before or after them, are stacked down a column upright, as Chromium sets upright text in vertical writing one Td per glyph. */
const uprightInColumns = (glyphs: readonly PageGlyph[]): Set<number> => {
  const upright = new Set<number>();
  for (const [position, first] of glyphs.entries()) {
    const next = glyphs[position + 1];
    if (next === undefined || !first.positionKnown || !next.positionKnown) continue;
    const { quad } = first;
    const [x0, y0, x1, y1] = quad;
    const [x3, y3] = [quad[6], quad[7]];
    const [up, along] = [direction(x3 - x0, y3 - y0), direction(x1 - x0, y1 - y0)];
    if (up === undefined || along === undefined) continue;
    const [dx, dy] = [next.origin[0] - first.origin[0], next.origin[1] - first.origin[1]];
    const down = -(dx * up[0] + dy * up[1]);
    const across = dx * along[0] + dy * along[1];
    const size = first.fontSize;
    if (down >= COLUMN_STEP[0] * size && down <= COLUMN_STEP[1] * size && Math.abs(across) < COLUMN_OFFSET * size) {
      upright.add(first.index);
      upright.add(next.index);
    }
  }
  return upright;
};

const readUnits = (found: FoundText, page: PageText, units: readonly Unit[]): void => {
  for (const unit of units) {
    if (unit.kind === 'glyph') found.add(unit.glyph);
    else {
      const text = page.actualText[unit.index]?.text ?? '';
      if (unit.kind === 'span') found.addSpan(unit.glyphs, { index: unit.index, text });
      else found.addUnseenSpan({ index: unit.index, text });
    }
  }
};

// 'mismatch' for any difference in the printed text, 'unverified' for agreement that rests on ActualText, on text a glyph's font program contradicts, on glyphs partly hidden, or on a page not wholly read.
const statusOf = (differences: readonly TextDifference[]): TextMatch['status'] => {
  if (differences.some(difference => MISMATCHES.has(difference.kind))) return 'mismatch';
  return differences.length > 0 ? 'unverified' : 'match';
};

/**
 * Compares the text a page shows with an intended text, code point for code point after a small set of reported folds on the page's side; neither side is normalised.
 * `match` means every compared glyph is a real, painting glyph of its font, visible by the checks of `extractText`, and the glyphs' own text equals the intended text in the chosen order after the listed folds.
 * A mode option (`order`, `whitespace`, `folds`, `actualText`, `variationSelectors`, `duplicates`) outside its type throws InvalidArgumentError.
 * It does not prove that the shapes are right, that no fallback font was used (the result lists the fonts), or anything about sizes, positions, colours, or covering by anything other than opaque rectangles. A caller automating a check treats anything but `match` as a rejection.
 * Known limits, where `match` can be returned for text that does not print:
 * - Text under a soft mask counts as visible, so a mask that hides it entirely, such as a fully transparent mask image, is not detected.
 * - Glyphs are measured by boxes, not outlines, tested at a 5 × 5 grid of points: a clip or rectangle that hides ink only between the points, or outside the core box of a glyph whose font gives no ink box, such as a Latin descender, is not detected, and neither is an even-odd clip whose hole holds the ink.
 * - A Type 3 glyph procedure counts as painting when it contains a painting operator, even one that paints a zero-area or clipped-away path.
 * - A painting glyph whose text is white space is ignored with `whitespace: 'ignore'`, whatever it shows, unless its font's embedded cmap maps that character to another glyph.
 * - A glyph whose ToUnicode claims another character than the one it shows, without an ActualText span, is not detected when the font's embedded cmap does not list that character, since a subset drops the characters of glyphs it does not keep and vertical text leaves many characters unlisted too; only a half-width form of a full-width or wide character is caught then, by its width, and not in a font that shows such characters at proportional widths.
 * - Optional content is not evaluated: text and covering fills in an optional content group count as printed whether the group is on or off.
 * - Annotations drawn over the text count only when the page was extracted with `annotations: 'printable'`, which a caller checking a print proof passes to `extractText`; with the default `'none'` they are not read.
 * - Alpha is tested only for 0: text at an alpha near zero counts as visible. `PageGlyph.fillAlpha` and `strokeAlpha` give the alpha of each glyph for a caller to set its own bound.
 * - A fill with a tiling pattern whose cells paint nothing over the text is not detected, and neither is any other fill that is not an opaque rectangle.
 */
export const matchText = (page: PageText, intended: string, options: MatchTextOptions = {}): TextMatch => {
  const settings = settingsOf(page, options);
  const duplicates = choice('duplicates', options.duplicates, ['collapse', 'keep']);
  const ordered = orderGlyphs(page.glyphs.filter(options.select ?? defaultSelection(page)), options.order ?? 'content');
  const runs = duplicates === 'collapse' ? duplicateRuns(ordered) : undefined;
  const selected = runs?.at(-1) ?? ordered;
  const found = new FoundText({ ...settings, upright: uprightInColumns(selected) });
  readUnits(found, page, unitsOf(page, selected, settings.actualText));
  const keep = (character: string): boolean =>
    !(settings.whitespace === 'ignore' && WHITE_SPACE.test(character)) && !(settings.selectors === 'ignore' && isSelector(character.codePointAt(0) ?? 0));
  const wanted = clusters(intended, keep);
  const steps = align(wanted.length, found.clusters.length, (a, b) => {
    const have = found.clusters[b];
    const want = wanted[a]?.text;
    return have !== undefined && have.failure === undefined && (have.text === want || have.plain === want);
  });
  const unchecked = [...found.unchecked].map(([font, glyphs]): TextDifference => ({ kind: 'glyph-unchecked', font, glyphs }));
  const incomplete: TextDifference[] = page.complete ? [] : [{ kind: 'page-incomplete' }];
  const differences = [...differencesOf(steps, wanted, found), ...found.notes, ...unchecked, ...partlyHidden(selected), ...incomplete];
  return {
    status: statusOf(differences),
    intended,
    found: found.text(),
    differences,
    folds: found.foldsApplied(),
    duplicates: runs === undefined ? [] : [{ copies: runs.map(run => run.map(glyph => glyph.index)), kept: runs.length - 1 }],
    fonts: [...new Set(selected.map(glyph => glyph.font))],
    glyphs: selected.map(glyph => glyph.index),
    evidence: selected.length > 0 && selected.every(glyph => found.confirmed.has(glyph.index)) ? 'glyph-checked' : 'glyph-text-only',
  };
};

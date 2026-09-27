import type { AlignmentStep } from './alignment.ts';
import type { GlyphTextReason, PageGlyph, PageText } from './extractText.ts';
import type { TextFold } from './folds.ts';
import type { EmbeddedCmap } from './glyphEvidence.ts';
import type { GlyphLayout } from './orderGlyphs.ts';

import { align } from './alignment.ts';
import { TEXT_FOLDS, foldText } from './folds.ts';
import { cmapEvidence, variantConfirmed } from './glyphEvidence.ts';
import { orderGlyphs } from './orderGlyphs.ts';

export interface MatchTextOptions {
  /** Which glyphs count; by default those that are visible or only empty, not covered, not clipped out or under a clip whose shape is unknown, and whose box's centre lies inside the CropBox. */
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
   * `collapse` (the default): when the selected glyphs are two or more consecutive runs of the same codes in the same fonts, each an exact translation of the first by less than a quarter of the font size and half the run's advance, as Chromium draws text with text-shadow, -webkit-text-stroke or mask-image, only the last run drawn is compared.
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
  /** A glyph without text. */
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
  /** A glyph of an embedded TrueType font whose cmap maps the glyph's text to another glyph than the one drawn. */
  | { readonly kind: 'glyph-disagrees'; readonly text: string; readonly expectedGid: number; readonly drawnGid: number; readonly glyphs: readonly number[] }
  /**
   * Glyphs of a Type 0 font with a CIDFontType2 descendant whose embedded TrueType program has no usable Unicode cmap, so that the program gives no evidence that the glyph drawn is the one the text names.
   * Chromium's hwid substitution changes the glyph without an ActualText span, and a subset whose only glyphs are such alternates keeps a cmap table without subtables.
   */
  | { readonly kind: 'glyph-unchecked'; readonly font: string; readonly glyphs: readonly number[] }
  /** An ActualText span none of whose glyphs is compared, between compared glyphs. */
  | { readonly kind: 'no-glyph-evidence'; readonly text: string; readonly span: number };

/** A fold used on the page's text, with the glyphs it was used for. */
export interface FoldApplied {
  readonly fold: TextFold | 'caller';
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
   * `mismatch` when a glyph is missing or unmapped or the texts differ; `unverified` when they agree only through ActualText a glyph does not confirm, which a person must check.
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
  readonly failure: { readonly kind: 'missing-glyph' } | { readonly kind: 'unmapped'; readonly reason: GlyphTextReason } | undefined;
}

const centre = (glyph: PageGlyph): readonly [number, number] => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = glyph.quad;
  return [(x0 + x1 + x2 + x3) / 4, (y0 + y1 + y2 + y3) / 4];
};

/**
 * The default selection: glyphs that paint (or are empty Type 3 glyphs, which matchText reports as missing), not covered, not clipped out or under a clip whose shape is unknown, and whose box's centre lies inside the CropBox.
 * ISO 32000-1:2008, 14.11.2.1: "The crop box defines the region to which the contents of the page shall be clipped (cropped) when displayed or printed".
 */
const defaultSelection =
  ({ cropBox }: PageText) =>
  (glyph: PageGlyph): boolean => {
    if (!(glyph.visible || glyph.invisibleBecause === 'empty-glyph') || glyph.covered || glyph.clip === 'outside' || glyph.clip === 'unknown') return false;
    if (cropBox === undefined) return true;
    const [x, y] = centre(glyph);
    const [left, bottom, right, top] = cropBox;
    return x >= left && x <= right && y >= bottom && y <= top;
  };

const onlyWhiteSpace = (text: string): boolean => /^\p{White_Space}*$/u.test(text);

type GlyphFailure = NonNullable<FoundCluster['failure']>;

// A glyph that stands for no text: .notdef, or an empty glyph that claims text, is a missing glyph; a glyph without text is unmapped; an empty glyph without text stands for nothing (null).
const glyphFailure = (glyph: PageGlyph): GlyphFailure | null | undefined => {
  const { text } = glyph;
  if (glyph.notdef || (glyph.empty && text !== null && !onlyWhiteSpace(text))) return { kind: 'missing-glyph' };
  if (text === null) return glyph.empty ? null : { kind: 'unmapped', reason: glyph.reason ?? 'no-mapping' };
  return undefined;
};

const isFailure = (failure: GlyphFailure | null | undefined): failure is GlyphFailure => failure !== undefined && failure !== null;

const SELECTORS = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

interface Settings {
  readonly actualText: 'checked' | 'ignore';
  readonly whitespace: 'ignore' | 'exact';
  readonly folds: readonly TextFold[];
  readonly equivalents: ReadonlyMap<string, string>;
  readonly selectors: 'require-glyph-evidence' | 'ignore';
  readonly cmaps: ReadonlyMap<string, EmbeddedCmap>;
  /** The keys of fonts whose embedded program has no usable cmap. */
  readonly uncheckable: ReadonlySet<string>;
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
  private readonly folds = new Map<string, { fold: TextFold | 'caller'; from: string; to: string; glyphs: number[] }>();

  constructor(settings: Settings) {
    this.settings = settings;
  }

  foldsApplied(): FoldApplied[] {
    return [...this.folds.values()];
  }

  private recordFold(fold: TextFold | 'caller', { from, to }: { from: string; to: string }, glyphs: readonly number[]): void {
    const key = `${fold}\u0000${from}\u0000${to}`;
    const entry = this.folds.get(key) ?? { fold, from, to, glyphs: [] };
    entry.glyphs.push(...glyphs.filter(glyph => !entry.glyphs.includes(glyph)));
    this.folds.set(key, entry);
  }

  private keep(character: string): boolean {
    const codePoint = character.codePointAt(0) ?? 0;
    if (this.settings.whitespace === 'ignore' && WHITE_SPACE.test(character)) return false;
    return !(this.settings.selectors === 'ignore' && isSelector(codePoint));
  }

  // The page's reading of one glyph's text: folds, then the caller's equivalents; the folded text, before the equivalents, is checked against the font's embedded cmap.
  private read(glyph: PageGlyph, text: string): string {
    const glyphs = [glyph.index];
    const folded = foldText(text, this.settings.folds);
    for (const use of folded.uses) this.recordFold(use.fold, use, glyphs);
    this.check(glyph, folded.text);
    const equivalent = this.settings.equivalents.get(folded.text);
    if (equivalent === undefined) return folded.text;
    this.recordFold('caller', { from: folded.text, to: equivalent }, glyphs);
    return equivalent;
  }

  private check(glyph: PageGlyph, text: string): void {
    if (this.settings.uncheckable.has(glyph.font) && glyph.gid !== undefined && !onlyWhiteSpace(text)) {
      this.unchecked.set(glyph.font, [...(this.unchecked.get(glyph.font) ?? []), glyph.index]);
      return;
    }
    const cmap = this.settings.cmaps.get(glyph.font);
    if (cmap === undefined || glyph.gid === undefined) return;
    const evidence = cmapEvidence(cmap, glyph.gid, text);
    if (evidence.kind === 'confirmed') {
      this.confirmed.add(glyph.index);
      return;
    }
    if (evidence.kind === 'disagrees') {
      this.notes.push({ kind: 'glyph-disagrees', text, expectedGid: evidence.expected, drawnGid: glyph.gid, glyphs: [glyph.index] });
    }
  }

  // Whether a selector a span gives a one-glyph unit is confirmed by the format 14 subtable of the glyph's font.
  private variantByCmap(glyphs: readonly PageGlyph[], cluster: string): boolean {
    const [glyph, ...rest] = glyphs;
    const cmap = glyph === undefined ? undefined : this.settings.cmaps.get(glyph.font);
    const [base, selector] = Array.from(cluster, character => character.codePointAt(0) ?? 0);
    if (glyph?.gid === undefined || cmap === undefined || rest.length > 0 || base === undefined || selector === undefined) return false;
    return variantConfirmed(cmap, glyph.gid, [base, selector]);
  }

  private push(text: string, glyphs: readonly number[], variantFromActualText: (cluster: string) => boolean): void {
    for (const cluster of clusters(text, character => this.keep(character))) {
      this.clusters.push({ text: cluster.text, glyphs, variantFromActualText: variantFromActualText(cluster.text), failure: undefined });
    }
  }

  /** Adds a glyph outside any span used: a failure, nothing, or its clusters. */
  add(glyph: PageGlyph): void {
    const glyphs = [glyph.index];
    const failure = glyphFailure(glyph);
    if (failure === null) return;
    if (failure !== undefined) {
      this.clusters.push({ text: glyph.text ?? REPLACEMENT, glyphs, variantFromActualText: false, failure });
      return;
    }
    this.push(this.read(glyph, glyph.text ?? ''), glyphs, () => false);
  }

  /**
   * Adds the glyphs of an ActualText span as one unit (ISO 32000-1:2008, 14.9.4: "The value of ActualText shall be considered to be a character substitution for the structure element or marked-content sequence").
   * A missing glyph fails the unit whatever the span claims, and the span's text is compared only when it agrees with the glyphs' folded text.
   */
  addSpan(glyphs: readonly PageGlyph[], { index, text }: { index: number; text: string }): void {
    const indexes = glyphs.map(glyph => glyph.index);
    const failures = glyphs.map(glyph => glyphFailure(glyph)).filter(found => isFailure(found));
    const failure = failures.find(found => found.kind === 'missing-glyph') ?? failures[0];
    if (failure !== undefined) {
      this.clusters.push({ text: failure.kind === 'missing-glyph' ? text : REPLACEMENT, glyphs: indexes, variantFromActualText: false, failure });
      return;
    }
    const glyphText = glyphs.map(glyph => (glyph.text === null ? '' : this.read(glyph, glyph.text))).join('');
    // ISO 32000-1:2008, 14.9.4 makes the span a character substitution; it is used only when its text equals the glyphs' own, apart from variation selectors the span has and the glyphs lack anywhere, which are set aside here and reported by the alignment.
    const lacking = (character: string): boolean => isSelector(character.codePointAt(0) ?? 0) && !glyphText.includes(character);
    const comparable = (value: string, setAside: (character: string) => boolean): string =>
      clusters(value, character => this.keep(character) && !setAside(character))
        .map(cluster => cluster.text)
        .join('');
    if (comparable(text, lacking) === comparable(glyphText, () => false)) {
      this.push(text, indexes, cluster => (cluster.match(SELECTORS) ?? []).some(selector => lacking(selector)) && !this.variantByCmap(glyphs, cluster));
      return;
    }
    this.notes.push({ kind: 'actual-text-disagrees', actualText: text, glyphText, span: index, glyphs: indexes });
    this.push(glyphText, indexes, () => false);
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

// The unmatched intended and found clusters between two matches: pairs in order are substitutions, the rest missing or extra.
const gapDifferences = (intended: readonly Cluster[], found: readonly FoundCluster[]): TextDifference[] => {
  const differences: TextDifference[] = [];
  const paired = Math.min(intended.length, found.length);
  for (let index = 0; index < Math.max(intended.length, found.length); index++) {
    const want = intended[index];
    const have = found[index];
    if (index < paired && want !== undefined && have !== undefined) {
      differences.push(
        failureDifference(have, want.offset) ?? { kind: 'substituted', intended: want.text, found: have.text, intendedIndex: want.offset, glyphs: have.glyphs },
      );
    } else if (want !== undefined) differences.push({ kind: 'missing', intended: want.text, intendedIndex: want.offset });
    else if (have !== undefined) differences.push(failureDifference(have) ?? { kind: 'extra', found: have.text, glyphs: have.glyphs });
  }
  return differences;
};

const differencesOf = (steps: readonly AlignmentStep[], intended: readonly Cluster[], found: readonly FoundCluster[]): TextDifference[] => {
  const differences: TextDifference[] = [];
  let wanted: Cluster[] = [];
  let had: FoundCluster[] = [];
  const flush = (): void => {
    differences.push(...gapDifferences(wanted, had));
    wanted = [];
    had = [];
  };
  for (const step of steps) {
    if (step.kind === 'equal') {
      flush();
      const want = intended[step.intended];
      const have = found[step.found];
      if (want !== undefined && have?.variantFromActualText === true) {
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

// Units in reading order: a span is taken whole where its first compared glyph is read, when its compared glyphs are read together, and otherwise its glyphs are compared one by one; a span with no compared glyph lies between compared glyphs when compared glyphs come before and after it in content order.
const unitsOf = (page: PageText, selected: readonly PageGlyph[], actualText: 'checked' | 'ignore'): Unit[] => {
  if (actualText === 'ignore') return selected.map(glyph => ({ kind: 'glyph', glyph }));
  const bySpan = new Map<number, PageGlyph[]>();
  for (const glyph of selected) if (glyph.actualText !== undefined) bySpan.set(glyph.actualText, [...(bySpan.get(glyph.actualText) ?? []), glyph]);
  const positions = new Map(selected.map((glyph, position) => [glyph.index, position]));
  for (const [index, glyphs] of bySpan) if (!readTogether(glyphs, positions)) bySpan.delete(index);
  const selectedIndexes = selected.map(glyph => glyph.index);
  const first = Math.min(...selectedIndexes);
  const last = Math.max(...selectedIndexes);
  const unseen = page.actualText
    .flatMap((span, index) => {
      if (span.glyphs.some(glyph => positions.has(glyph)) || span.glyphs.length === 0) return [];
      const start = Math.min(...span.glyphs);
      return first < start && last > Math.max(...span.glyphs) ? [{ index, start }] : [];
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

const settingsOf = (page: PageText, options: MatchTextOptions): Settings => ({
  actualText: options.actualText ?? 'checked',
  whitespace: options.whitespace ?? 'ignore',
  folds: options.folds ?? TEXT_FOLDS,
  equivalents: new Map(options.equivalents),
  selectors: options.variationSelectors ?? 'require-glyph-evidence',
  cmaps: new Map(page.fonts.flatMap(font => (font.cmap === undefined ? [] : [[font.key, font.cmap] as const]))),
  uncheckable: new Set(page.fonts.filter(font => font.cmapMissing).map(font => font.key)),
});

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

// 'mismatch' for any difference in the printed text, 'unverified' for agreement that rests on ActualText or text a glyph's font program contradicts.
const statusOf = (differences: readonly TextDifference[]): TextMatch['status'] => {
  if (differences.some(difference => MISMATCHES.has(difference.kind))) return 'mismatch';
  return differences.length > 0 ? 'unverified' : 'match';
};

/**
 * Compares the text a page shows with the text it is meant to show, such as a customer's name on a proof, code point for code point after a small set of reported folds on the page's side; neither side is normalised.
 * `match` means every compared glyph is a real, painting glyph of its font, visible by the checks of `extractText`, and the glyphs' own text equals the intended text in the chosen order after the listed folds.
 * It does not prove that the shapes are right, that no fallback font was used (the result lists the fonts), or anything about sizes, positions, colours, or covering by anything other than opaque rectangles. A caller automating a check treats anything but `match` as a rejection.
 * Known limits, where `match` can be returned for text that does not print:
 * - Text under a soft mask counts as visible, so a mask that hides it entirely, such as a fully transparent mask image, is not detected.
 * - Boxes are advance boxes, not ink: a rectangle or clip that hides the glyph's ink but not the part of the box the font's ascent or descent adds leaves the glyph selected, and so does an even-odd clip whose hole holds the ink.
 * - A Type 3 glyph procedure counts as painting when it contains a painting operator, even one that paints a zero-area or clipped-away path.
 * - A painting glyph whose text is white space is ignored with `whitespace: 'ignore'`, whatever it shows, unless its font's embedded cmap maps that character to another glyph.
 */
export const matchText = (page: PageText, intended: string, options: MatchTextOptions = {}): TextMatch => {
  const settings = settingsOf(page, options);
  const ordered = orderGlyphs(page.glyphs.filter(options.select ?? defaultSelection(page)), options.order ?? 'content');
  const runs = (options.duplicates ?? 'collapse') === 'collapse' ? duplicateRuns(ordered) : undefined;
  const selected = runs?.at(-1) ?? ordered;
  const found = new FoundText(settings);
  readUnits(found, page, unitsOf(page, selected, settings.actualText));
  const keep = (character: string): boolean =>
    !(settings.whitespace === 'ignore' && WHITE_SPACE.test(character)) && !(settings.selectors === 'ignore' && isSelector(character.codePointAt(0) ?? 0));
  const wanted = clusters(intended, keep);
  const steps = align(wanted.length, found.clusters.length, (a, b) => {
    const have = found.clusters[b];
    return have !== undefined && have.failure === undefined && have.text === wanted[a]?.text;
  });
  const unchecked = [...found.unchecked].map(([font, glyphs]): TextDifference => ({ kind: 'glyph-unchecked', font, glyphs }));
  const differences = [...differencesOf(steps, wanted, found.clusters), ...found.notes, ...unchecked];
  return {
    status: statusOf(differences),
    intended,
    found: found.clusters.map(cluster => cluster.text).join(''),
    differences,
    folds: found.foldsApplied(),
    duplicates: runs === undefined ? [] : [{ copies: runs.map(run => run.map(glyph => glyph.index)), kept: runs.length - 1 }],
    fonts: [...new Set(selected.map(glyph => glyph.font))],
    glyphs: selected.map(glyph => glyph.index),
    evidence: selected.length > 0 && selected.every(glyph => found.confirmed.has(glyph.index)) ? 'glyph-checked' : 'glyph-text-only',
  };
};

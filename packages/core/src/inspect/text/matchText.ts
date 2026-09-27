import type { AlignmentStep } from './alignment.ts';
import type { GlyphTextReason, PageGlyph, PageText } from './extractText.ts';
import type { TextFold } from './folds.ts';
import type { GlyphLayout } from './orderGlyphs.ts';

import { align } from './alignment.ts';
import { TEXT_FOLDS, foldText } from './folds.ts';
import { orderGlyphs } from './orderGlyphs.ts';

export interface MatchTextOptions {
  /** Which glyphs count; by default those that are visible or only empty, not covered, not clipped out, and whose box's centre lies inside the CropBox. */
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
  | { readonly kind: 'extra'; readonly found: string; readonly glyphs: readonly number[] };

/** A fold used on the page's text, with the glyphs it was used for. */
export interface FoldApplied {
  readonly fold: TextFold | 'caller';
  readonly from: string;
  readonly to: string;
  readonly glyphs: readonly number[];
}

export interface TextMatch {
  /**
   * `match` when every compared glyph is a real, painting glyph of its font whose text, after the folds listed, equals the intended text in the chosen order.
   * `mismatch` when a glyph is missing or unmapped or the texts differ.
   */
  readonly status: 'match' | 'mismatch' | 'unverified';
  readonly intended: string;
  /** The page's compared text, folds applied, for display; U+FFFD stands for a glyph without text. */
  readonly found: string;
  readonly differences: readonly TextDifference[];
  readonly folds: readonly FoldApplied[];
  /** The keys of the fonts of the compared glyphs, in the order of first use. */
  readonly fonts: readonly string[];
  /** The compared glyphs in the order compared. */
  readonly glyphs: readonly number[];
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
  readonly failure: { readonly kind: 'missing-glyph' } | { readonly kind: 'unmapped'; readonly reason: GlyphTextReason } | undefined;
}

const centre = (glyph: PageGlyph): readonly [number, number] => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = glyph.quad;
  return [(x0 + x1 + x2 + x3) / 4, (y0 + y1 + y2 + y3) / 4];
};

/**
 * The default selection: glyphs that paint (or are empty Type 3 glyphs, which matchText reports as missing), not covered, not clipped out, and whose box's centre lies inside the CropBox.
 * ISO 32000-1:2008, 14.11.2.1: "The crop box defines the region to which the contents of the page shall be clipped (cropped) when displayed or printed".
 */
const defaultSelection =
  ({ cropBox }: PageText) =>
  (glyph: PageGlyph): boolean => {
    if (!(glyph.visible || glyph.invisibleBecause === 'empty-glyph') || glyph.covered || glyph.clip === 'outside') return false;
    if (cropBox === undefined) return true;
    const [x, y] = centre(glyph);
    const [left, bottom, right, top] = cropBox;
    return x >= left && x <= right && y >= bottom && y <= top;
  };

const onlyWhiteSpace = (text: string): boolean => /^\p{White_Space}*$/u.test(text);

interface Settings {
  readonly whitespace: 'ignore' | 'exact';
  readonly folds: readonly TextFold[];
  readonly equivalents: ReadonlyMap<string, string>;
  readonly selectors: 'require-glyph-evidence' | 'ignore';
}

class FoundText {
  readonly clusters: FoundCluster[] = [];
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

  // The page's reading of one glyph's text: folds, then the caller's equivalents.
  private read(text: string, glyphs: readonly number[]): string {
    const folded = foldText(text, this.settings.folds);
    for (const use of folded.uses) this.recordFold(use.fold, use, glyphs);
    const equivalent = this.settings.equivalents.get(folded.text);
    if (equivalent === undefined) return folded.text;
    this.recordFold('caller', { from: folded.text, to: equivalent }, glyphs);
    return equivalent;
  }

  /** Adds a glyph: a failure when it is .notdef or an empty glyph that claims text, nothing when it is an empty glyph without text, else its clusters. */
  add(glyph: PageGlyph): void {
    const glyphs = [glyph.index];
    const { text } = glyph;
    if (glyph.notdef || (glyph.empty && text !== null && !onlyWhiteSpace(text))) {
      this.clusters.push({ text: text ?? REPLACEMENT, glyphs, failure: { kind: 'missing-glyph' } });
      return;
    }
    if (text === null) {
      if (!glyph.empty) this.clusters.push({ text: REPLACEMENT, glyphs, failure: { kind: 'unmapped', reason: glyph.reason ?? 'no-mapping' } });
      return;
    }
    const read = this.read(text, glyphs);
    for (const cluster of clusters(read, character => this.keep(character))) this.clusters.push({ text: cluster.text, glyphs, failure: undefined });
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
    if (step.kind === 'equal') flush();
    else if (step.kind === 'missing') {
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

const MISMATCHES = new Set<TextDifference['kind']>(['missing-glyph', 'unmapped', 'substituted', 'missing', 'extra']);

/**
 * Compares the text a page shows with the text it is meant to show, such as a customer's name on a proof, code point for code point after a small set of reported folds on the page's side; neither side is normalised.
 * `match` means every compared glyph is a real, painting glyph of its font, visible by the checks of `extractText`, and the glyphs' own text equals the intended text in the chosen order after the listed folds.
 * It does not prove that the shapes are right, that no fallback font was used (the result lists the fonts), or anything about sizes, positions, colours, or covering by anything other than opaque rectangles. A caller automating a check treats anything but `match` as a rejection.
 */
export const matchText = (page: PageText, intended: string, options: MatchTextOptions = {}): TextMatch => {
  const settings: Settings = {
    whitespace: options.whitespace ?? 'ignore',
    folds: options.folds ?? TEXT_FOLDS,
    equivalents: new Map(options.equivalents),
    selectors: options.variationSelectors ?? 'require-glyph-evidence',
  };
  const selected = orderGlyphs(page.glyphs.filter(options.select ?? defaultSelection(page)), options.order ?? 'content');
  const found = new FoundText(settings);
  for (const glyph of selected) found.add(glyph);
  const keep = (character: string): boolean =>
    !(settings.whitespace === 'ignore' && WHITE_SPACE.test(character)) && !(settings.selectors === 'ignore' && isSelector(character.codePointAt(0) ?? 0));
  const wanted = clusters(intended, keep);
  const steps = align(wanted.length, found.clusters.length, (a, b) => {
    const have = found.clusters[b];
    return have !== undefined && have.failure === undefined && have.text === wanted[a]?.text;
  });
  const differences = differencesOf(steps, wanted, found.clusters);
  const mismatch = differences.some(difference => MISMATCHES.has(difference.kind));
  return {
    status: mismatch ? 'mismatch' : 'match',
    intended,
    found: found.clusters.map(cluster => cluster.text).join(''),
    differences,
    folds: found.foldsApplied(),
    fonts: [...new Set(selected.map(glyph => glyph.font))],
    glyphs: selected.map(glyph => glyph.index),
  };
};

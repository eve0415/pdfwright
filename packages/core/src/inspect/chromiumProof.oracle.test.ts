import type { FontEntry } from './fonts/listFonts.ts';
import type { PageText } from './text/extractText.ts';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

import { runTool } from '../../../../scripts/readerOracle.ts';
import { loadDocument } from '../document/loadDocument.ts';

import { listFonts } from './fonts/listFonts.ts';
import { extractText } from './text/extractText.ts';
import { matchText } from './text/matchText.ts';

// Playwright's Chromium prints fixed HTML with page.pdf, the way proofs of personalised print products are made, and the tests inspect the PDFs it writes.
// IPAGothic has TrueType outlines and Noto Sans CJK JP has CFF outlines, the two font technologies Chromium prints differently.

const NAME = '山田 太郎';

// Kana, a middle dot, half-width katakana, full-width and ASCII Latin, digits, punctuation with vertical forms, U+20BB7 outside the BMP, variant kanji, 葛 with the ideographic variation selector U+E0100, and Latin ligatures.
const MIXED = 'やまだ・タロウ ｶﾀｶﾅ ＡＢＣ abc 123 ー〜…、。「」（）！？ 𠮷野 髙橋 﨑 葛\u{E0100}城 fi ffl';

// U+30000 is the first ideograph of CJK Unified Ideographs Extension G (Unicode 13.0), which neither face draws, nor any other font the devcontainer installs, so Chromium shows the face's .notdef glyph.
const UNDRAWN = '山田 \u{30000}郎';

const FACES = { ipaGothic: 'IPAGothic', noto: 'Noto Sans CJK JP' } as const;
type Face = keyof typeof FACES;

const TEXTS = { name: NAME, mixed: MIXED, undrawn: UNDRAWN } as const;
type Text = keyof typeof TEXTS;

type Proof = `${Face}-${Text}`;

const PROOFS = (['ipaGothic', 'noto'] as const).flatMap(face =>
  (['name', 'mixed', 'undrawn'] as const).map(text => ({ proof: `${face}-${text}` as const, face, text })),
);

// The text is set in one vertical-rl block on a 60 by 90 mm page.
const html = (family: string, text: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>@page { size: 60mm 90mm; margin: 5mm; } body { margin: 0; font-family: '${family}'; font-size: 14pt; } div { writing-mode: vertical-rl; height: 75mm; }</style></head><body><div>${text}</div></body></html>`;

// Prints every proof in one browser, each in its own tab.
const printProofs = async (): Promise<ReadonlyMap<Proof, Uint8Array>> => {
  const browser = await chromium.launch();
  try {
    const printed = await Promise.all(
      PROOFS.map(async ({ proof, face, text }): Promise<[Proof, Uint8Array]> => {
        const tab = await browser.newPage();
        await tab.setContent(html(FACES[face], TEXTS[text]), { waitUntil: 'load' });
        await tab.evaluate('document.fonts.ready');
        return [proof, new Uint8Array(await tab.pdf({ preferCSSPageSize: true, printBackground: true }))];
      }),
    );
    return new Map(printed);
  } finally {
    await browser.close();
  }
};

// The proofs are printed once, by the first test that needs one.
let printing: Promise<ReadonlyMap<Proof, Uint8Array>> | null = null;

const proofBytes = async (proof: Proof): Promise<Uint8Array> => {
  printing ??= printProofs();
  const printed = await printing;
  const bytes = printed.get(proof);
  if (bytes === undefined) throw new Error(`${proof} was not printed`);
  return bytes;
};

const proofText = async (proof: Proof): Promise<PageText> => extractText(loadDocument(await proofBytes(proof)), 0);

const proofFonts = async (proof: Proof): Promise<readonly FontEntry[]> => listFonts(loadDocument(await proofBytes(proof))).fonts;

const ascii = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

// The fields of a font entry the proof rule turns on, with names as text.
const fontSummary = (font: FontEntry) => ({
  subtype: font.subtype,
  name: ascii(font.name),
  descendant: font.descendant?.subtype,
  embedding: font.embedding,
  subset: font.subset,
  encoding: font.encoding.kind === 'cmap' ? { cmap: ascii(font.encoding.name), writingMode: font.encoding.writingMode } : font.encoding.kind,
  toUnicode: font.toUnicode,
  type3: font.type3?.glyphs,
  shownOn: font.shownOn,
  problems: font.problems,
});

const IPA_GOTHIC = {
  subtype: 'Type0',
  name: 'AAAAAA+IPAGothic',
  descendant: 'CIDFontType2',
  embedding: { state: 'embedded', file: 'FontFile2', matchesFontType: true },
  subset: { state: 'subset', tag: 'AAAAAA' },
  encoding: { cmap: 'Identity-H', writingMode: 0 },
  toUnicode: 'present',
  type3: undefined,
  shownOn: [0],
  problems: [],
} as const;

const notoType3 = (tag: string) =>
  ({
    subtype: 'Type3',
    name: `${tag}+NotoSansCJKjp-Regular`,
    descendant: undefined,
    embedding: { state: 'not-applicable' },
    subset: { state: 'not-applicable', tag },
    encoding: 'differences',
    toUnicode: 'present',
    type3: 'vector',
    shownOn: [0],
    problems: [],
  }) as const;

interface Char {
  readonly x: number;
  readonly y: number;
  readonly c: string;
}

const attribute = (element: string, name: string): string => new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(element)?.[1] ?? '';

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

// Character references and the predefined entities MuPDF writes in the c attribute.
const unescapeXml = (text: string): string =>
  text.replaceAll(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, reference: string) => {
    if (reference.startsWith('#x') || reference.startsWith('#X')) return String.fromCodePoint(Number.parseInt(reference.slice(2), 16));
    if (reference.startsWith('#')) return String.fromCodePoint(Number(reference.slice(1)));
    return ENTITIES.get(reference) ?? '';
  });

// mutool draw -F stext: one char element per character, with the glyph origin as x and y from the page's top-left corner; chars MuPDF adds between words carry flag 4 and are skipped.
const mupdfChars = (xml: string): Char[] =>
  [...xml.matchAll(/<char [^>]*\/>/gu)]
    .map(([element]) => element)
    .filter(element => Math.floor(Number(attribute(element, 'flags')) / 4) % 2 === 0)
    .map(element => ({ x: Number(attribute(element, 'x')), y: Number(attribute(element, 'y')), c: unescapeXml(attribute(element, 'c')) }));

const ORIGIN_TOLERANCE = 0.01;

// Each glyph against the MuPDF chars it produced, in content order.
// MuPDF writes one char per code point of a glyph's text, or of the ActualText span the glyph opens, the first at the glyph's origin, and nothing for a span's later glyphs; so the records are joined by glyph rather than by index.
const mupdfDifferences = (page: PageText, chars: readonly Char[]): string[] => {
  // MuPDF measures y down from the top of the MediaBox.
  const top = page.mediaBox?.[3] ?? 0;
  const opened = new Set<number>();
  const joined = page.glyphs.map(glyph => {
    const span = glyph.actualText === undefined ? undefined : page.actualText[glyph.actualText];
    if (glyph.actualText !== undefined) {
      if (opened.has(glyph.actualText)) return { glyph, count: 0, text: '' };
      opened.add(glyph.actualText);
    }
    const text = span === undefined ? (glyph.text ?? '') : span.text;
    return { glyph, count: Math.max(1, text.match(/./gsu)?.length ?? 0), text };
  });
  const expected = joined.reduce((sum, { count }) => sum + count, 0);
  if (expected !== chars.length) {
    return [`${String(expected)} chars expected from ${String(page.glyphs.length)} glyphs against ${String(chars.length)} MuPDF chars`];
  }
  let next = 0;
  return joined.flatMap(({ glyph, count, text }) => {
    const own = chars.slice(next, next + count);
    next += count;
    const [first] = own;
    if (first === undefined) return [];
    const [x, y] = [glyph.origin[0], top - glyph.origin[1]];
    const found = own.map(char => char.c).join('');
    return [
      Math.abs(x - first.x) <= ORIGIN_TOLERANCE && Math.abs(y - first.y) <= ORIGIN_TOLERANCE
        ? ''
        : `origin (${String(x)}, ${String(y)}) against (${String(first.x)}, ${String(first.y)})`,
      text === found ? '' : `text ${text} against ${found}`,
    ]
      .filter(problem => problem !== '')
      .map(problem => `glyph ${String(glyph.index)}: ${problem}`);
  });
};

const mupdfReading = async (proof: Proof): Promise<{ readonly code: number; readonly chars: Char[] }> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-proof-'));
  try {
    const file = path.join(directory, `${proof}.pdf`);
    await writeFile(file, await proofBytes(proof));
    const { code, output } = await runTool('mutool', ['draw', '-F', 'stext', '-o', '-', file]);
    return { code, chars: mupdfChars(output) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('print proofs from Chromium', { timeout: 120_000 }, () => {
  it('embeds IPAGothic, a TrueType-outline face, as a CIDFontType2 subset with Identity-H and ToUnicode', async () => {
    const fonts = await proofFonts('ipaGothic-name');
    expect(fonts.map(font => fontSummary(font))).toMatchObject([IPA_GOTHIC]);
  });

  it.each(['name', 'mixed'] as const)('prints the %s in Noto Sans CJK JP, a CFF-outline face, as Type 3 fonts of vector glyphs', async text => {
    const fonts = await proofFonts(`noto-${text}`);
    expect(fonts.length).toBeGreaterThan(1);
    expect(fonts.map(font => fontSummary(font))).toMatchObject(fonts.map(() => notoType3('AAAAAA')));
  });

  // Chromium sets a character the face lacks in another installed font that has it, and Noto Sans CJK JP draws U+20BB7, which IPAGothic does not.
  it('draws 𠮷, which IPAGothic lacks, in Noto Sans CJK JP as a second font, of Type 3', async () => {
    const fonts = await proofFonts('ipaGothic-mixed');
    expect(fonts.map(font => fontSummary(font))).toMatchObject([IPA_GOTHIC, notoType3('BAAAAA')]);
    const { glyphs } = await proofText('ipaGothic-mixed');
    expect(glyphs.filter(glyph => glyph.font === fonts[1]?.key).map(glyph => glyph.text)).toStrictEqual(['𠮷']);
  });

  // Chromium sets vertical-rl text one glyph after another down the column with the Identity-H CMap, whose name ending in H specifies horizontal writing (ISO 32000-1:2008, 9.7.5.2), so no glyph is in writing mode 1.
  it.each(PROOFS)('shows every glyph of $proof in horizontal writing mode', async ({ proof }) => {
    const { glyphs } = await proofText(proof);
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs.filter(glyph => glyph.writingMode !== 0)).toStrictEqual([]);
  });

  it.each(['content', 'columns-rtl'] as const)(
    'matches the name in IPAGothic, read in %s order, with every glyph checked against the embedded cmap',
    async order => {
      const page = await proofText('ipaGothic-name');
      expect(matchText(page, NAME, { order })).toMatchObject({ status: 'match', evidence: 'glyph-checked', differences: [], folds: [] });
    },
  );

  // Noto's ToUnicode maps the glyphs of 山 and 田 to the Kangxi radicals U+2F2D and U+2F65, and a Type 3 font has no program to check a glyph against.
  it.each(['content', 'columns-rtl'] as const)(
    'matches the name in Noto Sans CJK JP, read in %s order, by glyph text after folding two radicals',
    async order => {
      const page = await proofText('noto-name');
      expect(matchText(page, NAME, { order })).toMatchObject({
        status: 'match',
        evidence: 'glyph-text-only',
        differences: [],
        folds: [
          { fold: 'radicals', from: '\u{2F2D}', to: '山', glyphs: [0] },
          { fold: 'radicals', from: '\u{2F65}', to: '田', glyphs: [1] },
        ],
      });
    },
  );

  it('matches the mixed line in Noto Sans CJK JP after folding the middle dot, the vertical punctuation and the ligatures', async () => {
    const result = matchText(await proofText('noto-mixed'), MIXED);
    expect(result).toMatchObject({ status: 'match', evidence: 'glyph-text-only', differences: [] });
    expect(result.folds.map(({ fold, from, to }) => [fold, from, to])).toStrictEqual([
      ['shared-glyphs', '\u{2027}', '・'],
      ['vertical-forms', '\u{FE11}', '、'],
      ['vertical-forms', '\u{FE12}', '。'],
      ['vertical-forms', '\u{FE41}', '「'],
      ['vertical-forms', '\u{FE42}', '」'],
      ['vertical-forms', '\u{FE35}', '（'],
      ['vertical-forms', '\u{FE36}', '）'],
      ['ligatures', '\u{FB01}', 'fi'],
      ['ligatures', '\u{FB04}', 'ffl'],
    ]);
  });

  // IPAGothic has no glyph for the variation sequence, so its glyph's ToUnicode text is the plain 葛 and only an ActualText span carries U+E0100.
  // The Type 3 glyph of 𠮷 from the fallback font makes the evidence text-only.
  it('leaves the mixed line in IPAGothic unverified, since only ActualText carries the variation selector of 葛', async () => {
    const result = matchText(await proofText('ipaGothic-mixed'), MIXED);
    expect(result).toMatchObject({
      status: 'unverified',
      evidence: 'glyph-text-only',
      folds: [],
      differences: [{ kind: 'variant-unverified', intended: '葛\u{E0100}' }],
    });
  });

  // IPAGothic shows CID 0 of its CIDFontType2 subset; Noto shows the g0 glyph of a Type 3 font, which paints the .notdef box.
  it.each([
    ['ipaGothic', 'Type0', 0],
    ['noto', 'Type3', undefined],
  ] as const)('reports the .notdef glyph %s shows for a character no installed font draws as a missing glyph', async (face, subtype, cid) => {
    const proof: Proof = `${face}-undrawn`;
    const page = await proofText(proof);
    expect(matchText(page, UNDRAWN)).toMatchObject({ status: 'mismatch', differences: [{ kind: 'missing-glyph', glyphs: [3], intendedIndex: 3 }] });
    const entries = await proofFonts(proof);
    const fonts = new Map(entries.map(font => [font.key, font.subtype]));
    const notdef = page.glyphs.filter(glyph => glyph.notdef).map(glyph => [glyph.index, glyph.text, glyph.reason, glyph.cid, fonts.get(glyph.font)]);
    expect(notdef).toStrictEqual([[3, null, 'notdef', cid, subtype]]);
  });

  it.each(PROOFS.filter(({ text }) => text !== 'undrawn'))('places each glyph of $proof at MuPDF’s origin, with the text MuPDF reads', async ({ proof }) => {
    const { code, chars } = await mupdfReading(proof);
    expect(code).toBe(0);
    expect(mupdfDifferences(await proofText(proof), chars)).toStrictEqual([]);
  });
});

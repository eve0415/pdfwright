import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { SyntheticVariations } from '../../testing/syntheticTrueType.ts';
import type { PageText } from './extractText.ts';
import type { MatchTextOptions, TextMatch } from './matchText.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { extractText } from './extractText.ts';
import { matchText } from './matchText.ts';

const hex = (bytes: readonly number[]): string => bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');

// UTF-16BE, as ToUnicode destinations are written.
const utf16 = (text: string): string => {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const units = codePoint < 0x10000 ? [codePoint] : [0xd800 + Math.floor((codePoint - 0x10000) / 0x400), 0xdc00 + ((codePoint - 0x10000) % 0x400)];
    for (const unit of units) bytes.push(Math.floor(unit / 256), unit % 256);
  }
  return hex(bytes);
};

const code = (value: number): string => hex([Math.floor(value / 256), value % 256]);

/**
 * An Identity-H font, T, whose ToUnicode maps code n + 1 to texts[n] (nothing for null), every glyph 1000 thousandths wide with descent −120 and ascent 880.
 * Code 0 selects CID 0, the .notdef glyph.
 */
const cidFont = (texts: readonly (string | null)[], program?: Uint8Array): readonly TestObject[] => {
  const entries = texts.flatMap((text, index) => (text === null ? [] : [`<${code(index + 1)}> <${utf16(text)}>`]));
  return [
    { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[106 0 R]/ToUnicode 107 0 R>>' },
    {
      number: 106,
      body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000/FontDescriptor 111 0 R>>',
    },
    {
      number: 107,
      body: streamBody(
        '',
        `begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${String(entries.length)} beginbfchar ${entries.join(' ')} endbfchar endcmap`,
      ),
    },
    {
      number: 111,
      body: `<</Type/FontDescriptor/FontName/Test/Flags 4/FontBBox[0 -120 1000 880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80${program === undefined ? '' : '/FontFile2 112 0 R'}>>`,
    },
    ...(program === undefined ? [] : [{ number: 112, body: streamBody('', latin1Text(program)) }]),
  ];
};

interface Proof {
  /** The text each code stands for: code n + 1 maps to texts[n]. */
  readonly texts: readonly (string | null)[];
  /** A TrueType program embedded as the font's FontFile2, whose glyph n the code n selects. */
  readonly program?: Uint8Array;
  /** The content, where `show(codes)` writes a Tj of the codes. */
  readonly content: string;
  readonly resources?: string;
  readonly objects?: readonly TestObject[];
  readonly entries?: string;
}

const show = (...codes: readonly number[]): string => `<${codes.map(value => code(value)).join('')}> Tj`;

/** Shows codes 1…n of the font in one line at 10 points from (100, 700). */
const line = (count: number): string => `BT /T 10 Tf 100 700 Td ${show(...Array.from({ length: count }, (_, index) => index + 1))} ET`;

const page = ({ texts, program, content, resources = '', objects = [], entries = '' }: Proof): PageText => {
  const bytes = textPdfBytes({
    pages: [{ content, resources: `/Font<</T 105 0 R>>${resources}`, entries }],
    objects: [...cidFont(texts, program), ...objects],
  });
  return extractText(loadDocument(bytes), 0);
};

const match = (proof: Proof, intended: string, options: MatchTextOptions = {}): TextMatch => matchText(page(proof), intended, options);

/** Wraps content in a Span marked-content sequence whose ActualText is the text, as UTF-16BE. */
const span = (text: string, content: string): string => `/Span <</ActualText <FEFF${utf16(text)}>>> BDC ${content} EMC`;

const spanOf = ([text, ...codes]: readonly [string, ...number[]]): string => span(text, show(...codes));

/** Shows each code in its own Tj at 10 points from (100, 700), the codes of `spans` inside ActualText spans. */
const spanned = (...parts: readonly (number | readonly [string, ...number[]])[]): string =>
  `BT /T 10 Tf 100 700 Td ${parts.map(part => (typeof part === 'number' ? show(part) : spanOf(part))).join(' ')} ET`;

/** The program with its cmap table renamed in the table directory, so that it has none. */
const withoutCmap = (program: Uint8Array): Uint8Array => {
  const copy = Uint8Array.from(program);
  const tables = (copy[4] ?? 0) * 256 + (copy[5] ?? 0);
  for (let record = 12; record < 12 + 16 * tables; record += 16) {
    if (String.fromCodePoint(...copy.subarray(record, record + 4)) === 'cmap') copy[record + 3] = 0x71;
  }
  return copy;
};

/** Shows the codes at 10 points from (x, y). */
const drawnAt = (x: number, y: number, codes: string): string => `BT /T 10 Tf ${String(x)} ${String(y)} Td ${codes} ET`;

const summary = (result: TextMatch): unknown[] => [result.status, result.found, result.differences];

const summaryOf = (proof: Proof, intended: string, options: MatchTextOptions = {}): unknown[] => summary(match(proof, intended, options));

const statusOf = (proof: Proof, intended: string, options: MatchTextOptions = {}): TextMatch['status'] => match(proof, intended, options).status;

describe('text matching', () => {
  it('matches the intended text glyph for glyph, ignoring white space', () => {
    const result = match({ texts: ['山', '田', ' ', '太', '郎'], content: line(5) }, '山田 太郎');
    expect([...summary(result), result.fonts, result.glyphs, result.folds]).toStrictEqual(['match', '山田太郎', [], ['105.0'], [0, 1, 2, 3, 4], []]);
  });

  it('compares white space when asked, which a page without space glyphs lacks', () => {
    expect(summaryOf({ texts: ['山', '田', '太', '郎'], content: line(4) }, '山田 太郎', { whitespace: 'exact' })).toStrictEqual([
      'mismatch',
      '山田太郎',
      [{ kind: 'missing', intended: ' ', intendedIndex: 2 }],
    ]);
  });

  it('reads a Kangxi radical as its unified ideograph and lists the fold', () => {
    // Chromium's ToUnicode for 山 set in Noto Sans JP is U+2F2D KANGXI RADICAL MOUNTAIN, as Noto draws both with one glyph.
    const result = match({ texts: ['⼭', '田'], content: line(2) }, '山田');
    expect([...summary(result), result.folds]).toStrictEqual(['match', '山田', [], [{ fold: 'radicals', from: '⼭', to: '山', glyphs: [0] }]]);
    expect(summaryOf({ texts: ['⼭', '田'], content: line(2) }, '山田', { folds: [] })).toStrictEqual([
      'mismatch',
      '⼭田',
      [{ kind: 'substituted', intended: '山', found: '⼭', intendedIndex: 0, glyphs: [0] }],
    ]);
  });

  it('does not fold the three radicals Noto draws with a different ideograph, unless the caller vouches for the pair', () => {
    expect(statusOf({ texts: ['⼾'], content: line(1) }, '戸')).toBe('mismatch');
    const result = match({ texts: ['⼾'], content: line(1) }, '戸', { equivalents: [['⼾', '戸']] });
    expect([result.status, result.folds]).toStrictEqual(['match', [{ fold: 'caller', from: '⼾', to: '戸', glyphs: [0] }]]);
  });

  it('folds vertical presentation forms, ligatures and the shared hyphenation point', () => {
    expect(summaryOf({ texts: ['「', '︑', 'ﬁ', '‧'], content: line(4) }, '「、fi・')).toStrictEqual(['match', '「、fi・', []]);
  });

  it('keeps full-width and half-width forms and compatibility ideographs apart', () => {
    // NFC would rewrite U+FA19, a registered compatibility ideograph, as U+795E; matchText normalises neither side.
    const compatibility = String.fromCodePoint(0xfa19);
    const unified = String.fromCodePoint(0x795e);
    expect(summaryOf({ texts: ['Ａ', 'ｶ', compatibility], content: line(3) }, `Aカ${unified}`)).toStrictEqual([
      'mismatch',
      `Ａｶ${compatibility}`,
      [
        { kind: 'substituted', intended: 'A', found: 'Ａ', intendedIndex: 0, glyphs: [0] },
        { kind: 'substituted', intended: 'カ', found: 'ｶ', intendedIndex: 1, glyphs: [1] },
        { kind: 'substituted', intended: unified, found: compatibility, intendedIndex: 2, glyphs: [2] },
      ],
    ]);
  });

  it('requires a variation selector to be in the glyph text, unless selectors are ignored', () => {
    // IPAGothic paints the plain 葛 glyph for 葛󠄀 with ToUnicode U+845B; Noto's variant glyph maps to U+845B U+E0100.
    expect(summaryOf({ texts: ['葛', '城'], content: line(2) }, '葛󠄀城')).toStrictEqual([
      'mismatch',
      '葛城',
      [{ kind: 'substituted', intended: '葛󠄀', found: '葛', intendedIndex: 0, glyphs: [0] }],
    ]);
    expect(statusOf({ texts: ['葛󠄀', '城'], content: line(2) }, '葛󠄀城')).toBe('match');
    expect(statusOf({ texts: ['葛', '城'], content: line(2) }, '葛󠄀城', { variationSelectors: 'ignore' })).toBe('match');
  });

  it('reports a .notdef glyph as a missing glyph against the character it stands for', () => {
    // Chromium paints 𠮷 as CID 0 in a font that lacks it, with no ToUnicode entry.
    expect(summaryOf({ texts: ['野'], content: `BT /T 10 Tf 100 700 Td ${show(0, 1)} ET` }, '𠮷野')).toStrictEqual([
      'mismatch',
      '�野',
      [{ kind: 'missing-glyph', glyphs: [0], intendedIndex: 0 }],
    ]);
  });

  it('reports glyphs without text, extra glyphs and missing characters', () => {
    expect(summaryOf({ texts: ['山', null, '田', '村'], content: line(4) }, '山田中')).toStrictEqual([
      'mismatch',
      '山�田村',
      [
        { kind: 'unmapped', glyphs: [1], reason: 'no-mapping' },
        { kind: 'substituted', intended: '中', found: '村', intendedIndex: 2, glyphs: [3] },
      ],
    ]);
    expect(summaryOf({ texts: ['山', '田'], content: line(2) }, '山')).toStrictEqual(['mismatch', '山田', [{ kind: 'extra', found: '田', glyphs: [1] }]]);
    expect(summaryOf({ texts: ['山'], content: line(1) }, '山田')).toStrictEqual(['mismatch', '山', [{ kind: 'missing', intended: '田', intendedIndex: 1 }]]);
  });

  it('reports a glyph whose ToUnicode maps it to no text as unmapped, alone or in a span', () => {
    const unmapped = { kind: 'unmapped', glyphs: [1], reason: 'no-mapping' };
    expect(summaryOf({ texts: ['山', '', '田'], content: line(3) }, '山田')).toStrictEqual(['mismatch', '山�田', [unmapped]]);
    expect(summaryOf({ texts: ['山', '', '田'], content: spanned(1, ['田', 2, 3]) }, '山田')).toStrictEqual([
      'mismatch',
      '山�',
      [{ ...unmapped, glyphs: [1, 2] }],
    ]);
    expect(statusOf({ texts: [''], content: line(1) }, '')).toBe('mismatch');
  });

  it('reads ruby after its base text in content order, which a caller selects away by size', () => {
    // Chromium draws ruby after all base text of the line.
    const proof = { texts: ['山', '田', 'や', 'ま', 'だ'], content: `${line(2)} BT /T 5 Tf 100 712 Td ${show(3, 4, 5)} ET` };
    expect(statusOf(proof, '山田')).toBe('mismatch');
    expect(statusOf(proof, '山田', { select: glyph => glyph.fontSize > 6 })).toBe('match');
  });

  it('reads glyphs in the order the caller declares', () => {
    // Two columns drawn left column first: read right to left, 太郎 then 山田.
    const content = `BT /T 10 Tf 100 700 Td ${show(1)} 0 -10 Td ${show(2)} ET BT /T 10 Tf 120 700 Td ${show(3)} 0 -10 Td ${show(4)} ET`;
    const proof = { texts: ['山', '田', '太', '郎'], content };
    expect([statusOf(proof, '太郎山田'), statusOf(proof, '太郎山田', { order: 'columns-rtl' })]).toStrictEqual(['mismatch', 'match']);
  });

  it('refuses option values it does not know', () => {
    const proof = page({ texts: ['山'], content: line(1) });
    for (const [key, value] of [
      ['order', 'nope'],
      ['whitespace', 'nope'],
      ['folds', ['nope']],
      ['actualText', 'nope'],
      ['variationSelectors', 'nope'],
      ['duplicates', 'nope'],
    ] as const) {
      const options: MatchTextOptions = {};
      Reflect.set(options, key, value);
      expect(() => matchText(proof, '山', options)).toThrow(InvalidArgumentError);
    }
  });

  it('leaves out glyphs outside the CropBox', () => {
    expect(statusOf({ texts: ['山', '田'], content: line(2), entries: '/CropBox[0 0 105 800]' }, '山')).toBe('match');
  });

  describe('never matches text that does not print', () => {
    const states = '/ExtGState<</Clear<</ca 0>>>>';

    it('rejects Tr 0 text under ca 0, as Chromium writes color: transparent', () => {
      expect(statusOf({ texts: ['山', '田'], content: `/Clear gs ${line(2)}`, resources: states }, '山田')).toBe('mismatch');
    });

    it('rejects text with 0 Tz and text scaled to a thousandth', () => {
      expect(statusOf({ texts: ['山', '田'], content: `BT /T 10 Tf 0 Tz 100 700 Td ${show(1, 2)} ET` }, '山田')).toBe('mismatch');
      expect(statusOf({ texts: ['山', '田'], content: `0.001 0 0 0.001 100 700 cm ${line(2)}` }, '山田')).toBe('mismatch');
    });

    it('rejects text under a later opaque white rectangle', () => {
      expect(statusOf({ texts: ['山', '田'], content: `${line(2)} 1 g 90 690 40 30 re f` }, '山田')).toBe('mismatch');
    });

    it('rejects text a Bézier or a polygon clip hides', () => {
      // A circle, as border-radius clips, and a triangle, as clip-path: polygon clips, both away from the text at (100, 700).
      const circle = '450 300 m 450 355.2 405.2 400 350 400 c 294.8 400 250 355.2 250 300 c 250 244.8 294.8 200 350 200 c 405.2 200 450 244.8 450 300 c h W n';
      const triangle = '600 800 m 600 0 l 0 0 l h W n';
      expect(statusOf({ texts: ['山', '田'], content: `${circle} ${line(2)}` }, '山田')).toBe('mismatch');
      expect(statusOf({ texts: ['山', '田'], content: `${triangle} ${line(2)}` }, '山田')).toBe('mismatch');
    });

    it('rejects text after text shown to clip, whose outlines are not read', () => {
      // 9.3.6: at the end of a text object in render mode 7 the glyph outlines become the clip; a dot far from the name hides it.
      expect(statusOf({ texts: ['山', '田', '・'], content: `BT /T 10 Tf 7 Tr 400 100 Td ${show(3)} ET 0 Tr ${line(2)}` }, '山田')).toBe('mismatch');
    });

    it('rejects a Type 3 glyph whose procedure paints nothing, but not an empty space glyph', () => {
      // Chromium's Type 3 space is the empty procedure 224 0 0 0 0 0 d1; an empty procedure for 山 prints nothing.
      const type3: readonly TestObject[] = [
        {
          number: 120,
          body: '<</Type/Font/Subtype/Type3/FontBBox[0 -120 1000 880]/FontMatrix[.001 0 0 .001 0 0]/CharProcs<</g1 121 0 R/g2 122 0 R/g3 121 0 R>>/Encoding<</Differences[1/g1/g2/g3]>>/FirstChar 1/LastChar 3/Widths[1000 224 1000]/ToUnicode 123 0 R>>',
        },
        { number: 121, body: streamBody('', '1000 0 0 -120 1000 880 d1 0 0 1000 800 re f') },
        { number: 122, body: streamBody('', '224 0 0 0 0 0 d1') },
        {
          number: 123,
          body: streamBody(
            '',
            'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 3 beginbfchar <01> <5C71> <02> <0020> <03> <7530> endbfchar endcmap',
          ),
        },
      ];
      const shown = (codes: string): TextMatch =>
        match({ texts: [], content: `BT /E 10 Tf 100 700 Td <${codes}> Tj ET`, resources: '/Font<</E 120 0 R>>', objects: type3 }, '山 田');
      expect(shown('010203').status).toBe('match');
      const empty: readonly TestObject[] = [
        ...type3.filter(object => object.number !== 121),
        { number: 121, body: streamBody('', '1000 0 0 -120 1000 880 d1') },
      ];
      const result = match({ texts: [], content: 'BT /E 10 Tf 100 700 Td <010203> Tj ET', resources: '/Font<</E 120 0 R>>', objects: empty }, '山 田');
      expect(summary(result)).toStrictEqual([
        'mismatch',
        '山田',
        [
          { kind: 'missing-glyph', glyphs: [0], intendedIndex: 0 },
          { kind: 'missing-glyph', glyphs: [2], intendedIndex: 2 },
        ],
      ]);
    });

    it('rejects a Chromium g0 glyph whatever text it claims', () => {
      const chromium: readonly TestObject[] = [
        {
          number: 120,
          body: '<</Type/Font/Subtype/Type3/FontBBox[100 120 900 -880]/FontMatrix[.001 0 0 -.001 0 0]/CharProcs<</g0 121 0 R/g1A 121 0 R>>/Encoding<</Differences[0/g0/g1A]>>/FirstChar 0/LastChar 1/Widths[1000 1000]/FontDescriptor 111 0 R/ToUnicode 123 0 R>>',
        },
        { number: 121, body: streamBody('', '1000 0 100 -880 900 120 d1 100 -880 800 1000 re f') },
        {
          number: 123,
          body: streamBody('', 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <00> <D842DFB7> <01> <91CE> endbfchar endcmap'),
        },
      ];
      const result = match(
        { texts: [], content: '1 0 0 -1 0 800 cm BT /E 10 Tf 1 0 0 -1 100 100 Tm <0001> Tj ET', resources: '/Font<</E 120 0 R>>', objects: chromium },
        '𠮷野',
      );
      expect(summary(result)).toStrictEqual(['mismatch', '𠮷野', [{ kind: 'missing-glyph', glyphs: [0], intendedIndex: 0 }]]);
      // Chromium also wraps the tofu g0 in a span claiming a character, here U+F0001.
      const content = `1 0 0 -1 0 800 cm BT /E 10 Tf 1 0 0 -1 100 100 Tm ${span('\u{F0001}', '<00> Tj')} <01> Tj ET`;
      const wrapped = match({ texts: [], content, resources: '/Font<</E 120 0 R>>', objects: chromium }, '\u{F0001}野');
      expect(summary(wrapped)).toStrictEqual(['mismatch', '\u{F0001}野', [{ kind: 'missing-glyph', glyphs: [0], intendedIndex: 0 }]]);
    });
  });

  describe('actual text', () => {
    it('uses a span whose text agrees with its glyphs after folds', () => {
      // Chromium wraps Noto's radical, vertical and ligature glyphs in spans giving the source characters.
      const texts = ['⼭', '田', '︑', 'ﬁ', '‧'];
      expect(summaryOf({ texts, content: spanned(['山', 1], 2, ['、', 3], ['fi', 4], ['・', 5]) }, '山田、fi・')).toStrictEqual(['match', '山田、fi・', []]);
    });

    it('never matches a substituted glyph under a span claiming the source character', () => {
      // font-feature-settings "jis78" prints 侭 (ToUnicode U+4FAD) under ActualText 儘 (U+5118); "nlck" prints 曾 under ActualText 曽.
      const result = match({ texts: ['侭', '曾'], content: spanned(['儘', 1], ['曽', 2]) }, '儘曽');
      expect(summary(result)).toStrictEqual([
        'mismatch',
        '侭曾',
        [
          { kind: 'substituted', intended: '儘', found: '侭', intendedIndex: 0, glyphs: [0] },
          { kind: 'substituted', intended: '曽', found: '曾', intendedIndex: 1, glyphs: [1] },
          { kind: 'actual-text-disagrees', actualText: '儘', glyphText: '侭', span: 0, glyphs: [0] },
          { kind: 'actual-text-disagrees', actualText: '曽', glyphText: '曾', span: 1, glyphs: [1] },
        ],
      ]);
      expect(statusOf({ texts: ['侭'], content: spanned(['儘', 1]) }, '儘', { actualText: 'ignore' })).toBe('mismatch');
    });

    it('leaves a variation selector only the span carries unverified', () => {
      // IPAGothic paints plain 葛 under ActualText U+845B U+E0100; Noto's glyph text carries the selector itself.
      expect(summaryOf({ texts: ['葛', '城'], content: spanned(['葛󠄀', 1], 2) }, '葛󠄀城')).toStrictEqual([
        'unverified',
        '葛󠄀城',
        [{ kind: 'variant-unverified', intended: '葛󠄀', intendedIndex: 0, glyphs: [0] }],
      ]);
      expect(statusOf({ texts: ['葛󠄀', '城'], content: spanned(['葛󠄀', 1], 2) }, '葛󠄀城')).toBe('match');
      expect(statusOf({ texts: ['葛', '城'], content: spanned(['葛󠄀', 1], 2) }, '葛城')).toBe('mismatch');
    });

    it('does not set aside a variation selector the glyphs have and the span lacks, or one on another glyph', () => {
      // A glyph whose own text is 葛󠄀 under a span claiming plain 葛 shows the variant, not the intended character.
      expect(statusOf({ texts: ['葛󠄀', '城'], content: spanned(['葛', 1], 2) }, '葛城')).toBe('mismatch');
      // The span's selector belongs to 葛, but the glyphs carry it on 辻.
      expect(statusOf({ texts: ['葛', '辻󠄀'], content: spanned(['葛󠄀辻', 1, 2]) }, '葛󠄀辻')).not.toBe('match');
    });

    it('reports a missing glyph under a span whatever the span claims', () => {
      // Chromium wraps 𠮷 painted as CID 0 in a span like any other character.
      expect(summaryOf({ texts: ['野'], content: spanned(['𠮷', 0], 1) }, '𠮷野')).toStrictEqual([
        'mismatch',
        '𠮷野',
        [{ kind: 'missing-glyph', glyphs: [0], intendedIndex: 0 }],
      ]);
    });

    it('does not take a span as the text of a glyph without text', () => {
      expect(summaryOf({ texts: [null, '田'], content: spanned(['山', 1], 2) }, '山田')).toStrictEqual([
        'mismatch',
        '�田',
        [{ kind: 'unmapped', glyphs: [0], reason: 'no-mapping' }],
      ]);
    });

    it('reports a span whose glyphs are not selected between selected glyphs as having no glyph evidence', () => {
      const content = `BT /T 10 Tf 100 700 Td ${show(1)} 3 Tr ${span('中', show(2))} 0 Tr ${show(3)} ET`;
      expect(summaryOf({ texts: ['山', '中', '田'], content }, '山田')).toStrictEqual([
        'unverified',
        '山田',
        [{ kind: 'no-glyph-evidence', text: '中', span: 0 }],
      ]);
    });

    it('does not take a span whole when the chosen order puts other glyphs between its glyphs', () => {
      // Content order draws B and A inside one span, then X between them on the line; read in rows the page shows B X A.
      const content = `BT /T 10 Tf 1 0 0 1 100 700 Tm ${span('BA', `${show(1)} 1 0 0 1 120 700 Tm ${show(2)}`)} 1 0 0 1 110 700 Tm ${show(3)} ET`;
      const proof = { texts: ['B', 'A', 'X'], content };
      expect([statusOf(proof, 'BAX', { order: 'rows' }), statusOf(proof, 'BXA', { order: 'rows' })]).toStrictEqual(['mismatch', 'match']);
    });

    it('reads the shared hyphenation point without spans when they are ignored', () => {
      expect(statusOf({ texts: ['‧'], content: spanned(['・', 1]) }, '・', { actualText: 'ignore' })).toBe('match');
    });
  });

  describe('embedded cmaps', () => {
    // Glyph 1 is Ａ as the cmap maps U+FF21, glyph 2 a half-width alternate the cmap does not list, glyph 3 侭, glyph 4 葛, glyph 5 its variant for U+E0100, glyph 6 a vertical comma.
    const box = { advance: 1000, box: [100, 0, 900, 700] } as const;
    const program = (variations: readonly SyntheticVariations[] = []): Uint8Array =>
      syntheticTrueType({
        name: 'Test',
        glyphs: [{ advance: 1000 }, box, box, box, box, box, box],
        characters: [
          [0xff21, 1],
          [0x4fad, 3],
          [0x845b, 4],
        ],
        variations,
      });
    const plain = program();

    it('confirms glyphs the embedded cmap maps their text to', () => {
      const result = match({ texts: ['Ａ', null, '侭'], program: plain, content: `BT /T 10 Tf 100 700 Td ${show(1, 3)} ET` }, 'Ａ侭');
      expect([result.status, result.evidence]).toStrictEqual(['match', 'glyph-checked']);
    });

    it('leaves a glyph the cmap maps its text away from unverified, as Chromium prints hwid', () => {
      // font-feature-settings "hwid" draws half-width Ａ glyphs whose ToUnicode still says U+FF21, with no span; the subset's cmap maps U+FF21 to the full-width glyph.
      const result = match({ texts: ['Ａ', 'Ａ'], program: plain, content: `BT /T 10 Tf 100 700 Td ${show(2)} ET` }, 'Ａ');
      expect([...summary(result), result.evidence]).toStrictEqual([
        'unverified',
        'Ａ',
        [{ kind: 'glyph-disagrees', text: 'Ａ', expectedGid: 1, drawnGid: 2, glyphs: [0] }],
        'glyph-text-only',
      ]);
    });

    it('leaves glyphs of a program without a Unicode cmap unverified, as Chromium subsets only an hwid alternate', () => {
      // Chromium's subset for a page whose only Ａ is the hwid alternate keeps a cmap table with no subtables, so nothing confirms the drawn glyph.
      const result = match({ texts: [null, 'Ａ'], program: withoutCmap(plain), content: `BT /T 10 Tf 100 700 Td ${show(2)} ET` }, 'Ａ');
      expect([...summary(result), result.evidence]).toStrictEqual([
        'unverified',
        'Ａ',
        [{ kind: 'glyph-unchecked', font: '105.0', glyphs: [0] }],
        'glyph-text-only',
      ]);
    });

    it('says nothing about a glyph whose text the cmap does not list', () => {
      // Chromium's subsets keep only reverse-mapped characters in cmap, so a vertical alternate's text is absent from it.
      const result = match({ texts: ['Ａ', null, null, null, null, '︑'], program: plain, content: `BT /T 10 Tf 100 700 Td ${show(6)} ET` }, '、');
      expect([result.status, result.evidence]).toStrictEqual(['match', 'glyph-text-only']);
    });

    it('confirms a variation sequence through the format 14 subtable', () => {
      const texts = [null, null, null, '葛', '葛󠄀'];
      const withVariant = program([{ selector: 0xe0100, defaults: [], glyphs: [[0x845b, 5]] }]);
      expect(statusOf({ texts, program: withVariant, content: `BT /T 10 Tf 100 700 Td ${show(5)} ET` }, '葛󠄀')).toBe('match');
      const defaultVariant = program([{ selector: 0xe0100, defaults: [0x845b], glyphs: [] }]);
      expect(statusOf({ texts, program: defaultVariant, content: spanned(['葛󠄀', 4]) }, '葛󠄀')).toBe('match');
      expect(statusOf({ texts, program: plain, content: spanned(['葛󠄀', 4]) }, '葛󠄀')).toBe('unverified');
    });

    it('reports Type 3 glyphs as checked by their text only', () => {
      const type3: readonly TestObject[] = [
        {
          number: 120,
          body: '<</Type/Font/Subtype/Type3/FontBBox[0 -120 1000 880]/FontMatrix[.001 0 0 .001 0 0]/CharProcs<</a 121 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]>>',
        },
        { number: 121, body: streamBody('', '1000 0 0 -120 1000 880 d1 0 0 1000 800 re f') },
      ];
      const result = match({ texts: [], content: 'BT /E 10 Tf 100 700 Td (a) Tj ET', resources: '/Font<</E 120 0 R>>', objects: type3 }, 'a');
      expect([result.status, result.evidence]).toStrictEqual(['match', 'glyph-text-only']);
    });
  });

  describe('duplicated runs', () => {
    it('collapses copies drawn as exact translations and compares the last one drawn', () => {
      // text-shadow draws the text once offset, then again on top; -webkit-text-stroke draws it again in place.
      const shadow = `${drawnAt(101, 699, show(1, 2))} ${drawnAt(100, 700, show(1, 2))}`;
      const result = match({ texts: ['山', '田'], content: shadow }, '山田');
      expect([result.status, result.glyphs, result.duplicates]).toStrictEqual([
        'match',
        [2, 3],
        [
          {
            copies: [
              [0, 1],
              [2, 3],
            ],
            kept: 1,
          },
        ],
      ]);
      const stroke = `${drawnAt(100, 700, show(1, 2))} ${drawnAt(101, 699, show(1, 2))} BT 1 Tr /T 10 Tf 100 700 Td ${show(1, 2)} ET`;
      expect(match({ texts: ['山', '田'], content: stroke }, '山田').duplicates).toStrictEqual([
        {
          copies: [
            [0, 1],
            [2, 3],
            [4, 5],
          ],
          kept: 2,
        },
      ]);
      expect(statusOf({ texts: ['山', '田'], content: shadow }, '山田', { duplicates: 'keep' })).toBe('mismatch');
    });

    it('leaves copies that are not exact translations, and repeated text side by side, alone', () => {
      const spaced = `${drawnAt(100, 700, show(1, 2))} BT /T 10 Tf 2 Tc 101 699 Td ${show(1, 2)} ET`;
      expect(statusOf({ texts: ['山', '田'], content: spaced }, '山田')).toBe('mismatch');
      // Two こ set 4 points apart overlap, but a shadow copy lies within a quarter of the font size.
      const close = drawnAt(100, 700, `[<${code(1)}> 600 <${code(1)}>] TJ`);
      expect([statusOf({ texts: ['こ'], content: close }, 'こ'), statusOf({ texts: ['こ'], content: close }, 'ここ')]).toStrictEqual(['mismatch', 'match']);
      const name = `${drawnAt(100, 700, show(1, 2, 3, 4, 5, 6))} ${drawnAt(129, 700, show(1, 2, 3, 4, 5, 6))}`;
      expect(statusOf({ texts: ['あ', 'い', 'う', 'え', 'お', 'か'], content: name }, 'あいうえおか')).toBe('mismatch');
      const repeated = drawnAt(100, 700, show(1, 1));
      expect(statusOf({ texts: ['こ'], content: repeated }, 'こ')).toBe('mismatch');
      expect(statusOf({ texts: ['こ'], content: repeated }, 'ここ')).toBe('match');
    });
  });
});

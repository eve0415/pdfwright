import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { SyntheticVariations } from '../../testing/syntheticTrueType.ts';
import type { PageText } from './extractText.ts';
import type { MatchTextOptions, TextMatch } from './matchText.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { extractText } from './extractText.ts';
import { matchText } from './matchText.ts';

const hex = (bytes: ReadonlyArray<number>): string => bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');

// UTF-16BE, as ToUnicode destinations are written.
const utf16 = (text: string): string => {
  const bytes: Array<number> = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const units = codePoint < 0x1_00_00 ? [codePoint] : [0xd8_00 + Math.floor((codePoint - 0x1_00_00) / 0x4_00), 0xdc_00 + ((codePoint - 0x1_00_00) % 0x4_00)];
    for (const unit of units) {
      bytes.push(Math.floor(unit / 256), unit % 256);
    }
  }
  return hex(bytes);
};

const code = (value: number): string => hex([Math.floor(value / 256), value % 256]);

/**
 * An Identity-H font, T, whose ToUnicode maps code n + 1 to texts[n] (nothing for null), every glyph 1000 thousandths wide with descent −120 and ascent 880.
 * Code 0 selects CID 0, the .notdef glyph.
 */
const cidFont = (texts: ReadonlyArray<string | null>, { program, widths = '' }: { program?: Uint8Array; widths?: string } = {}): ReadonlyArray<TestObject> => {
  const entries = texts.flatMap((text, index) => (text === null ? [] : [`<${code(index + 1)}> <${utf16(text)}>`]));
  return [
    { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[106 0 R]/ToUnicode 107 0 R>>' },
    {
      number: 106,
      body: `<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000${widths}/FontDescriptor 111 0 R>>`,
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
  readonly texts: ReadonlyArray<string | null>;
  /** A TrueType program embedded as the font's FontFile2, whose glyph n the code n selects. */
  readonly program?: Uint8Array;
  /** The content, where `show(codes)` writes a Tj of the codes. */
  readonly content: string;
  readonly resources?: string;
  readonly objects?: ReadonlyArray<TestObject>;
  readonly entries?: string;
  /** A W array for the descendant font, such as `/W[2[500]]`. */
  readonly widths?: string;
}

const show = (...codes: ReadonlyArray<number>): string => `<${codes.map(value => code(value)).join('')}> Tj`;

/** Shows codes 1…n of the font in one line at 10 points from (100, 700). */
const line = (count: number): string => `BT /T 10 Tf 100 700 Td ${show(...Array.from({ length: count }, (_, index) => index + 1))} ET`;

const page = ({ texts, program, content, resources = '', objects = [], entries = '', widths }: Proof): PageText => {
  const bytes = textPdfBytes({
    pages: [{ content, resources: `/Font<</T 105 0 R>>${resources}`, entries }],
    objects: [...cidFont(texts, program === undefined ? { widths: widths ?? '' } : { program, widths: widths ?? '' }), ...objects],
  });
  return extractText(loadDocument(bytes), 0);
};

const match = (proof: Proof, intended: string, options: MatchTextOptions = {}): TextMatch => matchText(page(proof), intended, options);

/** Wraps content in a Span marked-content sequence whose ActualText is the text, as UTF-16BE. */
const span = (text: string, content: string): string => `/Span <</ActualText <FEFF${utf16(text)}>>> BDC ${content} EMC`;

const spanOf = ([text, ...codes]: readonly [string, ...Array<number>]): string => span(text, show(...codes));

/** Shows each code in its own Tj at 10 points from (100, 700), the codes of `spans` inside ActualText spans. */
const spanned = (...parts: ReadonlyArray<number | readonly [string, ...Array<number>]>): string =>
  `BT /T 10 Tf 100 700 Td ${parts.map(part => (typeof part === 'number' ? show(part) : spanOf(part))).join(' ')} ET`;

/** The program with its cmap table renamed in the table directory, so that it has none. */
const withoutCmap = (program: Uint8Array): Uint8Array => {
  const copy = Uint8Array.from(program);
  const tables = (copy[4] ?? 0) * 256 + (copy[5] ?? 0);
  for (let record = 12; record < 12 + 16 * tables; record += 16) {
    if (String.fromCodePoint(...copy.subarray(record, record + 4)) === 'cmap') {
      copy[record + 3] = 0x71;
    }
  }
  return copy;
};

/** Shows the codes at 10 points from (x, y). */
const drawnAt = (x: number, y: number, codes: string): string => `BT /T 10 Tf ${String(x)} ${String(y)} Td ${codes} ET`;

/** A TrueType program whose glyph 1, for U+FF08, has ink from `left` to 900 thousandths across and from −100 to 800 up. */
const inkedAt = (left: number): Uint8Array =>
  syntheticTrueType({ name: 'Test', glyphs: [{ advance: 1000 }, { advance: 1000, box: [left, -100, 900, 800] }], characters: [[0xff_08, 1]] });

/** A Type 3 font, E, whose glyph a is drawn by the procedure. */
const type3Drawn = (procedure: string): ReadonlyArray<TestObject> => [
  {
    number: 120,
    body: '<</Type/Font/Subtype/Type3/FontBBox[0 -120 1000 880]/FontMatrix[.001 0 0 .001 0 0]/CharProcs<</a 121 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]>>',
  },
  { number: 121, body: streamBody('', procedure) },
];

/** A clip of 10-point columns from x 100, each up to the height given, and the whole page either side of them. */
const clipAbove = (tops: ReadonlyArray<number>): string =>
  `${tops.map((top, index) => `${String(100 + 10 * index)} 0 10 ${String(top)} re`).join(' ')} 0 0 100 800 re ${String(100 + 10 * tops.length)} 0 400 800 re W n`;

const summary = (result: TextMatch): Array<unknown> => [result.status, result.found, result.differences];

const summaryOf = (proof: Proof, intended: string, options: MatchTextOptions = {}): Array<unknown> => summary(match(proof, intended, options));

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
    const compatibility = String.fromCodePoint(0xfa_19);
    const unified = String.fromCodePoint(0x79_5e);
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

  it('never matches a page whose content could not all be read', () => {
    // Renderers go on past content pdfwright stops at, such as a white rectangle after a damaged string, so the rest of the page is unknown.
    const result = match({ texts: ['山', '田'], content: `${line(2)} /Missing Do` }, '山田');
    expect([...summary(result), result.glyphs]).toStrictEqual(['unverified', '山田', [{ kind: 'page-incomplete' }], [0, 1]]);
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

  it('refuses an undefined fold in the folds list, while an omitted folds option and an empty list are accepted', () => {
    const proof = page({ texts: ['山'], content: line(1) });
    const run = (folds: ReadonlyArray<unknown> | undefined): (() => TextMatch['status']) => {
      const options: MatchTextOptions = {};
      Reflect.set(options, 'folds', folds);
      return () => matchText(proof, '山', options).status;
    };
    for (const folds of [[undefined], ['radicals', undefined]]) {
      expect(run(folds)).toThrow(InvalidArgumentError);
      expect(run(folds)).toThrow(/folds/u);
    }
    expect([run(undefined)(), run([])()]).toStrictEqual(['match', 'match']);
  });

  it('leaves out glyphs outside the CropBox', () => {
    expect(statusOf({ texts: ['山', '田'], content: line(2), entries: '/CropBox[0 0 105 800]' }, '山')).toBe('match');
  });

  it('leaves out glyphs outside the MediaBox, to which a larger CropBox is reduced', () => {
    // The page's MediaBox is [0 0 600 800].
    const content = `BT /T 10 Tf 100 700 Td ${show(1)} 600 0 Td ${show(2)} ET`;
    expect(statusOf({ texts: ['山', '田'], content, entries: '/CropBox[0 0 1000 1000]' }, '山')).toBe('match');
  });

  it('selects every visible glyph when the page boxes cannot be read', () => {
    // Table 30: a CropBox must be a rectangle; with neither box known, a glyph past the MediaBox's right edge at 600 is compared too.
    const result = match({ texts: ['山', '田'], content: `${drawnAt(100, 700, show(1))} ${drawnAt(700, 700, show(2))}`, entries: '/CropBox (x)' }, '山田');
    expect([...summary(result), result.glyphs]).toStrictEqual(['unverified', '山田', [{ kind: 'page-incomplete' }], [0, 1]]);
  });

  it('compares a space glyph the intended text lacks when white space is compared', () => {
    const proof = { texts: ['山', ' ', '田'], content: line(3) };
    expect([summaryOf(proof, '山田', { whitespace: 'exact' }), summaryOf(proof, '山 田', { whitespace: 'exact' })]).toStrictEqual([
      ['mismatch', '山 田', [{ kind: 'extra', found: ' ', glyphs: [1] }]],
      ['match', '山 田', []],
    ]);
  });

  it('applies a caller’s equivalent to the folded text and lists both folds', () => {
    const result = match({ texts: ['⼭'], content: line(1) }, 'X', { equivalents: [['山', 'X']] });
    expect([...summary(result), result.folds]).toStrictEqual([
      'match',
      'X',
      [],
      [
        { fold: 'radicals', from: '⼭', to: '山', glyphs: [0] },
        { fold: 'caller', from: '山', to: 'X', glyphs: [0] },
      ],
    ]);
  });

  it.each([
    ['a substitution on a page whose content could not all be read', `${line(2)} /Missing Do`, '山中', ['substituted', 'page-incomplete']],
    ['an extra glyph beside a glyph hidden in part', `${clipAbove([800, 704])} ${line(2)}`, '山', ['extra', 'partly-hidden']],
  ])('reports a mismatch for %s', (_, content, intended, kinds) => {
    const result = match({ texts: ['山', '田'], content }, intended);
    expect([result.status, result.differences.map(difference => difference.kind)]).toStrictEqual(['mismatch', kinds]);
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

    it('leaves glyphs a clip or a later rectangle hides in part unverified, one difference per run', () => {
      // Four glyphs from x 100 to 140, their core boxes 698.8–708.8; the clip keeps each whole or only below 704.
      const texts = ['山', '田', '太', '郎'];
      expect(summaryOf({ texts, content: `${clipAbove([800, 704, 800, 704])} ${line(4)}` }, '山田太郎')).toStrictEqual([
        'unverified',
        '山田太郎',
        [
          { kind: 'partly-hidden', glyphs: [1] },
          { kind: 'partly-hidden', glyphs: [3] },
        ],
      ]);
      expect(summaryOf({ texts, content: `${clipAbove([800, 704, 704, 800])} ${line(4)}` }, '山田太郎')[2]).toStrictEqual([
        { kind: 'partly-hidden', glyphs: [1, 2] },
      ]);
      expect(summaryOf({ texts: ['山', '田'], content: `${line(2)} 1 g 90 704 50 30 re f` }, '山田')[2]).toStrictEqual([
        { kind: 'partly-hidden', glyphs: [0, 1] },
      ]);
    });

    it('leaves out a glyph whose core box is hidden, though the ascent and descent around it show', () => {
      // A d0 glyph gives no ink box, so the cut is measured against the core box; the FontBBox spans −300 to 1100 thousandths: at 10 points from (100, 700) the advance box is 697–711 and the core box 698.8–708.8.
      const type3: ReadonlyArray<TestObject> = [
        {
          number: 120,
          body: '<</Type/Font/Subtype/Type3/FontBBox[0 -300 1000 1100]/FontMatrix[.001 0 0 .001 0 0]/CharProcs<</a 121 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]>>',
        },
        { number: 121, body: streamBody('', '1000 0 d0 0 -300 1000 1400 re f') },
      ];
      const result = match(
        { texts: [], content: '0 0 600 698.5 re W n BT /E 10 Tf 100 700 Td (a) Tj ET', resources: '/Font<</E 120 0 R>>', objects: type3 },
        'a',
      );
      expect([result.status, result.glyphs]).toStrictEqual(['mismatch', []]);
    });

    it('measures the cut by the ink of an embedded TrueType glyph, and by the em box without one', () => {
      // Chromium pushes the blank half of a full-width （ at the start of a line past the content edge when it trims punctuation spacing; the margin clip then cuts 0.49 em of the advance box, but none of the ink, which lies in the right half.
      const cut = `104.9 0 500 800 re W n ${line(1)}`;
      const hidden = [inkedAt(500), inkedAt(100)].map(program => page({ texts: ['（'], program, content: cut }).glyphs.map(glyph => glyph.coreHidden));
      const fallback = page({ texts: ['（'], content: cut }).glyphs.map(glyph => glyph.coreHidden);
      expect([...hidden, fallback]).toStrictEqual([['none'], ['partly'], ['partly']]);
    });

    it('measures the cut by the d1 box of a Type 3 glyph, and by the em box for a d0 glyph', () => {
      const hidden = ['1000 0 500 -100 900 800 d1 500 -100 400 900 re f', '1000 0 d0 500 -100 400 900 re f'].map(procedure =>
        page({
          texts: [],
          content: '104.9 0 500 800 re W n BT /E 10 Tf 100 700 Td (a) Tj ET',
          resources: '/Font<</E 120 0 R>>',
          objects: type3Drawn(procedure),
        }).glyphs.map(glyph => glyph.coreHidden),
      );
      expect(hidden).toStrictEqual([['none'], ['partly']]);
    });

    it('rejects text after text shown to clip, whose outlines are not read', () => {
      // 9.3.6: at the end of a text object in render mode 7 the glyph outlines become the clip; a dot far from the name hides it.
      expect(statusOf({ texts: ['山', '田', '・'], content: `BT /T 10 Tf 7 Tr 400 100 Td ${show(3)} ET 0 Tr ${line(2)}` }, '山田')).toBe('mismatch');
    });

    it('rejects a Type 3 glyph whose procedure paints nothing, but not an empty space glyph', () => {
      // Chromium's Type 3 space is the empty procedure 224 0 0 0 0 0 d1; an empty procedure for 山 prints nothing.
      const type3: ReadonlyArray<TestObject> = [
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
      const empty: ReadonlyArray<TestObject> = [
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

    it('reads an empty Type 3 glyph without text as nothing, and one that claims text as missing', () => {
      // Codes a and b paint; code c's procedure paints nothing, and its glyph name g1 stands for no character.
      const type3: ReadonlyArray<TestObject> = [
        {
          number: 120,
          body: '<</Type/Font/Subtype/Type3/FontBBox[0 -120 1000 880]/FontMatrix[.001 0 0 .001 0 0]/CharProcs<</a 121 0 R/b 121 0 R/g1 122 0 R>>/Encoding<</Differences[97/a/b/g1]>>/FirstChar 97/LastChar 99/Widths[1000 1000 1000]>>',
        },
        { number: 121, body: streamBody('', '1000 0 0 -120 1000 880 d1 0 0 1000 800 re f') },
        { number: 122, body: streamBody('', '1000 0 0 0 0 0 d1') },
      ];
      const claimed: ReadonlyArray<TestObject> = [
        { number: 120, body: `${type3[0]?.body.slice(0, -2) ?? ''}/ToUnicode 123 0 R>>` },
        ...type3.slice(1),
        { number: 123, body: streamBody('', 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <63> <0078> endbfchar endcmap') },
      ];
      const shown = [type3, claimed].map(objects =>
        summaryOf({ texts: [], content: 'BT /E 10 Tf 100 700 Td (acb) Tj ET', resources: '/Font<</E 120 0 R>>', objects }, 'ab'),
      );
      expect(shown).toStrictEqual([
        ['match', 'ab', []],
        ['mismatch', 'axb', [{ kind: 'missing-glyph', glyphs: [1], intendedIndex: undefined }]],
      ]);
    });

    it('rejects a Chromium g0 glyph whatever text it claims', () => {
      const chromium: ReadonlyArray<TestObject> = [
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
    });

    it('applies caller equivalents after checking a span against its glyphs', () => {
      const result = match({ texts: ['⼾'], content: spanned(['⼾', 1]) }, '戸', { equivalents: [['⼾', '戸']] });
      expect([...summary(result), result.folds]).toStrictEqual(['match', '戸', [], [{ fold: 'caller', from: '⼾', to: '戸', glyphs: [0] }]]);
    });

    it('leaves a variation selector only the span carries unverified', () => {
      // IPAGothic paints plain 葛 under ActualText U+845B U+E0100; Noto's glyph text carries the selector itself.
      expect(summaryOf({ texts: ['葛', '城'], content: spanned(['葛󠄀', 1], 2) }, '葛󠄀城')).toStrictEqual([
        'unverified',
        '葛󠄀城',
        [{ kind: 'variant-unverified', intended: '葛󠄀', intendedIndex: 0, glyphs: [0] }],
      ]);
      expect(statusOf({ texts: ['葛󠄀', '城'], content: spanned(['葛󠄀', 1], 2) }, '葛󠄀城')).toBe('match');
    });

    it('compares a span whose variation selector neither the glyphs nor the intended text carry as the text of its glyphs', () => {
      expect(summaryOf({ texts: ['葛', '城'], content: spanned(['葛󠄀', 1], 2) }, '葛城')).toStrictEqual(['match', '葛城', []]);
    });

    it('does not set aside a variation selector the glyphs have and the span lacks, or one on another glyph', () => {
      // A glyph whose own text is 葛󠄀 under a span claiming plain 葛 shows the variant, not the intended character.
      expect(statusOf({ texts: ['葛󠄀', '城'], content: spanned(['葛', 1], 2) }, '葛城')).toBe('mismatch');
      // The span's selector belongs to 葛, but the glyphs carry it on 辻: their own text is compared, and each character differs.
      expect(summaryOf({ texts: ['葛', '辻󠄀'], content: spanned(['葛󠄀辻', 1, 2]) }, '葛󠄀辻')).toStrictEqual([
        'mismatch',
        '葛辻󠄀',
        [
          { kind: 'substituted', intended: '葛󠄀', found: '葛', intendedIndex: 0, glyphs: [0, 1] },
          { kind: 'substituted', intended: '辻', found: '辻󠄀', intendedIndex: 3, glyphs: [0, 1] },
          { kind: 'actual-text-disagrees', actualText: '葛󠄀辻', glyphText: '葛辻󠄀', span: 0, glyphs: [0, 1] },
        ],
      ]);
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

    it('compares only the glyphs’ own text when spans are ignored', () => {
      // A span-only variation selector, which a checked span leaves unverified, is no evidence at all; nor is a span whose glyphs are not selected.
      const variant = { texts: ['葛', '城'], content: spanned(['葛󠄀', 1], 2) };
      const unseen = { texts: ['山', '中', '田'], content: `BT /T 10 Tf 100 700 Td ${show(1)} 3 Tr ${span('中', show(2))} 0 Tr ${show(3)} ET` };
      expect([summaryOf(variant, '葛󠄀城', { actualText: 'ignore' }), summaryOf(unseen, '山田', { actualText: 'ignore' })]).toStrictEqual([
        ['mismatch', '葛城', [{ kind: 'substituted', intended: '葛󠄀', found: '葛', intendedIndex: 0, glyphs: [0] }]],
        ['match', '山田', []],
      ]);
    });

    it.each([
      ['empty', ''],
      ['another text', 'x'],
    ])('leaves a glyph whose text is intended unverified under a span whose text is %s', (_, actualText) => {
      expect(summaryOf({ texts: ['山'], content: spanned([actualText, 1]) }, '山')).toStrictEqual([
        'unverified',
        '山',
        [{ kind: 'actual-text-disagrees', actualText, glyphText: '山', span: 0, glyphs: [0] }],
      ]);
    });

    it('sets variation selectors of spans and glyphs aside when selectors are ignored', () => {
      const ignore = { variationSelectors: 'ignore' } as const;
      expect([
        summaryOf({ texts: ['葛', '城'], content: spanned(['葛󠄀', 1], 2) }, '葛󠄀城', ignore),
        summaryOf({ texts: ['葛󠄀', '城'], content: line(2) }, '葛城', ignore),
      ]).toStrictEqual([
        ['match', '葛城', []],
        ['match', '葛城', []],
      ]);
    });

    it.each([
      ['ignores a span of white space between compared glyphs when white space is ignored', ' ', 'between', {}, ['match', '山田', []]],
      [
        'reports a span of white space between compared glyphs when white space is compared',
        ' ',
        'between',
        { whitespace: 'exact' },
        ['unverified', '山田', [{ kind: 'no-glyph-evidence', text: ' ', span: 0 }]],
      ],
      ['does not report a span before the first compared glyph', '中', 'before', {}, ['match', '山田', []]],
    ] as const)('%s', (_, text, where, options, expected) => {
      // Glyph 2 is drawn in render mode 3, so the default selection leaves it out.
      const hidden = `3 Tr ${span(text, show(2))} 0 Tr`;
      const content =
        where === 'between' ? `BT /T 10 Tf 100 700 Td ${show(1)} ${hidden} ${show(3)} ET` : `BT /T 10 Tf 100 700 Td ${hidden} ${show(1)} ${show(3)} ET`;
      expect(summaryOf({ texts: ['山', text, '田'], content }, '山田', options)).toStrictEqual(expected);
    });
  });

  describe('embedded cmaps', () => {
    // Glyph 1 is Ａ as the cmap maps U+FF21, glyph 2 a half-width alternate the cmap does not list, glyph 3 侭, glyph 4 葛, glyph 5 its variant for U+E0100, glyph 6 a vertical comma.
    const box = { advance: 1000, box: [100, 0, 900, 700] } as const;
    const program = (variations: ReadonlyArray<SyntheticVariations> = []): Uint8Array =>
      syntheticTrueType({
        name: 'Test',
        glyphs: [{ advance: 1000 }, box, box, box, box, box, box],
        characters: [
          [0xff_21, 1],
          [0x4f_ad, 3],
          [0x84_5b, 4],
        ],
        variations,
      });
    const plain = program();

    it('rejects a subset glyph whose ToUnicode character is absent from its cmap', () => {
      const result = match({ texts: ['B'], program: plain, content: `BT /T 10 Tf 100 700 Td ${show(1)} ET` }, 'B');
      expect([result.status, result.differences.map(difference => difference.kind)]).toStrictEqual(['mismatch', ['glyph-disagrees']]);
    });

    it('rejects a simple TrueType glyph when ToUnicode disagrees with its standard encoding name', () => {
      const simpleProgram = syntheticTrueType({ name: 'Test', glyphs: [{ advance: 1000 }, box], characters: [[0x41, 1]] });
      const objects: ReadonlyArray<TestObject> = [
        {
          number: 120,
          body: '<</Type/Font/Subtype/TrueType/BaseFont/Test/FirstChar 65/LastChar 65/Widths[1000]/Encoding<</Differences[65/A]>>/FontDescriptor 122 0 R/ToUnicode 121 0 R>>',
        },
        { number: 121, body: streamBody('', 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0042> endbfchar endcmap') },
        {
          number: 122,
          body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontBBox[0 0 1000 1000]/ItalicAngle 0/Ascent 800/Descent 0/CapHeight 700/StemV 80/FontFile2 123 0 R>>',
        },
        { number: 123, body: streamBody('', latin1Text(simpleProgram)) },
      ];
      const bytes = textPdfBytes({ pages: [{ content: 'BT /S 10 Tf 100 700 Td (A) Tj ET', resources: '/Font<</S 120 0 R>>' }], objects });
      const result = matchText(extractText(loadDocument(bytes), 0), 'B');
      expect([result.status, result.differences.map(difference => difference.kind)]).toStrictEqual(['mismatch', ['encoding-disagrees']]);
    });

    it('confirms glyphs the embedded cmap maps their text to', () => {
      const result = match({ texts: ['Ａ', null, '侭'], program: plain, content: `BT /T 10 Tf 100 700 Td ${show(1, 3)} ET` }, 'Ａ侭');
      expect([result.status, result.evidence]).toStrictEqual(['match', 'glyph-checked']);
    });

    it('reports a mismatch when the cmap maps text to another glyph', () => {
      // font-feature-settings "hwid" draws half-width Ａ glyphs whose ToUnicode still says U+FF21, with no span; the subset's cmap maps U+FF21 to the full-width glyph.
      const result = match({ texts: ['Ａ', 'Ａ'], program: plain, content: `BT /T 10 Tf 100 700 Td ${show(2)} ET` }, 'Ａ');
      expect([...summary(result), result.evidence]).toStrictEqual([
        'mismatch',
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
      // Chromium's subsets keep only reverse-mapped characters in cmap, so a vertical alternate's text is absent from it; 、 is Tu in Unicode's VerticalOrientation.txt.
      const result = match({ texts: ['Ａ', null, null, null, null, '︑'], program: plain, content: `BT /T 10 Tf 100 700 Td ${show(6)} ET` }, '、');
      expect([result.status, result.evidence]).toStrictEqual(['match', 'glyph-text-only']);
    });

    it('reports a glyph half an em wide whose text is a full-width or wide character, as hwid draws beside other text', () => {
      // Chromium's hwid alternates keep ToUnicode U+FF21 but are 500 thousandths wide in W; palt and other positioning features leave W at 1000.
      // A subset that keeps only the alternate has no U+FF21 in its cmap; a half-width A is no evidence, and in a font that shows such characters at proportional widths, as Ｂ at 700 here, nor is a half-em Ａ.
      const unlisted = syntheticTrueType({ name: 'Test', glyphs: [{ advance: 1000 }, box, box, box, box], characters: [[0x5c_71, 1]] });
      const texts = ['山', 'Ａ', 'A', 'Ｂ'];
      const proof = { texts, program: unlisted, content: `BT /T 10 Tf 100 700 Td ${show(1, 2, 3)} ET`, widths: '/W[2[500]3[500]]' };
      expect(summaryOf(proof, '山ＡA')).toStrictEqual([
        'mismatch',
        '山ＡA',
        [{ kind: 'glyph-disagrees', text: 'Ａ', expectedGid: undefined, drawnGid: 2, glyphs: [1] }],
      ]);
      const proportional = { ...proof, content: `BT /T 10 Tf 100 700 Td ${show(1, 2, 3, 4)} ET`, widths: '/W[2[500]3[500]4[700]]' };
      expect(statusOf(proportional, '山ＡAＢ')).toBe('match');
    });

    it('reports a glyph whose own character the cmap maps to it but whose folded character it does not list', () => {
      // Chromium's subset cmap lists every code point of a retained glyph, so a font that maps U+2F2D but not U+5C71 to the glyph draws the radical, not 山.
      const radical = syntheticTrueType({ name: 'Test', glyphs: [{ advance: 1000 }, box], characters: [[0x2f_2d, 1]] });
      expect(summaryOf({ texts: ['⼭'], program: radical, content: line(1) }, '山')).toStrictEqual([
        'mismatch',
        '山',
        [{ kind: 'glyph-disagrees', text: '山', expectedGid: undefined, drawnGid: 1, glyphs: [0] }],
      ]);
    });

    it('accepts a vertical alternate the cmap maps away from only when the geometry sets it upright in a column', () => {
      // Glyph 3 is the horizontal 、 the cmap lists and glyph 4 its vertical alternate, whose ToUnicode is 、 too; Chromium stacks upright glyphs down a column one Td at a time.
      const both = syntheticTrueType({
        name: 'Test',
        glyphs: [{ advance: 1000 }, box, box, box, box],
        characters: [
          [0x5c_71, 1],
          [0x75_30, 2],
          [0x30_01, 3],
        ],
      });
      const texts = ['山', '田', '、', '、'];
      const column = `BT /T 10 Tf 100 700 Td ${show(1)} 0 -10 Td ${show(4)} 0 -10 Td ${show(2)} ET`;
      const disagrees = { kind: 'glyph-disagrees', text: '、', expectedGid: 3, drawnGid: 4, glyphs: [1] };
      expect([
        statusOf({ texts, program: both, content: column }, '山、田'),
        summaryOf({ texts, program: both, content: `BT /T 10 Tf 100 700 Td ${show(1, 4, 2)} ET` }, '山、田')[2],
        summaryOf({ texts, program: both, content: `BT /T 10 Tf 100 700 Td ${show(4)} ET` }, '、')[2],
      ]).toStrictEqual(['match', [disagrees], [{ ...disagrees, glyphs: [0] }]]);
    });

    it.each([
      // The vertical alternate of 、 is drawn first and 山 after it, 0.5 to 2 em down the column and less than 0.5 em across it.
      ['half an em down', 0, -5, 'match'],
      ['two ems down', 0, -20, 'match'],
      ['just under half an em down', 0, -4.9, 'mismatch'],
      ['just over two ems down', 0, -20.1, 'mismatch'],
      ['an em down and just under half an em across', 4.9, -10, 'match'],
      ['an em down and half an em across', 5, -10, 'mismatch'],
    ])('reads a vertical alternate followed by a glyph %s as set upright in a column, or not', (_, dx, dy, status) => {
      const both = syntheticTrueType({
        name: 'Test',
        glyphs: [{ advance: 1000 }, box, box, box, box],
        characters: [
          [0x5c_71, 1],
          [0x30_01, 3],
        ],
      });
      const content = `BT /T 10 Tf 100 700 Td ${show(4)} ${String(dx)} ${String(dy)} Td ${show(1)} ET`;
      expect(statusOf({ texts: ['山', null, null, '、'], program: both, content }, '、山')).toBe(status);
    });

    it.each([
      // Ａ is code 2 and Ｂ code 4, neither in the cmap; Ａ is half-width within 0.1 em of 500 thousandths, and Ｂ makes the font proportional more than 0.02 em away from 1000.
      ['Ａ 600 wide is half-width', '/W[2[600]]', 'mismatch'],
      ['Ａ 601 wide is not', '/W[2[601]]', 'match'],
      ['Ａ 400 wide is half-width', '/W[2[400]]', 'mismatch'],
      ['Ａ 399 wide is not', '/W[2[399]]', 'match'],
      ['Ｂ 981 wide keeps the font from being proportional', '/W[2[500]4[981]]', 'mismatch'],
      ['Ｂ 979 wide makes it proportional', '/W[2[500]4[979]]', 'match'],
      ['Ｂ 1019 wide keeps the font from being proportional', '/W[2[500]4[1019]]', 'mismatch'],
      ['Ｂ 1021 wide makes it proportional', '/W[2[500]4[1021]]', 'match'],
    ])('reads widths against the em: %s', (_, widths, status) => {
      const unlisted = syntheticTrueType({ name: 'Test', glyphs: [{ advance: 1000 }, box, box, box, box], characters: [[0x5c_71, 1]] });
      expect(statusOf({ texts: ['山', 'Ａ', 'A', 'Ｂ'], program: unlisted, content: `BT /T 10 Tf 100 700 Td ${show(1, 2, 4)} ET`, widths }, '山ＡＢ')).toBe(
        status,
      );
    });

    it('lists the glyphs of a program without a Unicode cmap as unchecked, apart from white space', () => {
      const result = match({ texts: ['山', ' ', '田'], program: withoutCmap(plain), content: line(3) }, '山 田');
      expect(summary(result)).toStrictEqual(['unverified', '山田', [{ kind: 'glyph-unchecked', font: '105.0', glyphs: [0, 2] }]]);
    });

    it('checks ToUnicode against the encoding only for a simple TrueType font', () => {
      // A Type1 font's glyph names are not compared with its ToUnicode, which decides its text alone.
      const objects: ReadonlyArray<TestObject> = [
        {
          number: 120,
          body: '<</Type/Font/Subtype/Type1/BaseFont/Test/FirstChar 65/LastChar 65/Widths[1000]/Encoding<</Differences[65/A]>>/FontDescriptor 122 0 R/ToUnicode 121 0 R>>',
        },
        { number: 121, body: streamBody('', 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0058> endbfchar endcmap') },
        {
          number: 122,
          body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontBBox[0 0 1000 1000]/ItalicAngle 0/Ascent 800/Descent 0/CapHeight 700/StemV 80>>',
        },
      ];
      const bytes = textPdfBytes({ pages: [{ content: 'BT /S 10 Tf 100 700 Td (A) Tj ET', resources: '/Font<</S 120 0 R>>' }], objects });
      expect(summary(matchText(extractText(loadDocument(bytes), 0), 'X'))).toStrictEqual(['match', 'X', []]);
    });

    it('accepts a character by the cmap only for one glyph, not for a cluster or span of two', () => {
      // The cmap maps 戸 and ⼾ to glyph 1, the first of the two glyphs shown.
      const shared = syntheticTrueType({
        name: 'Test',
        glyphs: [{ advance: 1000 }, box, box],
        characters: [
          [0x2f_3e, 1],
          [0x62_38, 1],
          [0x78, 2],
        ],
      });
      const agreeing = match({ texts: ['⼾', 'x'], program: shared, content: spanned(['⼾x', 1, 2]) }, '戸x');
      const claiming = match({ texts: ['⼾', 'x'], program: shared, content: spanned(['戸', 1, 2]) }, '戸');
      expect([summary(agreeing), summary(claiming)]).toStrictEqual([
        ['mismatch', '⼾x', [{ kind: 'substituted', intended: '戸', found: '⼾', intendedIndex: 0, glyphs: [0, 1] }]],
        [
          'mismatch',
          '⼾x',
          [
            { kind: 'substituted', intended: '戸', found: '⼾', intendedIndex: 0, glyphs: [0, 1] },
            { kind: 'extra', found: 'x', glyphs: [0, 1] },
            { kind: 'actual-text-disagrees', actualText: '戸', glyphText: '⼾x', span: 0, glyphs: [0, 1] },
          ],
        ],
      ]);
    });

    it('accepts a substituted character the embedded cmap maps to exactly the glyph drawn, and no other', () => {
      // Noto Sans JP draws 戸 with the glyph it also maps from U+2F3E, and Chromium's ToUnicode gives U+2F3E; the jis78 form of 儘 is a glyph the cmap gives 侭, not 儘.
      const shared = syntheticTrueType({
        name: 'Test',
        glyphs: [{ advance: 1000 }, box, box],
        characters: [
          [0x2f_3e, 1],
          [0x62_38, 1],
          [0x4f_ad, 2],
          [0x51_18, 1],
        ],
      });
      const result = match({ texts: ['⼾'], program: shared, content: line(1) }, '戸');
      expect([...summary(result), result.folds]).toStrictEqual(['match', '戸', [], [{ fold: 'embedded-cmap', from: '⼾', to: '戸', glyphs: [0] }]]);
      // Chromium also wraps the glyph in a span whose ActualText is 戸.
      const inSpan = match({ texts: ['⼾'], program: shared, content: `BT /T 10 Tf 100 700 Td ${span('戸', show(1))} ET` }, '戸');
      expect([...summary(inSpan), inSpan.folds]).toStrictEqual(['match', '戸', [], [{ fold: 'embedded-cmap', from: '⼾', to: '戸', glyphs: [0] }]]);
      expect(summaryOf({ texts: [null, '侭'], program: shared, content: `BT /T 10 Tf 100 700 Td ${show(2)} ET` }, '儘')).toStrictEqual([
        'mismatch',
        '侭',
        [{ kind: 'substituted', intended: '儘', found: '侭', intendedIndex: 0, glyphs: [0] }],
      ]);
    });

    it('confirms a variation sequence through the format 14 subtable', () => {
      const texts = [null, null, null, '葛', '葛󠄀'];
      const withVariant = program([{ selector: 0xe_01_00, defaults: [], glyphs: [[0x84_5b, 5]] }]);
      expect(statusOf({ texts, program: withVariant, content: `BT /T 10 Tf 100 700 Td ${show(5)} ET` }, '葛󠄀')).toBe('match');
      const defaultVariant = program([{ selector: 0xe_01_00, defaults: [0x84_5b], glyphs: [] }]);
      expect(statusOf({ texts, program: defaultVariant, content: spanned(['葛󠄀', 4]) }, '葛󠄀')).toBe('match');
      expect(statusOf({ texts, program: plain, content: spanned(['葛󠄀', 4]) }, '葛󠄀')).toBe('unverified');
    });

    it('reports Type 3 glyphs as checked by their text only', () => {
      const type3: ReadonlyArray<TestObject> = [
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

    it.each([
      // At 10 points a copy must lie less than 2.5 points from the first run, and each of its glyphs within 0.05 points of the same translation.
      ['2.49 points away', `${drawnAt(102.49, 700, show(1, 2))} ${drawnAt(100, 700, show(1, 2))}`, 'match'],
      ['2.5 points away', `${drawnAt(102.5, 700, show(1, 2))} ${drawnAt(100, 700, show(1, 2))}`, 'mismatch'],
      ['with a glyph 0.05 points further on', `${drawnAt(101, 700, `[<${code(1)}> -5 <${code(2)}>] TJ`)} ${drawnAt(100, 700, show(1, 2))}`, 'match'],
      ['with a glyph 0.051 points further on', `${drawnAt(101, 700, `[<${code(1)}> -5.1 <${code(2)}>] TJ`)} ${drawnAt(100, 700, show(1, 2))}`, 'mismatch'],
    ])('collapses a copy %s, or not', (_, content, status) => {
      expect(statusOf({ texts: ['山', '田'], content }, '山田')).toBe(status);
    });

    it('does not collapse copies whose positions are unknown', () => {
      // A string in 90ms-RKSJ-H, which no provider supplies, cannot be split, so the position after it is unknown until the next Td.
      const objects: ReadonlyArray<TestObject> = [
        ...cidFont(['山', '田']),
        { number: 115, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/90ms-RKSJ-H/DescendantFonts[106 0 R]>>' },
      ];
      const compared = (unsplit: string): TextMatch['status'] => {
        const content = [101, 100].map(x => `BT /T 10 Tf ${String(x)} 700 Td ${unsplit} /T 10 Tf ${show(1, 2)} ET`).join(' ');
        const bytes = textPdfBytes({ pages: [{ content, resources: '/Font<</T 105 0 R/J 115 0 R>>' }], objects });
        return matchText(extractText(loadDocument(bytes), 0), '山田', { select: glyph => glyph.font === '105.0' }).status;
      };
      expect([compared(''), compared('/J 10 Tf <8341> Tj')]).toStrictEqual(['match', 'mismatch']);
    });

    it('compares copies whose glyphs interleave in the chosen order as they are', () => {
      // In rows the shadow's glyphs and the text's alternate by left edge, so no consecutive runs repeat one another.
      const shadow = `${drawnAt(101, 699, show(1, 2))} ${drawnAt(100, 700, show(1, 2))}`;
      const result = match({ texts: ['山', '田'], content: shadow }, '山田', { order: 'rows' });
      expect([result.status, result.found, result.duplicates, result.differences.map(difference => difference.kind)]).toStrictEqual([
        'mismatch',
        '山山田田',
        [],
        ['extra', 'extra'],
      ]);
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

describe('properties', () => {
  // Distinct CJK ideographs, some outside the Basic Multilingual Plane so that UTF-16 offsets differ from positions; none is a fold source.
  const ideograph = fc
    .oneof(fc.integer({ min: 0x4e_00, max: 0x9f_ff }), fc.integer({ min: 0x2_00_00, max: 0x2_a6_df }))
    .map(codePoint => String.fromCodePoint(codePoint));
  const drawn = fc.uniqueArray(ideograph, { minLength: 1, maxLength: 8 }).chain(characters =>
    fc.record({
      characters: fc.constant(characters),
      at: fc.integer({ min: 0, max: characters.length - 1 }),
      replacement: ideograph.filter(character => !characters.includes(character)),
    }),
  );

  it('matches the text a page draws one glyph per character, and finds one substitution where one character differs', () => {
    fc.assert(
      fc.property(drawn, ({ characters, at, replacement }) => {
        const shown = page({ texts: characters, content: line(characters.length) });
        const text = characters.join('');
        const intended = characters.map((character, index) => (index === at ? replacement : character)).join('');
        const offset = characters.slice(0, at).join('').length;
        expect([summary(matchText(shown, text)), summary(matchText(shown, intended))]).toStrictEqual([
          ['match', text, []],
          ['mismatch', text, [{ kind: 'substituted', intended: replacement, found: characters[at], intendedIndex: offset, glyphs: [at] }]],
        ]);
      }),
    );
  });
});

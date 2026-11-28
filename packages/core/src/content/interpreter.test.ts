import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { TestPage } from '../testing/textPdf.ts';
import type { ColorSelectEvent, ColorSpaceUse, CoverEvent, InterpretOptions, InterpretResult, PaintEvent, TextShowEvent } from './interpreter.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { FontCache } from '../font/loadFont.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';
import { textPdf, textPdfBytes } from '../testing/textPdf.ts';

import { interpretPage } from './interpreter.ts';

interface Run {
  readonly covers: Array<CoverEvent>;
  readonly paints: Array<PaintEvent>;
  readonly texts: Array<TextShowEvent>;
  readonly selects: Array<ColorSelectEvent>;
  readonly result: InterpretResult;
}

// Code 32 is 278 thousandths wide and code 65 (A) 667, as in Helvetica.
const SIMPLE_FONT: TestObject = {
  number: 101,
  body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/FirstChar 32/LastChar 65/Widths[278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667]>>',
};
const CID_FONT: TestObject = {
  number: 104,
  body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000/W[32[500]]>>',
};
const HORIZONTAL_FONT: TestObject = { number: 102, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[104 0 R]>>' };
const VERTICAL_FONT: TestObject = { number: 103, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-V/DescendantFonts[104 0 R]>>' };
const FONTS = [SIMPLE_FONT, HORIZONTAL_FONT, VERTICAL_FONT, CID_FONT];
const FONT_RESOURCES = '/Font<</F1 101 0 R/H 102 0 R/V 103 0 R/U 105 0 R>>';

const form = (number: number, dictionary: string, content: string): TestObject => ({
  number,
  body: streamBody(`/Type/XObject/Subtype/Form${dictionary}`, content),
});

const run = (page: TestPage, objects: ReadonlyArray<TestObject> = [], options: InterpretOptions = {}): Run => {
  const paints: Array<PaintEvent> = [];
  const texts: Array<TextShowEvent> = [];
  const selects: Array<ColorSelectEvent> = [];
  const covers: Array<CoverEvent> = [];
  const document = textPdf({ pages: [page], objects: [...FONTS, ...objects] });
  const result = interpretPage(document, 0, {
    ...options,
    cover: event => {
      covers.push(event);
    },
    paint: event => {
      paints.push(event);
    },
    text: event => {
      texts.push(event);
    },
    select: event => {
      selects.push(event);
    },
  });
  return { covers, paints, texts, selects, result };
};

const textRun = (content: string, objects: ReadonlyArray<TestObject> = [], resources = ''): Run =>
  run({ content, resources: `${FONT_RESOURCES}${resources}` }, objects);

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

// A path of `count` rectangles 5 wide and 10 apart, none touching another.
const rectangles = (count: number): string => Array.from({ length: count }, (_, index) => `${String(index * 10)} 0 5 5 re`).join(' ');

// The translation of the text matrix at each shown glyph: where the glyph's origin is in unscaled text space.
const positions = (texts: ReadonlyArray<TextShowEvent>): Array<readonly [number, number]> =>
  texts.flatMap(text => text.glyphs.map(({ textMatrix }) => [round(textMatrix[4]), round(textMatrix[5])] as const));

// A name space by its name, an array space by its family name.
const spaceName = (use: ColorSpaceUse): string => {
  const family = use.space?.kind === 'array' ? use.space.items[0] : use.space;
  return family?.kind === 'name' ? latin1Text(family.bytes) : (family?.kind ?? 'unknown');
};

const paintSpaces = (paints: ReadonlyArray<PaintEvent>): Array<string> =>
  paints.map(paint => `${paint.kind}:${paint.colorSpaces.map(use => spaceName(use)).join(',')}`);

describe('graphics state', () => {
  it('concatenates cm with the CTM and restores it with Q', () => {
    const { texts } = textRun('q 2 0 0 2 10 20 cm 1 0 0 1 5 5 cm BT /F1 10 Tf (A) Tj ET Q BT /F1 10 Tf (A) Tj ET');
    // ISO 32000-1:2008, 8.3.4: the operand is premultiplied, so [1 0 0 1 5 5] × [2 0 0 2 10 20] = [2 0 0 2 20 30].
    expect(texts.map(text => text.state.ctm)).toStrictEqual([
      [2, 0, 0, 2, 20, 30],
      [1, 0, 0, 1, 0, 0],
    ]);
  });

  it('reports the colour spaces each painting operator uses and each selection', () => {
    const { paints, selects } = run(
      { content: '/CS1 cs 0.5 scn 1 0 0 RG 0 0 10 10 re f 0 0 10 10 re S 0 0 10 10 re B 0 0 10 10 re n', resources: '/ColorSpace<</CS1 110 0 R>>' },
      [
        { number: 110, body: '[/Separation/Spot/DeviceCMYK 111 0 R]' },
        { number: 111, body: '<</FunctionType 2/Domain[0 1]/C1[0 1 0 0]/N 1>>' },
      ],
    );
    expect(paintSpaces(paints)).toStrictEqual(['fill:Separation', 'stroke:DeviceRGB', 'fill-stroke:Separation,DeviceRGB']);
    expect(selects.map(select => `${select.target}:${spaceName(select.use)}`)).toStrictEqual(['fill:Separation', 'stroke:DeviceRGB']);
    expect(paints[0]?.colorSpaces[0]?.components).toStrictEqual([0.5]);
    expect(paints.map(paint => paint.context.sources)).toStrictEqual([[{ kind: 'page' }], [{ kind: 'page' }], [{ kind: 'page' }]]);
  });

  it('paints images, image masks, inline images and shadings in their colour spaces', () => {
    const { paints } = run(
      {
        content:
          '0 1 0 rg /Im1 Do /Im2 Do BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000 EI BI /W 1 /H 1 /IM true ID \u0000 EI BI /W 1 /H 1 /CS /CS1 /BPC 8 ID \u0000 EI /Sh1 sh',
        resources: '/XObject<</Im1 110 0 R/Im2 111 0 R>>/ColorSpace<</CS1/DeviceCMYK>>/Shading<</Sh1 112 0 R>>',
      },
      [
        { number: 110, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8', '\u0000') },
        { number: 111, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/ImageMask true', '\u0000') },
        { number: 112, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 1 0]/Function 113 0 R>>' },
        { number: 113, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 0]/C1[1 1 1]/N 1>>' },
      ],
    );
    expect(paintSpaces(paints)).toStrictEqual([
      'image:DeviceGray',
      'image-mask:DeviceRGB',
      'inline-image:DeviceGray',
      'inline-image-mask:DeviceRGB',
      'inline-image:DeviceCMYK',
      'shading:DeviceRGB',
    ]);
  });

  it('paints s as a stroke, F and f* as fills, and b, b* and B* as fill and stroke', () => {
    // ISO 32000-1:2008, 8.5.3.1, Table 60.
    const { paints } = textRun(['s', 'F', 'f*', 'b', 'b*', 'B*'].map(operator => `0 0 1 1 re ${operator}`).join(' '));
    expect(paints.map(paint => paint.kind)).toStrictEqual(['stroke', 'fill', 'fill', 'fill-stroke', 'fill-stroke', 'fill-stroke']);
  });

  it('paints an inline image without a colour space in none, and reports one that names no resource', () => {
    const { paints, result } = textRun('BI /W 1 /H 1 /BPC 8 ID \u0000 EI BI /W 1 /H 1 /BPC 8 /CS /Nope ID \u0000 EI');
    expect([paintSpaces(paints), result.warnings.map(warning => warning.code)]).toStrictEqual([
      ['inline-image:', 'inline-image:unknown'],
      ['resource-missing'],
    ]);
  });

  it.each([
    ['is not a stream', '<</Type/XObject/Subtype/Image>>', ['resource-missing']],
    ['has the Subtype PS', streamBody('/Type/XObject/Subtype/PS', 'x'), []],
    ['has no Subtype', streamBody('/Type/XObject', 'x'), []],
  ])('paints nothing for an XObject that %s', (_, body, codes) => {
    const { paints, result } = run({ content: '/X Do', resources: '/XObject<</X 120 0 R>>' }, [{ number: 120, body }]);
    expect([paints, result.warnings.map(warning => warning.code)]).toStrictEqual([[], codes]);
  });

  it('ignores a Q with no saved state to restore', () => {
    // ISO 32000-1:2008, 8.4.4, Table 57: Q restores "the most recently saved state", and here there is none.
    const { texts, result } = textRun('2 0 0 2 0 0 cm Q BT /F1 10 Tf (A) Tj ET');
    expect([texts.map(text => text.state.ctm), result.warnings]).toStrictEqual([[[2, 0, 0, 2, 0, 0]], []]);
  });

  it('reports a colour operand that is not a number, and SC drops a name operand', () => {
    // 8.6.8, Table 74: SC takes numbers only; SCN also takes a pattern name.
    const { paints, result } = textRun('(x) sc /DeviceRGB CS 1 0 0 /P SC 0 0 10 10 re S');
    expect([paints.map(paint => paint.colorSpaces[0]?.components), result.warnings.map(warning => warning.code)]).toStrictEqual([
      [[1, 0, 0]],
      ['bad-operands'],
    ]);
  });

  it('reports a graphics state parameter dictionary that is not a dictionary, or whose Font entry has no size', () => {
    const { texts, result } = textRun('BT /F1 10 Tf /Bad gs (A) Tj /NoSize gs (A) Tj ET', [], '/ExtGState<</Bad 5/NoSize<</Font[101 0 R]>>>>');
    expect([texts.map(text => text.state.fontSize), result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([
      [10, 10],
      false,
      ['resource-missing', 'bad-operands'],
    ]);
  });

  it('reads the streams of a Contents array with one operand stack', () => {
    const { texts, result } = run({ content: ['BT /F1 10', 'Tf (A) Tj ET'], resources: FONT_RESOURCES });
    expect([texts.length, result.complete, result.warnings]).toStrictEqual([1, true, []]);
  });

  it('takes resources inherited from the page tree', () => {
    const document = textPdf({ pages: [{ content: 'BT /F1 10 Tf (A) Tj ET' }], objects: FONTS, root: `/Resources<<${FONT_RESOURCES}>>` });
    const texts: Array<TextShowEvent> = [];
    interpretPage(document, 0, {
      text: event => {
        texts.push(event);
      },
    });
    expect(texts.map(text => text.font.key)).toStrictEqual(['101.0']);
  });
});

describe('text state', () => {
  it('advances by the glyph width and the character spacing', () => {
    // 9.4.4: tx = ((w0 − Tj/1000) × Tfs + Tc + Tw) × Th, so (0.667 × 10 + 2) × 1 = 8.67.
    expect(positions(textRun('BT /F1 10 Tf 2 Tc 100 200 Td (AA) Tj ET').texts)).toStrictEqual([
      [100, 200],
      [108.67, 200],
    ]);
  });

  it('applies word spacing to single-byte code 32 only', () => {
    // 9.3.3: word spacing applies to "the single-byte character code 32", never to the byte 32 in a two-byte code.
    expect(positions(textRun('BT /F1 10 Tf 5 Tw ( A) Tj ET').texts)).toStrictEqual([
      [0, 0],
      [7.78, 0],
    ]);
    expect(positions(textRun('BT /H 10 Tf 5 Tw <00200020> Tj ET').texts)).toStrictEqual([
      [0, 0],
      [5, 0],
    ]);
  });

  it('scales horizontal displacements and spacing but not vertical ones', () => {
    // Horizontal: ((0.667 × 10) + 1) × 0.5 = 3.835. Vertical, 9.3.4 leaves Tc unscaled: w1 = −1, so −1 × 10 + 1 = −9.
    expect(positions(textRun('BT /F1 10 Tf 50 Tz 1 Tc (AA) Tj ET').texts)).toStrictEqual([
      [0, 0],
      [3.835, 0],
    ]);
    expect(positions(textRun('BT /V 10 Tf 50 Tz 1 Tc <00200020> Tj ET').texts)).toStrictEqual([
      [0, 0],
      [0, -9],
    ]);
  });

  it('moves to the next line by the leading with T*, TD, quote and double quote', () => {
    // 9.4.2: T* is 0 −TL Td; TD sets TL to −ty; " sets Tw and Tc before it shows the string.
    const { texts } = textRun('BT /F1 10 Tf 12 TL 50 700 Td (A) Tj T* (A) Tj (A) \' 0 -20 TD (A) Tj 3 1 (A) " ET');
    expect(positions(texts)).toStrictEqual([
      [50, 700],
      [50, 688],
      [50, 676],
      [50, 656],
      [50, 636],
    ]);
    expect([texts.at(-1)?.state.wordSpacing, texts.at(-1)?.state.characterSpacing, texts.at(-1)?.state.leading]).toStrictEqual([3, 1, 20]);
  });

  it('keeps the rise, render mode and font size in the text state', () => {
    const { texts } = textRun('BT /F1 10 Tf 3 Ts 1 Tr 80 Tz (A) Tj ET');
    expect([texts[0]?.state.rise, texts[0]?.state.renderMode, texts[0]?.state.fontSize, texts[0]?.state.horizontalScaling]).toStrictEqual([3, 1, 10, 0.8]);
  });

  it('subtracts TJ numbers from the horizontal or the vertical coordinate', () => {
    // Table 109: a TJ number "shall be subtracted from the current horizontal or vertical coordinate, depending on the writing mode".
    expect(positions(textRun('BT /F1 10 Tf 50 Tz [(A) -500 (A)] TJ ET').texts)).toStrictEqual([
      [0, 0],
      [5.835, 0],
    ]);
    const vertical = textRun('BT /V 10 Tf [<0020> -500 <0020>] TJ ET');
    expect(positions(vertical.texts)).toStrictEqual([
      [0, 0],
      [0, -5],
    ]);
    expect(vertical.texts.map(text => text.adjustment)).toStrictEqual([undefined, -500]);
  });

  it('sets the font and size from a graphics state Font entry', () => {
    const { texts } = textRun('BT /GS1 gs (A) Tj ET', [], '/ExtGState<</GS1<</Font[101 0 R 20]>>>>');
    expect([texts[0]?.font.key, texts[0]?.state.fontSize]).toStrictEqual(['101.0', 20]);
  });

  it('paints text only in the render modes that fill or stroke', () => {
    const { paints, texts } = textRun('BT /F1 10 Tf 1 0 0 RG (A) Tj 1 Tr (A) Tj 2 Tr (A) Tj 3 Tr (A) Tj 7 Tr (A) Tj 4 Tr (A) Tj 5 Tr (A) Tj 6 Tr (A) Tj ET');
    // ISO 32000-1:2008, 9.3.6, Table 106: modes 4, 5 and 6 fill, stroke, and fill and stroke as 0, 1 and 2 do, and add to the clip.
    expect(paintSpaces(paints)).toStrictEqual([
      'text:DeviceGray',
      'text:DeviceRGB',
      'text:DeviceGray,DeviceRGB',
      'text:DeviceGray',
      'text:DeviceRGB',
      'text:DeviceGray,DeviceRGB',
    ]);
    expect(texts).toHaveLength(8);
  });

  it('loses the position after a glyph of unknown width until the next positioning operator', () => {
    const { texts } = textRun('BT /U 10 Tf (AA) Tj 10 10 Td (A) Tj ET', [{ number: 105, body: '<</Type/Font/Subtype/Type1/BaseFont/Unknown>>' }], '');
    expect(texts.flatMap(text => text.glyphs.map(glyph => glyph.positionKnown))).toStrictEqual([true, false, true]);
  });

  it('adds up the TJ numbers between two strings and moves the first string by the numbers before it', () => {
    const between = textRun('BT /F1 10 Tf [(A) -200 -300 (A)] TJ ET').texts;
    const before = textRun('BT /F1 10 Tf [-1000 (A)] TJ ET').texts;
    // 6.67 for the glyph and 500 thousandths of 10 for the numbers; 1000 thousandths of 10 before the first string.
    expect([positions(between), between.map(text => text.adjustment), positions(before), before.map(text => text.adjustment)]).toStrictEqual([
      [
        [0, 0],
        [11.67, 0],
      ],
      [undefined, -500],
      [[10, 0]],
      [-1000],
    ]);
  });

  it('reports a TJ element that is neither a string nor a number and shows the strings around it', () => {
    const { texts, result } = textRun('BT /F1 10 Tf [(A) /N ( )] TJ ET');
    // The second string starts 6.67 along, after the A, and the bad element adds no TJ number.
    expect([
      texts.map(text => latin1Text(text.string)),
      positions(texts),
      texts.map(text => text.adjustment),
      result.complete,
      result.warnings.map(warning => warning.code),
    ]).toStrictEqual([
      ['A', ' '],
      [
        [0, 0],
        [6.67, 0],
      ],
      [undefined, undefined],
      false,
      ['bad-operands'],
    ]);
  });

  // ISO 32000-1:2008, 9.3.6, Table 106: modes 4 to 7 add the glyphs to the path for clipping, which ET applies; without the glyph outlines the clip's shape is not known.
  it.each([
    [0, '(A)', 'inside'],
    [1, '(A)', 'inside'],
    [2, '(A)', 'inside'],
    [3, '(A)', 'inside'],
    [4, '(A)', 'unknown'],
    [5, '(A)', 'unknown'],
    [6, '(A)', 'unknown'],
    [7, '(A)', 'unknown'],
    [7, '()', 'inside'],
  ] as const)('after a text object in render mode %i showing %s, classifies the origin against the clip as %s', (mode, string, expected) => {
    const { texts } = textRun(`BT /F1 10 Tf ${String(mode)} Tr ${string} Tj ET BT 0 Tr (A) Tj ET`);
    expect([texts[0]?.state.clip.classifyPoint(0, 0), texts[1]?.state.clip.classifyPoint(0, 0)]).toStrictEqual(['inside', expected]);
  });

  it('stops past maxGlyphs glyphs shown on the page', () => {
    const page = { resources: FONT_RESOURCES };
    expect(run({ ...page, content: 'BT /F1 10 Tf (A) Tj (A) Tj ET' }, [], { maxGlyphs: 2 }).texts).toHaveLength(2);
    expect(() => run({ ...page, content: 'BT /F1 10 Tf (A) Tj (A) Tj (A) Tj ET' }, [], { maxGlyphs: 2 })).toThrow(ResourceLimitError);
  });

  it('refuses a maxGlyphs that is not a non-negative safe integer', () => {
    const document = textPdf({ pages: [{ content: '' }] });
    expect(() => interpretPage(document, 0, { maxGlyphs: -1 })).toThrow(InvalidArgumentError);
    expect(() => interpretPage(document, 0, { maxGlyphs: 1.5 })).toThrow(InvalidArgumentError);
    expect(interpretPage(document, 0, { maxGlyphs: 0 }).complete).toBe(true);
  });
});

// Fonts W1 and W2 share an embedded CMap of 2000 one-code ranges <0000> to <07CF>: the code FFFF matches none, so it costs 4000 checks, 2000 to read and 2000 to consume as invalid.
const WIDE_RANGES = Array.from({ length: 2000 }, (_, index) => `<${index.toString(16).padStart(4, '0')}>`.repeat(2));
const WIDE_CMAP = Array.from(
  { length: 20 },
  (_, block) => `100 begincodespacerange ${WIDE_RANGES.slice(block * 100, block * 100 + 100).join(' ')} endcodespacerange`,
).join('\n');
// The 4 codespace ranges of 90ms-RKSJ-H (ISO 32000-1:2008, 9.7.5.4, EXAMPLE): the code 8140 is compared with the two 1-byte ranges and then with <8140> <9FFC>, so it costs 3 checks.
const SHIFT_JIS_CMAP = '4 begincodespacerange <00> <80> <8140> <9FFC> <A0> <DF> <E040> <FCFC> endcodespacerange';
const sharing = (cmap: string): Array<TestObject> => [
  CID_FONT,
  { number: 120, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding 122 0 R/DescendantFonts[104 0 R]>>' },
  { number: 121, body: '<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding 122 0 R/DescendantFonts[104 0 R]>>' },
  { number: 122, body: streamBody('/Type/CMap/CMapName/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>', cmap) },
];
const SHARING_RESOURCES = '/Font<</W1 120 0 R/W2 121 0 R>>';
// A string of codes FFFF, each a miss in the shared CMap of 2000 ranges.
const misses = (count: number): string => `<${'FFFF'.repeat(count)}>`;

describe('codespace checks', () => {
  it('counts the checks of every string a page shows against one limit, so many short strings end in ResourceLimitError', () => {
    // One TJ operation shows 1300 strings of two misses, 8000 checks each: the first 1250 take the count to its limit of 10,000,000, and the next check passes it.
    const content = `BT /W1 1 Tf [${'<FFFFFFFF> '.repeat(650)}] TJ /W2 1 Tf [${'<FFFFFFFF> '.repeat(650)}] TJ ET`;
    const document = textPdf({ pages: [{ content, resources: SHARING_RESOURCES }], objects: sharing(WIDE_CMAP) });
    const shown: Array<number> = [];
    let thrown: unknown;
    try {
      interpretPage(document, 0, {
        text: event => {
          shown.push(event.glyphs.length);
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceLimitError);
    expect(thrown).toMatchObject({ code: 'resource-limit' });
    expect(shown).toStrictEqual(Array.from({ length: 1250 }, () => 2));
  });

  it('counts the checks of a form, a tiling pattern cell and an annotation appearance against the limit of the page that draws them', () => {
    // 625 misses in each of the page, the form and the pattern cell take 7,500,000 checks; the annotation appearance's 626th miss passes 10,000,000 and none of the four streams does alone.
    const nested = `/Resources<<${SHARING_RESOURCES}>>`;
    const objects = [
      ...sharing(WIDE_CMAP),
      form(140, `/BBox[0 0 10 10]${nested}`, `BT /W2 1 Tf ${misses(625)} Tj ET`),
      { number: 141, body: streamBody(`/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5${nested}`, `BT /W1 1 Tf ${misses(625)} Tj ET`) },
      annotation(142, '/F 4/AP<</N 143 0 R>>'),
      form(143, `/BBox[0 0 10 5]${nested}`, `BT /W2 1 Tf ${misses(626)} Tj ET`),
    ];
    const content = `BT /W1 1 Tf ${misses(625)} Tj ET /X1 Do /Pattern cs /P1 scn 0 0 5 5 re f`;
    const resources = `${SHARING_RESOURCES}/XObject<</X1 140 0 R>>/Pattern<</P1 141 0 R>>`;
    const document = textPdf({ pages: [{ content, resources, entries: '/Annots[142 0 R]' }], objects });
    const shown: Array<number> = [];
    let thrown: unknown;
    try {
      interpretPage(document, 0, {
        annotations: 'all',
        text: event => {
          shown.push(event.glyphs.length);
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceLimitError);
    expect(thrown).toMatchObject({ code: 'resource-limit' });
    expect(shown).toStrictEqual([625, 625, 625]);
  });

  it('counts each page apart, so pages of a document sharing one font cache and one CMap each have the whole limit', () => {
    // Each page shows 1500 misses, 6,000,000 checks: the two pages together pass the limit of 10,000,000 and each alone does not.
    const page = { content: `BT /W1 1 Tf <${'FFFF'.repeat(750)}> Tj /W2 1 Tf <${'FFFF'.repeat(750)}> Tj ET`, resources: SHARING_RESOURCES };
    const document = textPdf({ pages: [page, page], objects: sharing(WIDE_CMAP) });
    const fonts = new FontCache(document, undefined);
    const shown = [0, 1].map(index => {
      const glyphs: Array<number> = [];
      interpretPage(document, index, {
        fonts,
        text: event => {
          glyphs.push(event.glyphs.length);
        },
      });
      return glyphs;
    });
    expect(shown).toStrictEqual([
      [750, 750],
      [750, 750],
    ]);
  });

  it('shows 999,000 codes of two fonts that share a CMap of the 90ms-RKSJ-H ranges on one page', () => {
    // 999,000 codes 8140 cost 2,997,000 checks, within the limit and within the default maxGlyphs of 1,000,000.
    const string = `<${'8140'.repeat(166_500)}>`;
    const content = `BT /W1 1 Tf ${string} Tj ${string} Tj ${string} Tj /W2 1 Tf ${string} Tj ${string} Tj ${string} Tj ET`;
    const document = textPdf({ pages: [{ content, resources: SHARING_RESOURCES }], objects: sharing(SHIFT_JIS_CMAP) });
    const shown: Array<number> = [];
    interpretPage(document, 0, {
      text: event => {
        shown.push(event.glyphs.length);
      },
    });
    expect(shown).toStrictEqual(Array.from({ length: 6 }, () => 166_500));
  });
});

describe('clipping', () => {
  it('intersects the clip with a path after the operator that paints it, in page space, until Q', () => {
    const { texts, paints } = textRun('q 2 0 0 2 0 0 cm 0 0 50 50 re W f BT /F1 10 Tf (A) Tj ET Q BT /F1 10 Tf (A) Tj ET');
    const clipped = texts[0]?.state.clip;
    // ISO 32000-1:2008, 8.5.4: the clip changes "After the path has been painted", so the fill itself is not clipped by its own path.
    expect([
      clipped?.classifyPoint(90, 90),
      clipped?.classifyPoint(110, 90),
      texts[1]?.state.clip.vertices,
      paints.map(paint => paint.kind),
      paints[0]?.state.clip.classifyPoint(110, 90),
    ]).toStrictEqual(['inside', 'outside', 0, ['fill', 'text', 'text'], 'inside']);
  });

  it('builds a path under the CTM in force when its first segment is added, whatever operators came before', () => {
    const { covers, texts } = textRun('1 w 2 0 0 2 0 0 cm 0 0 100 100 re f 0.5 w 1 0 0 1 100 100 cm 0 0 50 50 re W n BT /F1 10 Tf (A) Tj ET');
    expect([covers.map(cover => cover.rectangle), texts[0]?.state.clip.classifyPoint(250, 250)]).toStrictEqual([[[0, 0, 200, 200]], 'inside']);
  });

  it('keeps the CTM a path was started under when cm appears inside the path object', () => {
    // 8.2 and Annex L, Figure 9 do not allow cm inside a path object; the triangle is built under the identity in force at its m.
    const { texts } = textRun('0 0 m 2 0 0 2 0 0 cm 50 0 l 50 50 l h W n BT /F1 10 Tf (A) Tj ET');
    expect([texts[0]?.state.clip.classifyPoint(40, 10), texts[0]?.state.clip.classifyPoint(90, 10)]).toStrictEqual(['inside', 'outside']);
  });

  it('builds clips from curves and applies the even-odd rule of W*', () => {
    const { texts } = textRun(
      '0 50 m 0 77.6 22.4 100 50 100 c 77.6 100 100 77.6 100 50 c 100 22.4 77.6 0 50 0 c 22.4 0 0 22.4 0 50 c h W n BT /F1 10 Tf (A) Tj ET 0 0 m 100 0 l 100 100 l 0 100 l h 25 25 m 75 25 l 75 75 l 25 75 l h W* n BT /F1 10 Tf (A) Tj ET',
    );
    // The circle of radius 50 about (50, 50) excludes (5, 5), inside its bounding square; the even-odd square then cuts out its middle.
    expect([texts[0]?.state.clip.classifyPoint(5, 5), texts[0]?.state.clip.classifyPoint(20, 50), texts[1]?.state.clip.classifyPoint(50, 50)]).toStrictEqual([
      'outside',
      'inside',
      'outside',
    ]);
  });

  it('builds curves whose omitted control point is the current point or the end point', () => {
    // v takes the current point as its first control point and y the end point as its second (8.5.2.2, Table 59); both bulge out to the right here.
    const { texts } = textRun('0 0 m 100 50 0 100 v h W n BT /F1 10 Tf (A) Tj ET 0 0 m 100 50 0 100 y h W n BT /F1 10 Tf (A) Tj ET');
    expect([texts[0]?.state.clip.classifyPoint(30, 50), texts[1]?.state.clip.classifyPoint(30, 50), texts[1]?.state.clip.classifyPoint(60, 50)]).toStrictEqual([
      'inside',
      'inside',
      'outside',
    ]);
  });
});

describe('transparency', () => {
  const STATES =
    '/ExtGState<</Half<</ca 0.5/CA 0.25>>/Multiply<</BM/Multiply>>/Listed<</BM[/NoSuchMode/Normal]>>/Screened<</BM[/NoSuchMode/Screen]>>/Masked<</SMask<</S/Luminosity/G 110 0 R>>>>/Unmasked<</SMask/None>>>>';
  const GROUP: TestObject = {
    number: 110,
    body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceGray>>', '0 g 0 0 10 10 re f'),
  };

  it('keeps the alpha constants, blend mode and soft mask of graphics state parameter dictionaries', () => {
    const { texts } = textRun('BT /F1 10 Tf /Half gs /Multiply gs /Masked gs (A) Tj /Unmasked gs /Listed gs (A) Tj /Screened gs (A) Tj ET', [GROUP], STATES);
    const [first, second, third] = texts.map(text => text.state);
    // ISO 32000-1:2008, 11.6.3: from an array a reader "shall use the first blend mode in the array that it recognizes".
    expect([
      first?.fillAlpha,
      first?.strokeAlpha,
      first?.blendMode,
      first?.softMask?.subtype,
      first?.softMask?.group,
      second?.softMask,
      second?.blendMode,
      third?.blendMode,
    ]).toStrictEqual([0.5, 0.25, 'Multiply', 'Luminosity', { kind: 'reference', objectNumber: 110, generation: 0 }, undefined, 'Normal', 'Screen']);
  });

  it('reads Compatible as Normal, a blend mode array with no recognised name as Normal, and keeps the blend mode when BM is absent', () => {
    const resources = `${STATES.slice(0, -2)}/Compat<</BM/Compatible>>/Unlisted<</BM[/NoSuchMode]>>>>`;
    const { texts } = textRun(
      'BT /F1 10 Tf /Multiply gs /Compat gs (A) Tj /Multiply gs /Unlisted gs (A) Tj /Multiply gs /Half gs (A) Tj ET',
      [GROUP],
      resources,
    );
    // ISO 32000-1:2008, 11.7.4.2: "The Compatible blend mode shall be treated as equivalent to Normal"; 11.6.3 falls back to Normal when no name in the array is recognised.
    expect(texts.map(text => text.state.blendMode)).toStrictEqual(['Normal', 'Normal', 'Multiply']);
  });

  it('composites a group inside a group with the product of their alphas and the outer blend mode', () => {
    const { paints } = run({ content: '/Half gs /Multiply gs /Outer Do', resources: `${STATES}/XObject<</Outer 120 0 R>>` }, [
      GROUP,
      form(
        120,
        '/BBox[0 0 100 100]/Group<</S/Transparency>>/Resources<</ExtGState<</Half<</ca 0.5>>/Scr<</BM/Screen>>>>/XObject<</Inner 121 0 R>>>>',
        '/Half gs /Scr gs /Inner Do',
      ),
      form(121, '/BBox[0 0 100 100]/Group<</S/Transparency>>', '0 0 1 1 re f'),
    ]);
    expect(paints.map(paint => [paint.state.fillAlpha, paint.state.blendMode, paint.state.group])).toStrictEqual([
      [1, 'Normal', { alpha: 0.25, blendMode: 'Multiply', softMasked: false }],
    ]);
  });

  it('reports opaque fills of axis-aligned rectangles in page space', () => {
    const { covers } = textRun('1 g 10 20 30 40 re f q 0 1 -1 0 100 0 cm 0 0 10 20 re f Q 0 0 10 10 re B');
    // The quarter turn maps the rectangle 0…10 by 0…20 onto 80…100 by 0…10.
    expect(covers.map(cover => cover.rectangle)).toStrictEqual([
      [10, 20, 40, 60],
      [80, 0, 100, 10],
      [0, 0, 10, 10],
    ]);
  });

  it('reports each rectangle of a fill of rectangles that do not overlap', () => {
    const { covers } = textRun('1 g 0 0 5 5 re 5 5 5 5 re f 20 0 5 5 re 20 0 5 5 re f');
    // Rectangles that touch do not overlap; a rectangle drawn twice does.
    expect(covers.map(cover => cover.rectangle)).toStrictEqual([
      [0, 0, 5, 5],
      [5, 5, 10, 10],
    ]);
  });

  it('reports the rectangles of a fill of 64 and none of a fill of 65', () => {
    expect([textRun(`${rectangles(64)} f`).covers.map(cover => cover.rectangle), textRun(`${rectangles(65)} f`).covers]).toStrictEqual([
      Array.from({ length: 64 }, (_, index) => [index * 10, 0, index * 10 + 5, 5]),
      [],
    ]);
  });

  it.each([
    ['wholly outside its clip', 'q 0 0 5 5 re W n 20 20 5 5 re f Q'],
    ['under a clip whose shape is not known', 'q BT /F1 10 Tf 7 Tr (A) Tj ET 20 20 5 5 re f Q'],
    ['in the cell of a coloured tiling pattern', 'q /Pattern cs /Cell scn 20 20 5 5 re f Q'],
    ['in the procedure of a Type 3 glyph', 'BT /T3 10 Tf (a) Tj ET'],
  ])('does not report a fill %s', (_, content) => {
    const { covers } = run({ content: `${content} 0 0 10 10 re f`, resources: '/Font<</F1 101 0 R/T3 130 0 R>>/Pattern<</Cell 112 0 R>>' }, [
      { number: 112, body: streamBody('/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5/Resources<<>>', '0 0 5 5 re f') },
      {
        number: 130,
        body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 131 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]>>',
      },
      { number: 131, body: streamBody('', '1000 0 d0 0 0 500 500 re f') },
    ]);
    // Only the fill that follows, of 0…10 on the page, covers.
    expect(covers.map(cover => cover.rectangle)).toStrictEqual([[0, 0, 10, 10]]);
  });

  it('resets transparency inside a transparency group and records how the group is composited', () => {
    const { covers, paints } = run(
      {
        content: 'q /Half gs /Multiply gs /Group Do /Plain Do Q',
        resources: `${STATES.slice(0, -2)}/Opaque<</ca 1/BM/Normal>>>>/XObject<</Group 120 0 R/Plain 121 0 R>>`,
      },
      [
        GROUP,
        form(120, '/BBox[0 0 100 100]/Group<</S/Transparency>>/Resources<</ExtGState<</Opaque<</ca 1>>>>>>', '0 0 100 100 re f /Opaque gs 0 0 100 100 re f'),
        form(121, '/BBox[0 0 100 100]', '0 0 10 10 re f'),
      ],
    );
    // ISO 32000-1:2008, 8.4.1, Table 52: the blend mode, soft mask and alpha constants are reset "at the beginning of execution of a transparency group XObject", and the group as a whole is composited with the values outside it.
    expect(paints.map(paint => [paint.state.fillAlpha, paint.state.blendMode, paint.state.group])).toStrictEqual([
      [1, 'Normal', { alpha: 0.5, blendMode: 'Multiply', softMasked: false }],
      [1, 'Normal', { alpha: 0.5, blendMode: 'Multiply', softMasked: false }],
      [0.5, 'Multiply', { alpha: 1, blendMode: 'Normal', softMasked: false }],
    ]);
    expect(covers).toStrictEqual([]);
  });

  it('does not report fills in spaces whose colorants are all None', () => {
    const { covers } = run(
      {
        content: 'q /AllNone cs 1 1 sc 0 0 10 10 re f Q q /IndexedNone cs 1 sc 0 0 10 10 re f Q q /SomeNone cs 1 1 sc 10 10 10 10 re f Q 0 0 10 10 re f',
        resources:
          '/ColorSpace<</AllNone[/DeviceN[/None/None]/DeviceGray 111 0 R]/IndexedNone[/Indexed[/Separation/None/DeviceGray 111 0 R]1<00FF>]/SomeNone[/DeviceN[/None/Cyan]/DeviceCMYK 111 0 R]>>',
      },
      [{ number: 111, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' }],
    );
    // 8.6.6.5: a DeviceN component named None "shall never be painted", and the others are; an Indexed space paints in its base space (8.6.6.3).
    expect(covers.map(cover => cover.rectangle)).toStrictEqual([
      [10, 10, 20, 20],
      [0, 0, 10, 10],
    ]);
  });

  it('does not report fills that could let what is below show through or that are not rectangles', () => {
    const { covers } = run(
      {
        content: [
          'q /Half gs 0 0 10 10 re f Q',
          'q /Masked gs 0 0 10 10 re f Q',
          'q /Multiply gs 0 0 10 10 re f Q',
          'q /P0 cs /Pat scn 0 0 10 10 re f Q',
          'q /None cs 1 sc 0 0 10 10 re f Q',
          'q 1 1 -1 1 0 0 cm 0 0 10 10 re f Q',
          '0 0 m 10 0 l 0 10 l f 0 0 5 5 re 4 4 5 5 re f 0 0 10 10 re S',
          'q 0 0 5 5 re W n 0 0 10 10 re f Q',
          'q /Listed gs 0 0 50 50 re W n 0 0 10 10 re f Q',
        ],
        resources: `${STATES}/ColorSpace<</P0/Pattern/None[/Separation/None/DeviceGray 111 0 R]>>/Pattern<</Pat 112 0 R>>`,
      },
      [
        GROUP,
        { number: 111, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' },
        { number: 112, body: streamBody('/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5/Resources<<>>', '0 0 5 5 re f') },
      ],
    );
    // Only the fills under clips cover, each with its clip: the part a clip cuts away paints nothing.
    expect(covers.map(cover => [cover.rectangle, cover.clip.classifyPoint(7, 7)])).toStrictEqual([
      [[0, 0, 10, 10], 'outside'],
      [[0, 0, 10, 10], 'inside'],
    ]);
  });
});

describe('marked content', () => {
  it('allows 64 nested graphics states and marked-content sequences', () => {
    expect([textRun('q '.repeat(64)).result.warnings, textRun('/Span BMC '.repeat(64)).result.warnings.map(warning => warning.code)]).toStrictEqual([
      [],
      ['marked-content-unbalanced'],
    ]);
  });

  it('limits graphics and marked-content nesting', () => {
    expect(() => textRun('q '.repeat(65))).toThrow(ResourceLimitError);
    expect(() => textRun('/Span BMC '.repeat(65))).toThrow(ResourceLimitError);
  });

  it('attaches inline and named property lists to what is shown inside a sequence', () => {
    const { texts, result } = run({
      content: '/P <</MCID 3>> BDC BT /F1 10 Tf (A) Tj /Span /MC0 BDC (A) Tj EMC ET EMC /Artifact BMC BT /F1 10 Tf (A) Tj ET EMC',
      resources: `${FONT_RESOURCES}/Properties<</MC0<</ActualText(x)>>>>`,
    });
    const tags = texts.map(text => text.markedContent.map(sequence => latin1Text(sequence.tag)));
    expect(tags).toStrictEqual([['P'], ['P', 'Span'], ['Artifact']]);
    const nested = texts.at(1)?.markedContent;
    expect([
      nested?.[0]?.properties?.get(new TextEncoder().encode('MCID')),
      nested?.[1]?.properties?.get(new TextEncoder().encode('ActualText'))?.kind,
    ]).toStrictEqual([{ kind: 'integer', value: 3 }, 'string']);
    expect([texts[0]?.markedContent[0]?.id === nested?.[0]?.id, texts[2]?.markedContent[0]?.properties, result.warnings]).toStrictEqual([true, undefined, []]);
  });

  it('keeps sequences apart from the graphics state stack', () => {
    // 14.6: marked-content and text object pairs must each nest properly, which a sequence opened before q and closed after Q does.
    const { texts } = textRun('q /Span <</ActualText(x)>> BDC Q BT /F1 10 Tf (A) Tj ET EMC');
    expect(texts.map(text => text.markedContent.length)).toStrictEqual([1]);
  });

  it('reports sequences that do not balance', () => {
    const { result } = textRun('EMC /Span BMC');
    expect([result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([true, ['marked-content-unbalanced', 'marked-content-unbalanced']]);
  });

  it('reports a property list name the resources do not define', () => {
    const { texts, result } = textRun('/Span /Nope BDC BT /F1 10 Tf (A) Tj ET EMC');
    expect([texts[0]?.markedContent.length, result.warnings.map(warning => warning.code)]).toStrictEqual([1, ['resource-missing']]);
  });
});

const internalsWith = (bytes: Uint8Array, maxNesting: number): DocumentInternals => {
  const parts = internalsOf(loadDocument(bytes, { maxNesting }));
  if (parts === undefined) {
    throw new Error('the document has no internals');
  }
  return parts;
};

// A page that draws `count` forms, each drawing the next, and the last one empty.
const formChain = (count: number): Uint8Array => {
  const chain = Array.from({ length: count }, (_, index) =>
    form(110 + index, `/BBox[0 0 1 1]/Resources<</XObject<</Next ${String(111 + index)} 0 R>>>>`, index === count - 1 ? '' : '/Next Do'),
  );
  return textPdfBytes({ pages: [{ content: '/Next Do', resources: '/XObject<</Next 110 0 R>>' }], objects: chain });
};

const sourceKinds = (events: ReadonlyArray<{ readonly context: { readonly sources: ReadonlyArray<{ readonly kind: string }> } }>): Array<string> =>
  events.map(event => event.context.sources.map(source => source.kind).join('/'));

describe('forms', () => {
  it('draws a form under its Matrix, clipped to its BBox, with its own resources', () => {
    const { texts } = run({ content: 'q 1 0 0 1 100 100 cm /Fm1 Do Q', resources: '/XObject<</Fm1 110 0 R>>' }, [
      form(110, `/BBox[0 0 50 50]/Matrix[2 0 0 2 0 0]/Resources<<${FONT_RESOURCES}>>`, 'BT /F1 10 Tf 5 5 Td (A) Tj ET'),
    ]);
    // ISO 32000-1:2008, 8.10.1: Do concatenates the form's Matrix with the CTM and clips to the BBox, here 100…200 in page space.
    const [text] = texts;
    expect([text?.state.ctm, text?.state.clip.classifyPoint(150, 150), text?.state.clip.classifyPoint(250, 150), text?.context.sources]).toStrictEqual([
      [2, 0, 0, 2, 100, 100],
      'inside',
      'outside',
      [{ kind: 'page' }, { kind: 'form', reference: { kind: 'reference', objectNumber: 110, generation: 0 } }],
    ]);
  });

  it('takes the page resources for a form without Resources and restores the state afterwards', () => {
    const { texts, result } = run({ content: '/Fm1 Do BT /F1 10 Tf (A) Tj ET', resources: `${FONT_RESOURCES}/XObject<</Fm1 110 0 R>>` }, [
      form(110, '/BBox[0 0 50 50]', '2 0 0 2 0 0 cm q BT /F1 10 Tf (A) Tj ET'),
    ]);
    expect([texts.map(text => text.state.ctm), result.warnings]).toStrictEqual([
      [
        [2, 0, 0, 2, 0, 0],
        [1, 0, 0, 1, 0, 0],
      ],
      [],
    ]);
  });

  it('keeps marked content open across a form and refuses to close it from inside', () => {
    const { texts, result } = run({ content: '/P <</MCID 0>> BDC /Fm1 Do EMC', resources: `${FONT_RESOURCES}/XObject<</Fm1 110 0 R>>` }, [
      form(110, '/BBox[0 0 50 50]', 'EMC BT /F1 10 Tf (A) Tj ET /Span BMC'),
    ]);
    expect([texts.map(text => text.markedContent.length), result.warnings.map(warning => warning.code)]).toStrictEqual([
      [1],
      ['marked-content-unbalanced', 'marked-content-unbalanced'],
    ]);
  });

  it('does not enter a form already being drawn', () => {
    const { result } = run({ content: '/Fm1 Do', resources: '/XObject<</Fm1 110 0 R>>' }, [
      form(110, '/BBox[0 0 50 50]/Resources<</XObject<</Fm2 111 0 R>>>>', '/Fm2 Do'),
      form(111, '/BBox[0 0 50 50]/Resources<</XObject<</Fm1 110 0 R>>>>', '/Fm1 Do'),
    ]);
    expect([result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([false, ['content-cycle']]);
  });

  it('counts the operations of a form each time it is drawn and stops at maxOperations', () => {
    const page = { content: '/Fm1 Do /Fm1 Do', resources: '/XObject<</Fm1 110 0 R>>' };
    const objects = [form(110, '/BBox[0 0 50 50]', '0 g 0 0 1 1 re f')];
    expect([run(page, objects).result.operations, run(page, objects, { maxOperations: 8 }).result.complete]).toStrictEqual([8, true]);
    expect(() => run(page, objects, { maxOperations: 7 })).toThrow(ResourceLimitError);
  });

  it('counts the content bytes of a form each time it is drawn and stops at maxContentBytes', () => {
    // About 1 MB of comment, which produces no operations for maxOperations to count: the page's 40 bytes and five times the form's 1,000,005 make 5,000,065.
    const page = { content: '/Fm1 Do\n'.repeat(5), resources: '/XObject<</Fm1 110 0 R>>' };
    const objects = [form(110, '/BBox[0 0 50 50]', `%${'x'.repeat(1_000_000)}\n0 g`)];
    expect([run(page, objects).result.operations, run(page, objects, { maxContentBytes: 5_000_065 }).result.complete]).toStrictEqual([10, true]);
    expect(() => run(page, objects, { maxContentBytes: 5_000_064 })).toThrow(ResourceLimitError);
  });

  it('stops at forms nested deeper than maxNesting', () => {
    // The page draws 7 forms, each inside the one before.
    const bytes = formChain(7);
    expect(() => interpretPage(internalsWith(bytes, 6), 0)).toThrow(ResourceLimitError);
    expect(interpretPage(internalsWith(bytes, 7), 0).warnings).toStrictEqual([]);
  });

  it('limits recursive content execution to 64 streams when maxNesting is raised', () => {
    expect(interpretPage(internalsWith(formChain(64), 200), 0).warnings).toStrictEqual([]);
    expect(() => interpretPage(internalsWith(formChain(65), 200), 0)).toThrow(ResourceLimitError);
  });
});

describe('patterns', () => {
  const PATTERNS = '/ColorSpace<</RGBPattern[/Pattern/DeviceRGB]>>/Pattern<</Coloured 110 0 R/Uncoloured 111 0 R/Shaded 112 0 R>>';
  const OBJECTS: ReadonlyArray<TestObject> = [
    {
      number: 110,
      body: streamBody(
        `/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5/Matrix[1 0 0 1 10 10]/Resources<<${FONT_RESOURCES}>>`,
        '1 0 0 rg 0 0 5 5 re f BT /F1 1 Tf (A) Tj ET',
      ),
    },
    { number: 111, body: streamBody('/PatternType 1/PaintType 2/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5/Resources<<>>', '0 0 1 rg 0 0 5 5 re f') },
    { number: 112, body: '<</PatternType 2/Shading<</ShadingType 2/ColorSpace/DeviceCMYK/Coords[0 0 1 0]/Function 113 0 R>>>>' },
    { number: 113, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[1 1 1 1]/N 1>>' },
  ];

  it('paints a coloured tiling pattern cell in pattern space, whatever the CTM at the paint', () => {
    const { paints, texts } = run({ content: '2 0 0 2 0 0 cm /Pattern cs /Coloured scn 0 0 10 10 re f', resources: PATTERNS }, OBJECTS);
    // 8.7.2: the pattern matrix maps to "the default coordinate system of the pattern’s parent content stream", the page's here.
    expect([paintSpaces(paints), sourceKinds(paints), texts.map(text => text.state.ctm)]).toStrictEqual([
      ['fill:Pattern', 'fill:DeviceRGB', 'text:DeviceRGB'],
      ['page', 'page/tiling-pattern', 'page/tiling-pattern'],
      [[1, 0, 0, 1, 10, 10]],
    ]);
  });

  it('paints an uncoloured tiling pattern in the base space, ignoring the colour operators of its cell', () => {
    const { paints, selects } = run({ content: '/RGBPattern cs 0 1 0 /Uncoloured scn 0 0 10 10 re f', resources: PATTERNS }, OBJECTS);
    expect([paintSpaces(paints), paints.map(paint => paint.colorSpaces.at(-1)?.components), paints.map(paint => paint.context.colour)]).toStrictEqual([
      ['fill:Pattern,DeviceRGB', 'fill:DeviceRGB'],
      [
        [0, 1, 0],
        [0, 1, 0],
      ],
      ['used', 'uncoloured-pattern'],
    ]);
    expect(selects.map(select => select.context.colour)).toStrictEqual(['used', 'uncoloured-pattern']);
  });

  it("starts a coloured cell from the state at the beginning of the pattern's parent content stream and applies its colours, wherever the pattern paints", () => {
    const plain = streamBody('/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5/Resources<<>>', '0 0 5 5 re f');
    const glyphFont =
      '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 121 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]>>';
    const objects: Array<TestObject> = [
      { number: 115, body: plain },
      form(116, '/BBox[0 0 10 10]', '0 0 10 10 re f'),
      { number: 120, body: glyphFont },
      { number: 121, body: streamBody('', '1000 0 0 0 750 750 d1 0 0 750 750 re f') },
    ];
    const resources = '/Pattern<</Plain 115 0 R>>/XObject<</Fm 116 0 R>>/Font<</T3 120 0 R>>';
    const { paints, result } = run({ content: '/Pattern cs /Plain scn /Fm Do BT /T3 10 Tf (a) Tj ET', resources }, objects);
    // The form's fill, the text and the d1 glyph's fill each paint the cell. 8.7.3.1: the cell is painted after the reader "Installs the graphics state that was in effect at the beginning of the pattern’s parent content stream", the page's, whose fill colour is DeviceGray.
    const cells = paints.filter(paint => paint.context.sources.at(-1)?.kind === 'tiling-pattern');
    expect([result.warnings, cells.map(paint => `${paintSpaces([paint]).join(',')} ${paint.context.colour}`)]).toStrictEqual([
      [],
      ['fill:DeviceGray used', 'fill:DeviceGray used', 'fill:DeviceGray used'],
    ]);
  });

  it("says which of the operation's own spaces each space a pattern paints in comes from", () => {
    const { paints } = run(
      { content: '/Pattern cs /Shaded scn /RGBPattern CS 0 1 0 /Uncoloured SCN 0 0 10 10 re B 0 0 10 10 re f', resources: PATTERNS },
      OBJECTS,
    );
    expect(paints.map(paint => [paintSpaces([paint]).join(','), paint.spaceOf])).toStrictEqual([
      ['fill-stroke:Pattern,Pattern,DeviceCMYK,DeviceRGB', [0, 1, 0, 1]],
      ['fill:DeviceRGB', [0]],
      ['fill:Pattern,DeviceCMYK', [0, 0]],
    ]);
  });

  it('paints image masks in a pattern colour', () => {
    const { paints } = run({ content: '/Pattern cs /Shaded scn /Im Do BI /W 1 /H 1 /IM true ID \u0000 EI', resources: `${PATTERNS}/XObject<</Im 114 0 R>>` }, [
      ...OBJECTS,
      { number: 114, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/ImageMask true', '\u0000') },
    ]);
    // 8.9.5, Table 89, ImageMask: "unmasked areas shall be painted using the current nonstroking colour", which may be a pattern.
    expect(paintSpaces(paints)).toStrictEqual(['image-mask:Pattern,DeviceCMYK', 'inline-image-mask:Pattern,DeviceCMYK']);
  });
});

describe('glyph procedures of Type 3 fonts', () => {
  const TYPE3_FONT =
    '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 111 0 R/b 112 0 R>>/Encoding<</Differences[97/a/b]>>/FirstChar 97/LastChar 98/Widths[1000 1000]>>';
  const TYPE3: ReadonlyArray<TestObject> = [
    {
      number: 110,
      body: TYPE3_FONT,
    },
    { number: 111, body: streamBody('', '1000 0 d0 1 0 0 rg 0 0 500 500 re f') },
    { number: 112, body: streamBody('', '1000 0 0 0 750 750 d1 /CS1 cs 0 0 750 750 re f BT /F1 10 Tf (A) Tj ET') },
  ];

  it('draws each glyph under the font matrix and the text space, with d1 glyphs in the text colour', () => {
    const { paints, selects, texts } = run(
      { content: 'BT /T3 10 Tf 1 1 0 rg (ab) Tj ET', resources: `/Font<</T3 110 0 R/F1 101 0 R>>/ColorSpace<</CS1/DeviceCMYK>>` },
      TYPE3,
    );
    // 9.6.5: the glyph's CTM is "the concatenation of the font matrix … and the text space that was in effect at the time the text-showing operator was invoked".
    expect(paints.map(paint => [paint.kind, paint.context.colour, paint.state.ctm, paint.colorSpaces[0]?.components])).toStrictEqual([
      ['text', 'used', [1, 0, 0, 1, 0, 0], [1, 1, 0]],
      ['fill', 'used', [0.01, 0, 0, 0.01, 0, 0], [1, 0, 0]],
      ['fill', 'd1-glyph', [0.01, 0, 0, 0.01, 10, 0], [1, 1, 0]],
      ['text', 'd1-glyph', [0.01, 0, 0, 0.01, 10, 0], [1, 1, 0]],
    ]);
    // A glyph procedure's own text is not text of the page, and its resources fall back to the page's (Table 112, Resources).
    expect([texts.length, sourceKinds(selects), selects.map(select => select.context.colour)]).toStrictEqual([
      1,
      ['page', 'page/type3-glyph', 'page/type3-glyph'],
      ['used', 'used', 'd1-glyph'],
    ]);
  });

  it('names a direct font in the resources of a Type 3 font after the Type 3 font', () => {
    const DIRECT = '/Resources<</Font<</F9<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>';
    const { paints } = run({ content: 'BT /T3 10 Tf (ab) Tj ET', resources: '/Font<</T3 110 0 R>>' }, [
      {
        number: 110,
        body: `<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 111 0 R/b 112 0 R>>/Encoding<</Differences[97/a/b]>>/FirstChar 97/LastChar 98/Widths[1000 1000]${DIRECT}>>`,
      },
      { number: 111, body: streamBody('', '1000 0 d0 BT /F9 1 Tf (A) Tj ET') },
      { number: 112, body: streamBody('', '1000 0 d0 BT /F9 1 Tf (A) Tj ET') },
    ]);
    // The font model's key names a direct font by the nearest indirect object holding its resource dictionary, here the Type 3 font 110.
    expect(paints.slice(1).map(paint => paint.state.font?.key)).toStrictEqual(['direct:110.0:4639', 'direct:110.0:4639']);
  });

  it('reports a pattern chosen in a d1 glyph procedure, whose colour operators are ignored', () => {
    const { selects, paints } = run({ content: 'BT /T3 10 Tf (b) Tj ET', resources: '/Font<</T3 110 0 R>>/Pattern<</Shaded 120 0 R>>' }, [
      { number: 110, body: TYPE3_FONT.replace('/b 112 0 R', '/b 113 0 R') },
      { number: 113, body: streamBody('', '1000 0 0 0 750 750 d1 /Pattern cs /Shaded scn 0 0 750 750 re f') },
      { number: 120, body: '<</PatternType 2/Shading<</ShadingType 2/ColorSpace/DeviceCMYK/Coords[0 0 1 0]/Function 121 0 R>>>>' },
      { number: 121, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[1 1 1 1]/N 1>>' },
    ]);
    const ignored = selects.filter(select => select.context.colour === 'd1-glyph');
    expect([
      ignored.map(select => spaceName(select.use)),
      ignored.map(select => select.use.pattern?.reference?.objectNumber),
      paintSpaces(paints),
    ]).toStrictEqual([
      ['Pattern', 'Pattern'],
      [undefined, 120],
      ['text:DeviceGray', 'fill:DeviceGray'],
    ]);
  });

  it('draws no glyph procedures for text that paints nothing', () => {
    const { paints } = run({ content: 'BT /T3 10 Tf 3 Tr (ab) Tj ET', resources: `/Font<</T3 110 0 R/F1 101 0 R>>/ColorSpace<</CS1/DeviceCMYK>>` }, TYPE3);
    expect(paints).toStrictEqual([]);
  });

  it('draws a glyph procedure under the horizontal scaling and the rise of the text space', () => {
    const { paints } = run({ content: 'BT /T3 10 Tf 50 Tz 3 Ts (a) Tj ET', resources: '/Font<</T3 110 0 R>>' }, TYPE3);
    // 9.4.4: text space is [Tfs × Th 0 0 Tfs 0 Trise] × Tm × CTM, here [5 0 0 10 0 3], and the glyph's CTM is the font matrix concatenated with it.
    expect(paints.filter(paint => paint.kind === 'fill').map(paint => paint.state.ctm.map(value => round(value)))).toStrictEqual([[0.005, 0, 0, 0.01, 0, 3]]);
  });

  it('does not count text a glyph procedure shows against maxGlyphs', () => {
    const page = { content: 'BT /T3 10 Tf (b) Tj ET', resources: `/Font<</T3 110 0 R/F1 101 0 R>>/ColorSpace<</CS1/DeviceCMYK>>` };
    // The procedure of b shows A with F1, which is painting of the glyph, not text of the page.
    expect(run(page, TYPE3, { maxGlyphs: 1 }).paints.map(paint => paint.kind)).toStrictEqual(['text', 'fill', 'text']);
    expect(() => run(page, TYPE3, { maxGlyphs: 0 })).toThrow(ResourceLimitError);
    // Page text shown after the procedure has the budget the procedure's own text left untouched.
    expect(run({ ...page, content: 'BT /T3 10 Tf (b) Tj /F1 10 Tf (A) Tj ET' }, TYPE3, { maxGlyphs: 2 }).paints.map(paint => paint.kind)).toStrictEqual([
      'text',
      'fill',
      'text',
      'text',
    ]);
  });

  it('does not enter a glyph procedure that shows its own glyph', () => {
    const { result } = run({ content: 'BT /T3 10 Tf (a) Tj ET', resources: '/Font<</T3 110 0 R>>' }, [
      { number: 110, body: TYPE3_FONT },
      { number: 111, body: streamBody('', '1000 0 d0 BT /T3 1 Tf (a) Tj ET') },
      { number: 112, body: streamBody('', '1000 0 d0') },
    ]);
    expect([result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([false, ['content-cycle']]);
  });
});

const appearance = (number: number, dictionary: string, box = '[0 0 10 5]'): TestObject =>
  form(number, `/BBox${box}${dictionary}/Resources<<${FONT_RESOURCES}>>`, 'BT /F1 1 Tf (A) Tj ET');
const annotation = (number: number, entries: string): TestObject => ({ number, body: `<</Type/Annot/Subtype/Square/Rect[100 100 200 150]${entries}>>` });

describe('annotations and soft masks', () => {
  const ANNOTATED: TestPage = { content: '', entries: '/Annots[120 0 R 121 0 R 122 0 R]' };
  const OBJECTS: ReadonlyArray<TestObject> = [
    annotation(120, '/F 4/AP<</N 130 0 R>>'),
    annotation(121, '/F 0/AP<</N 131 0 R>>'),
    annotation(122, '/F 4/AS/On/AP<</N<</Off 130 0 R/On 132 0 R>>>>'),
    appearance(130, ''),
    appearance(131, '/Matrix[0 1 -1 0 0 0]'),
    appearance(132, '/Matrix[1 0 0 1 0 0]', '[0 0 20 5]'),
  ];

  it('draws the normal appearances of annotations under the matrix AA of 12.5.5', () => {
    const printable = run(ANNOTATED, OBJECTS, { annotations: 'printable' });
    const all = run(ANNOTATED, OBJECTS, { annotations: 'all' });
    // The box 0…10 by 0…5 maps onto the Rect 100…200 by 100…150; rotated by the Matrix it is −5…0 by 0…10, so A = [20 0 0 5 200 100] and AA = Matrix × A. The On state's box 0…20 by 0…5 maps by [5 0 0 10 100 100].
    expect([run(ANNOTATED, OBJECTS).texts.length, printable.texts.map(text => text.state.ctm)]).toStrictEqual([
      0,
      [
        [10, 0, 0, 10, 100, 100],
        [5, 0, 0, 10, 100, 100],
      ],
    ]);
    expect(all.texts.map(text => [text.state.ctm, text.context.sources])).toStrictEqual([
      [[10, 0, 0, 10, 100, 100], [{ kind: 'annotation', index: 0, printable: true }]],
      [[0, 5, -20, 0, 200, 100], [{ kind: 'annotation', index: 1, printable: false }]],
      [[5, 0, 0, 10, 100, 100], [{ kind: 'annotation', index: 2, printable: true }]],
    ]);
  });

  it.each([
    ['an appearance subdictionary and no AS', '/F 4/Rect[100 100 200 150]/AP<</N<</On 130 0 R>>>>'],
    ['an AS that names no state of the subdictionary', '/F 4/Rect[100 100 200 150]/AS/Off/AP<</N<</On 130 0 R>>>>'],
    ['no Rect', '/F 4/AP<</N 130 0 R>>'],
  ])('draws nothing and warns of nothing for an annotation with %s', (_, entries) => {
    const { texts, result } = run(
      { content: '', entries: '/Annots[120 0 R]' },
      [{ number: 120, body: `<</Type/Annot/Subtype/Square${entries}>>` }, appearance(130, '')],
      {
        annotations: 'all',
      },
    );
    expect([texts, result.warnings]).toStrictEqual([[], []]);
  });

  it('maps an appearance onto a Rect given by any two opposite corners', () => {
    // ISO 32000-1:2008, 7.9.5: a rectangle is written as "a pair of diagonally opposite corners", here the upper right one first.
    const { texts } = run(
      { content: '', entries: '/Annots[120 0 R]' },
      [{ number: 120, body: '<</Type/Annot/Subtype/Square/F 4/Rect[200 150 100 100]/AP<</N 130 0 R>>>>' }, appearance(130, '')],
      {
        annotations: 'all',
      },
    );
    expect(texts.map(text => text.state.ctm)).toStrictEqual([[10, 0, 0, 10, 100, 100]]);
  });

  it('draws an appearance with no marked-content sequence open, whatever the page leaves open', () => {
    const { texts, result } = run({ content: '/P BMC', entries: '/Annots[120 0 R]' }, [annotation(120, '/F 4/AP<</N 130 0 R>>'), appearance(130, '')], {
      annotations: 'all',
    });
    expect([texts.map(text => text.markedContent), result.warnings.map(warning => warning.code)]).toStrictEqual([[[]], ['marked-content-unbalanced']]);
  });

  it('draws a soft-mask group as its own context when a graphics state sets it', () => {
    const { paints } = run({ content: '2 0 0 2 0 0 cm /Masked gs 0 0 1 1 re f', resources: '/ExtGState<</Masked<</SMask<</S/Alpha/G 110 0 R>>>>>>' }, [
      form(110, '/BBox[0 0 10 10]/Group<</S/Transparency>>/Resources<<>>', '0.5 g 0 0 10 10 re f'),
    ]);
    // 11.6.5.2: the mask's coordinates are set by the CTM "at the moment the soft mask is established in the graphics state with the gs operator".
    expect([sourceKinds(paints), paints.map(paint => paint.state.ctm), paints.map(paint => paint.state.softMask === undefined)]).toStrictEqual([
      ['page/soft-mask', 'page'],
      [
        [2, 0, 0, 2, 0, 0],
        [2, 0, 0, 2, 0, 0],
      ],
      [true, false],
    ]);
  });
});

describe('damaged content', () => {
  it('ignores unknown operators with a warning, silently inside BX and EX', () => {
    const { result } = textRun('1 2 foo BX 3 bar EX');
    expect([result.complete, result.operations, result.warnings.map(warning => warning.code)]).toStrictEqual([true, 4, ['unknown-operator']]);
    // The detail names the operator, its offset and its stream.
    expect(result.warnings[0]?.detail).toMatch(/^foo\b.*\boffset 4\b.*\bcontent stream 0$/u);
  });

  it('skips an operator with bad operands and marks the page incomplete', () => {
    const { texts, result } = textRun('2 cm /F1 Tf BT /F1 10 Tf (A) Tj ET');
    expect([texts.length, result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([1, false, ['bad-operands', 'bad-operands']]);
  });

  it('reports a missing resource and text shown without a font', () => {
    const { result } = textRun('/Nope cs BT (A) Tj /Nope 10 Tf (A) Tj ET');
    expect([result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([
      false,
      ['resource-missing', 'resource-missing', 'resource-missing', 'resource-missing'],
    ]);
  });

  it('reports content that stops parsing part-way and keeps what came before', () => {
    const { paints, result } = textRun('0 0 10 10 re f (unterminated');
    expect([paints.map(paint => paint.kind), result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([
      ['fill'],
      false,
      ['content-unreadable'],
    ]);
  });

  it('reports a font whose dictionary parses but whose Widths cannot be read, and goes on', () => {
    const { texts, result } = run({ content: 'BT /Bad 10 Tf (A) Tj /F1 10 Tf (A) Tj ET', resources: '/Font<</F1 101 0 R/Bad 150 0 R>>' }, [
      { number: 150, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/FirstChar 65/LastChar 65/Widths 151 0 R>>' },
      { number: 151, body: '[667 (unterminated' },
    ]);
    expect([texts.map(text => text.font.key), result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([
      ['101.0'],
      false,
      ['font-unreadable', 'resource-missing'],
    ]);
  });

  it("reports a font's own warnings once however often it is shown", () => {
    const { texts, result } = textRun('BT /U 10 Tf (A) Tj (A) Tj ET', [{ number: 105, body: '<</Type/Font/Subtype/Type1/BaseFont/Unknown>>' }]);
    expect([texts.length, result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([2, true, ['widths-unknown']]);
  });

  it('names a stream by its index in the Contents array, counting items it skips', () => {
    // The unknown operator is in the second stream read, so the index of that stream and the index of the first stream read differ.
    const document = textPdf({
      pages: [{ entries: '/Contents[null 120 0 R 121 0 R]' }],
      objects: [
        { number: 120, body: streamBody('', '0 g') },
        { number: 121, body: streamBody('', 'foo') },
      ],
    });
    const { warnings } = interpretPage(document, 0);
    expect(warnings.map(warning => warning.code)).toStrictEqual(['unknown-operator']);
    expect(warnings[0]?.detail).toMatch(/\bcontent stream 2$/u);
  });

  it('lets an error that is not about unreadable content propagate', () => {
    const failure = new Error('the paint handler failed');
    const document = textPdf({ pages: [{ content: '0 0 10 10 re f' }] });
    let thrown: unknown;
    try {
      interpretPage(document, 0, {
        paint: () => {
          throw failure;
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });

  it('reports a font object that cannot be parsed and goes on', () => {
    const { texts, result } = run({ content: 'BT /Bad 10 Tf (A) Tj /F1 10 Tf (A) Tj ET', resources: '/Font<</F1 101 0 R/Bad 150 0 R>>' }, [
      { number: 150, body: '<</Type/Font/Subtype/Type1/BaseFont(unterminated' },
    ]);
    expect([texts.length, result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([1, false, ['content-unreadable', 'resource-missing']]);
  });

  it('reports an object in an object stream whose filter is not supported and goes on', () => {
    const { bytes } = buildPdf([
      {
        xref: 'stream',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]/Contents 4 0 R/Resources<<${FONT_RESOURCES}/ExtGState<</G 150 0 R>>>>>>` },
          { number: 4, body: streamBody('', '/G gs BT /F1 10 Tf (A) Tj ET') },
          ...FONTS,
        ],
        objectStreams: [{ number: 200, members: [{ number: 150, body: '<</ca 0.5>>' }], dictionary: '/Filter/Foo' }],
        trailer: '/Root 1 0 R',
      },
    ]);
    const texts: Array<TextShowEvent> = [];
    const result = interpretPage(internalsWith(bytes, 256), 0, {
      text: event => {
        texts.push(event);
      },
    });
    expect([texts.length, result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([1, false, ['content-unreadable']]);
  });

  it('reports content that cannot be decoded', () => {
    const damaged = textPdf({
      pages: [{ resources: FONT_RESOURCES, entries: '/Contents 120 0 R' }],
      objects: [...FONTS, { number: 120, body: streamBody('/Filter/FlateDecode', 'not deflate') }],
    });
    const result = interpretPage(damaged, 0, {});
    expect([result.complete, result.warnings.map(warning => warning.code)]).toStrictEqual([false, ['content-unreadable']]);
  });

  it('refuses a page index that is not a page', () => {
    const document = textPdf({ pages: [{ content: '' }] });
    expect(() => interpretPage(document, 1, {})).toThrow(InvalidArgumentError);
    expect(() => interpretPage(document, -1, {})).toThrow(InvalidArgumentError);
    expect(() => interpretPage(document, 0.5, {})).toThrow(InvalidArgumentError);
  });

  it('refuses an annotations mode it does not know', () => {
    const options: InterpretOptions = {};
    Reflect.set(options, 'annotations', 'bogus');
    expect(() => interpretPage(textPdf({ pages: [{ content: '' }] }), 0, options)).toThrow(InvalidArgumentError);
  });
});

type Six = readonly [number, number, number, number, number, number];

// The product of [a b 0; c d 0; e f 1] matrices written out row by row (ISO 32000-1:2008, 8.3.4), apart from the library's own.
const product = ([a, b, c, d, e, f]: Six, [a2, b2, c2, d2, e2, f2]: Six): Six => [
  a * a2 + b * c2,
  a * b2 + b * d2,
  c * a2 + d * c2,
  c * b2 + d * d2,
  e * a2 + f * c2 + e2,
  e * b2 + f * d2 + f2,
];

// Translations, scalings and quarter turns with small integer entries: every product is exact, and none is singular, so no step hides an earlier one.
const offset = fc.integer({ min: -10, max: 10 });
const factor = fc.constantFrom(-2, -1, 2);
const matrices = fc.oneof(
  fc.tuple(offset, offset).map(([x, y]): Six => [1, 0, 0, 1, x, y]),
  fc.tuple(factor, factor).map(([x, y]): Six => [x, 0, 0, y, 0, 0]),
  fc.constant<Six>([0, 1, -1, 0, 0, 0]),
);
const stackSteps = fc.array(
  fc.oneof(
    fc.constant({ kind: 'q' } as const),
    fc.constant({ kind: 'Q' } as const),
    fc.constant({ kind: 'show' } as const),
    matrices.map(matrix => ({ kind: 'cm', matrix }) as const),
  ),
  { minLength: 12, maxLength: 24 },
);

describe('properties', () => {
  it('shows text under the CTM a stack of q, Q and cm gives', () => {
    fc.assert(
      fc.property(stackSteps, steps => {
        const operators: Array<string> = [];
        const expected: Array<Six> = [];
        const saved: Array<Six> = [];
        let ctm: Six = [1, 0, 0, 1, 0, 0];
        for (const step of steps) {
          if (step.kind === 'q') {
            saved.push(ctm);
            operators.push('q');
          } else if (step.kind === 'Q') {
            // Only a Q that has a saved state to restore, so that the sequence balances.
            const restored = saved.pop();
            if (restored !== undefined) {
              ctm = restored;
              operators.push('Q');
            }
          } else if (step.kind === 'cm') {
            ctm = product(step.matrix, ctm);
            operators.push(`${step.matrix.join(' ')} cm`);
          } else {
            expected.push(ctm);
            operators.push('BT /F1 10 Tf (A) Tj ET');
          }
        }
        expect(textRun(operators.join(' ')).texts.map(text => text.state.ctm.map(value => value + 0))).toStrictEqual(
          expected.map(matrix => matrix.map(value => value + 0)),
        );
      }),
    );
  });
});

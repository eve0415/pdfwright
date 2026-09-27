import type { TestObject } from '../testing/pdfBuilder.ts';
import type { TestPage } from '../testing/textPdf.ts';
import type { ColorSelectEvent, ColorSpaceUse, InterpretResult, PaintEvent, TextShowEvent } from './interpreter.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { latin1Text, streamBody } from '../testing/pdfBuilder.ts';
import { textPdf } from '../testing/textPdf.ts';

import { interpretPage } from './interpreter.ts';

interface Run {
  readonly paints: PaintEvent[];
  readonly texts: TextShowEvent[];
  readonly selects: ColorSelectEvent[];
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

const run = (page: TestPage, objects: readonly TestObject[] = []): Run => {
  const paints: PaintEvent[] = [];
  const texts: TextShowEvent[] = [];
  const selects: ColorSelectEvent[] = [];
  const document = textPdf({ pages: [page], objects: [...FONTS, ...objects] });
  const result = interpretPage(document, 0, {
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
  return { paints, texts, selects, result };
};

const textRun = (content: string, objects: readonly TestObject[] = [], resources = ''): Run =>
  run({ content, resources: `${FONT_RESOURCES}${resources}` }, objects);

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

// The translation of the text matrix at each shown glyph: where the glyph's origin is in unscaled text space.
const positions = (texts: readonly TextShowEvent[]): (readonly [number, number])[] =>
  texts.flatMap(text => text.glyphs.map(({ textMatrix }) => [round(textMatrix[4]), round(textMatrix[5])] as const));

const spaceName = (use: ColorSpaceUse): string => (use.space?.kind === 'name' ? latin1Text(use.space.bytes) : (use.space?.kind ?? 'unknown'));

const paintSpaces = (paints: readonly PaintEvent[]): string[] => paints.map(paint => `${paint.kind}:${paint.colorSpaces.map(use => spaceName(use)).join(',')}`);

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
    expect(paintSpaces(paints)).toStrictEqual(['fill:array', 'stroke:DeviceRGB', 'fill-stroke:array,DeviceRGB']);
    expect(selects.map(select => `${select.target}:${spaceName(select.use)}`)).toStrictEqual(['fill:array', 'stroke:DeviceRGB']);
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

  it('reads the streams of a Contents array with one operand stack', () => {
    const { texts, result } = run({ content: ['BT /F1 10', 'Tf (A) Tj ET'], resources: FONT_RESOURCES });
    expect([texts.length, result.complete, result.warnings]).toStrictEqual([1, true, []]);
  });

  it('takes resources inherited from the page tree', () => {
    const document = textPdf({ pages: [{ content: 'BT /F1 10 Tf (A) Tj ET' }], objects: FONTS, root: `/Resources<<${FONT_RESOURCES}>>` });
    const texts: TextShowEvent[] = [];
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
    const { paints, texts } = textRun('BT /F1 10 Tf 1 0 0 RG (A) Tj 1 Tr (A) Tj 2 Tr (A) Tj 3 Tr (A) Tj 7 Tr (A) Tj ET');
    expect(paintSpaces(paints)).toStrictEqual(['text:DeviceGray', 'text:DeviceRGB', 'text:DeviceGray,DeviceRGB']);
    expect(texts).toHaveLength(5);
  });

  it('loses the position after a glyph of unknown width until the next positioning operator', () => {
    const { texts } = textRun('BT /U 10 Tf (AA) Tj 10 10 Td (A) Tj ET', [{ number: 105, body: '<</Type/Font/Subtype/Type1/BaseFont/Unknown>>' }], '');
    expect(texts.flatMap(text => text.glyphs.map(glyph => glyph.positionKnown))).toStrictEqual([true, false, true]);
  });
});

describe('damaged content', () => {
  it('ignores unknown operators with a warning, silently inside BX and EX', () => {
    const { result } = textRun('1 2 foo BX 3 bar EX');
    expect(result).toStrictEqual({ complete: true, warnings: [{ code: 'unknown-operator', detail: 'foo at offset 4 of content stream 0' }], operations: 4 });
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
  });
});

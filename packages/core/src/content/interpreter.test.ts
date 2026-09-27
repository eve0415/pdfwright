import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { TestPage } from '../testing/textPdf.ts';
import type { ColorSelectEvent, ColorSpaceUse, CoverEvent, InterpretOptions, InterpretResult, PaintEvent, TextShowEvent } from './interpreter.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';
import { textPdf, textPdfBytes } from '../testing/textPdf.ts';

import { interpretPage } from './interpreter.ts';

interface Run {
  readonly covers: CoverEvent[];
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

const form = (number: number, dictionary: string, content: string): TestObject => ({
  number,
  body: streamBody(`/Type/XObject/Subtype/Form${dictionary}`, content),
});

const run = (page: TestPage, objects: readonly TestObject[] = [], options: InterpretOptions = {}): Run => {
  const paints: PaintEvent[] = [];
  const texts: TextShowEvent[] = [];
  const selects: ColorSelectEvent[] = [];
  const covers: CoverEvent[] = [];
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

describe('clipping', () => {
  it('intersects the clip with a path after the operator that paints it, in page space, until Q', () => {
    const { texts, paints } = textRun('q 2 0 0 2 0 0 cm 0 0 50 50 re W f BT /F1 10 Tf (A) Tj ET Q BT /F1 10 Tf (A) Tj ET');
    const clipped = texts[0]?.state.clip;
    // ISO 32000-1:2008, 8.5.4: the clip changes "After the path has been painted", so the fill itself is not clipped by its own path.
    expect([clipped?.classifyPoint(90, 90), clipped?.classifyPoint(110, 90), texts[1]?.state.clip.vertices, paints.map(paint => paint.kind)]).toStrictEqual([
      'inside',
      'outside',
      0,
      ['fill', 'text', 'text'],
    ]);
  });

  it('builds a path under the CTM in force when its first segment is added, whatever operators came before', () => {
    const { covers, texts } = textRun('1 w 2 0 0 2 0 0 cm 0 0 100 100 re f 0.5 w 1 0 0 1 100 100 cm 0 0 50 50 re W n BT /F1 10 Tf (A) Tj ET');
    expect([covers.map(cover => cover.rectangle), texts[0]?.state.clip.classifyPoint(250, 250)]).toStrictEqual([[[0, 0, 200, 200]], 'inside']);
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
    '/ExtGState<</Half<</ca 0.5/CA 0.25>>/Multiply<</BM/Multiply>>/Listed<</BM[/NoSuchMode/Normal]>>/Masked<</SMask<</S/Luminosity/G 110 0 R>>>>/Unmasked<</SMask/None>>>>';
  const GROUP: TestObject = {
    number: 110,
    body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceGray>>', '0 g 0 0 10 10 re f'),
  };

  it('keeps the alpha constants, blend mode and soft mask of graphics state parameter dictionaries', () => {
    const { texts } = textRun('BT /F1 10 Tf /Half gs /Multiply gs /Masked gs (A) Tj /Unmasked gs /Listed gs (A) Tj ET', [GROUP], STATES);
    const [first, second] = texts.map(text => text.state);
    // ISO 32000-1:2008, 11.6.3: from an array a reader "shall use the first blend mode in the array that it recognizes".
    expect([
      first?.fillAlpha,
      first?.strokeAlpha,
      first?.blendMode,
      first?.softMask?.subtype,
      first?.softMask?.group,
      second?.softMask,
      second?.blendMode,
    ]).toStrictEqual([0.5, 0.25, 'Multiply', 'Luminosity', { kind: 'reference', objectNumber: 110, generation: 0 }, undefined, 'Normal']);
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
        content: 'q /AllNone cs 1 1 sc 0 0 10 10 re f Q q /IndexedNone cs 1 sc 0 0 10 10 re f Q 0 0 10 10 re f',
        resources: '/ColorSpace<</AllNone[/DeviceN[/None/None]/DeviceGray 111 0 R]/IndexedNone[/Indexed[/Separation/None/DeviceGray 111 0 R]1<00FF>]>>',
      },
      [{ number: 111, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' }],
    );
    // 8.6.6.5: a DeviceN component named None "shall never be painted"; an Indexed space paints in its base space (8.6.6.3).
    expect(covers.map(cover => cover.rectangle)).toStrictEqual([[0, 0, 10, 10]]);
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
          '0 0 m 10 0 l 0 10 l f 0 0 5 5 re 5 5 5 5 re f 0 0 10 10 re S',
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
  if (parts === undefined) throw new Error('the document has no internals');
  return parts;
};

const sourceKinds = (events: readonly { readonly context: { readonly sources: readonly { readonly kind: string }[] } }[]): string[] =>
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
    expect(run(page, objects).result.operations).toBe(8);
    expect(() => run(page, objects, { maxOperations: 7 })).toThrow(ResourceLimitError);
  });

  it('counts the content bytes of a form each time it is drawn and stops at maxContentBytes', () => {
    // About 1 MB of comment, which produces no operations for maxOperations to count.
    const page = { content: '/Fm1 Do\n'.repeat(5), resources: '/XObject<</Fm1 110 0 R>>' };
    const objects = [form(110, '/BBox[0 0 50 50]', `%${'x'.repeat(1_000_000)}\n0 g`)];
    expect(run(page, objects).result.operations).toBe(10);
    expect(() => run(page, objects, { maxContentBytes: 4_000_000 })).toThrow(ResourceLimitError);
  });

  it('stops at forms nested deeper than maxNesting', () => {
    const chain = Array.from({ length: 6 }, (_, index) =>
      form(110 + index, `/BBox[0 0 1 1]/Resources<</XObject<</Next ${String(111 + index)} 0 R>>>>`, '/Next Do'),
    );
    const bytes = textPdfBytes({
      pages: [{ content: '/Next Do', resources: '/XObject<</Next 110 0 R>>' }],
      objects: [...chain, form(116, '/BBox[0 0 1 1]', '')],
    });
    expect(() => interpretPage(internalsWith(bytes, 4), 0)).toThrow(ResourceLimitError);
    expect(interpretPage(internalsWith(bytes, 8), 0).warnings).toStrictEqual([]);
  });
});

describe('patterns', () => {
  const PATTERNS = '/ColorSpace<</RGBPattern[/Pattern/DeviceRGB]>>/Pattern<</Coloured 110 0 R/Uncoloured 111 0 R/Shaded 112 0 R>>';
  const OBJECTS: readonly TestObject[] = [
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
      ['fill:array,DeviceRGB', 'fill:DeviceRGB'],
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
    const objects: TestObject[] = [
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
      ['fill-stroke:Pattern,array,DeviceCMYK,DeviceRGB', [0, 1, 0, 1]],
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

  it('paints a shading pattern in the shading colour space', () => {
    const { paints } = run({ content: '/Pattern cs /Shaded scn 0 0 10 10 re f', resources: PATTERNS }, OBJECTS);
    expect(paintSpaces(paints)).toStrictEqual(['fill:Pattern,DeviceCMYK']);
  });
});

describe('glyph procedures of Type 3 fonts', () => {
  const TYPE3_FONT =
    '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 111 0 R/b 112 0 R>>/Encoding<</Differences[97/a/b]>>/FirstChar 97/LastChar 98/Widths[1000 1000]>>';
  const TYPE3: readonly TestObject[] = [
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
});

const appearance = (number: number, dictionary: string): TestObject =>
  form(number, `/BBox[0 0 10 5]${dictionary}/Resources<<${FONT_RESOURCES}>>`, 'BT /F1 1 Tf (A) Tj ET');
const annotation = (number: number, entries: string): TestObject => ({ number, body: `<</Type/Annot/Subtype/Square/Rect[100 100 200 150]${entries}>>` });

describe('annotations and soft masks', () => {
  const ANNOTATED: TestPage = { content: '', entries: '/Annots[120 0 R 121 0 R 122 0 R]' };
  const OBJECTS: readonly TestObject[] = [
    annotation(120, '/F 4/AP<</N 130 0 R>>'),
    annotation(121, '/F 0/AP<</N 131 0 R>>'),
    annotation(122, '/F 4/AS/On/AP<</N<</Off 130 0 R/On 132 0 R>>>>'),
    appearance(130, ''),
    appearance(131, '/Matrix[0 1 -1 0 0 0]'),
    appearance(132, '/Matrix[1 0 0 1 0 0]'),
  ];

  it('draws the normal appearances of annotations under the matrix AA of 12.5.5', () => {
    const printable = run(ANNOTATED, OBJECTS, { annotations: 'printable' });
    const all = run(ANNOTATED, OBJECTS, { annotations: 'all' });
    // The box 0…10 by 0…5 maps onto the Rect 100…200 by 100…150; rotated by the Matrix it is −5…0 by 0…10, so A = [20 0 0 5 200 100] and AA = Matrix × A.
    expect([run(ANNOTATED, OBJECTS).texts.length, printable.texts.map(text => text.state.ctm)]).toStrictEqual([
      0,
      [
        [10, 0, 0, 10, 100, 100],
        [10, 0, 0, 10, 100, 100],
      ],
    ]);
    expect(all.texts.map(text => [text.state.ctm, text.context.sources])).toStrictEqual([
      [[10, 0, 0, 10, 100, 100], [{ kind: 'annotation', index: 0, printable: true }]],
      [[0, 5, -20, 0, 200, 100], [{ kind: 'annotation', index: 1, printable: false }]],
      [[10, 0, 0, 10, 100, 100], [{ kind: 'annotation', index: 2, printable: true }]],
    ]);
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
    const texts: TextShowEvent[] = [];
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
  });
});

import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { TestPage } from '../../testing/textPdf.ts';
import type { ColorantUse, ListColorantsOptions, PageColorants } from './listColorants.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { InvalidArgumentError } from '../../error/invalidArgumentError.ts';
import { latin1Bytes, latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { listColorants } from './listColorants.ts';

const TINT = '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 1>>';
const separation = (name: string, alternate = '/DeviceCMYK'): string => `[/Separation/${name}${alternate} ${TINT}]`;
const FONT = '/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>';
const SPACES = `/ColorSpace<</CS1 ${separation('Gold')}/CS2 ${separation('Silver')}>>`;

const pagesOf = (pages: ReadonlyArray<TestPage>, objects: ReadonlyArray<TestObject> = []): ReadonlyArray<PageColorants> =>
  listColorants(loadDocument(textPdfBytes({ pages, objects })));

const describeUse = ({ name, kind, painted, selected, declared }: ColorantUse): string =>
  `${latin1Text(name)} ${kind} p=${painted.join(',')} s=${selected.join(',')} d=${declared.join(',')}`;

interface Fixture {
  /** Further Resources entries. */
  readonly resources?: string;
  /** Extra ColorSpace resources beside CS1 (Gold) and CS2 (Silver). */
  readonly spaces?: string;
  readonly objects?: ReadonlyArray<TestObject>;
  /** Further page dictionary entries. */
  readonly entries?: string;
}

// The first page, whose resources hold CS1 (Gold), CS2 (Silver) and F1 (Helvetica) beside what the fixture adds.
const firstPage = (content: string, { resources = '', spaces = '', objects = [], entries = '' }: Fixture = {}): PageColorants | undefined => {
  const [page] = pagesOf(
    [{ content, resources: `/ColorSpace<</CS1 ${separation('Gold')}/CS2 ${separation('Silver')}${spaces}>>${FONT}${resources}`, entries }],
    objects,
  );
  return page;
};

// Each colorant of the first page, as `name kind p=painted s=selected d=declared`.
const colorants = (content: string, fixture: Fixture = {}): Array<string> => firstPage(content, fixture)?.colorants.map(use => describeUse(use)) ?? [];

const SILVER_UNUSED = 'Silver spot p= s= d=resources';

const type3Font = (procedures: string): string =>
  `<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 111 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]/Resources<<${procedures}>>>>`;

const imageObject = (space: string): string => streamBody(`/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace ${space}/BitsPerComponent 8`, 'a');

const appearance = (number: number, space: string): TestObject => ({
  number,
  body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<${SPACES}>>`, `/${space} cs 1 scn 0 0 10 10 re f`),
});

describe('painted colorants', () => {
  it('counts a DeviceN DefaultCMYK colorant painted with the k operator', () => {
    const [page] = pagesOf(
      [{ content: '0 0 0 1 k 0 0 10 10 re f', resources: '/ColorSpace<</DefaultCMYK[/DeviceN[/Cyan/Magenta/Yellow/Spot]/DeviceCMYK 120 0 R]>>' }],
      [{ number: 120, body: streamBody('/FunctionType 4/Domain[0 1 0 1 0 1 0 1]/Range[0 1 0 1 0 1 0 1]', '') }],
    );
    const spot = page?.colorants.find(use => latin1Text(use.name) === 'Spot');
    expect(spot).toMatchObject({ painted: ['fill'], declared: [] });
  });

  it('reports fills, strokes and text by the operation that paints them', () => {
    expect([
      colorants('/CS1 cs 1 scn 0 0 10 10 re f'),
      colorants('/CS1 CS 1 SCN 0 0 m 10 10 l S'),
      colorants('/CS1 cs /CS2 CS 0 0 10 10 re B'),
      colorants('BT /F1 12 Tf /CS1 cs 1 scn (a) Tj ET'),
      colorants('BT /F1 12 Tf 1 Tr /CS1 CS 1 SCN (a) Tj ET'),
    ]).toStrictEqual([
      ['Gold spot p=fill s= d=', 'Silver spot p= s= d=resources'],
      ['Gold spot p=stroke s= d=', 'Silver spot p= s= d=resources'],
      ['Gold spot p=fill s= d=', 'Silver spot p=stroke s= d='],
      ['Gold spot p=text s= d=', 'Silver spot p= s= d=resources'],
      ['Gold spot p=text s= d=', 'Silver spot p= s= d=resources'],
    ]);
  });

  it('reports images, image masks, inline images and shadings', () => {
    const objects: Array<TestObject> = [
      { number: 120, body: imageObject(separation('Image')) },
      { number: 121, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/ImageMask true', 'a') },
      { number: 122, body: `<</ShadingType 2/ColorSpace ${separation('Shade')}/Coords[0 0 1 0]/Function ${TINT}>>` },
    ];
    const fixture: Fixture = { resources: '/XObject<</Im1 120 0 R/Im2 121 0 R>>/Shading<</Sh1 122 0 R>>', objects };
    expect([
      colorants('/Im1 Do', fixture),
      colorants('/CS1 cs 1 scn /Im2 Do', fixture),
      colorants('BI /W 1 /H 1 /CS /CS2 /BPC 8 ID a EI', fixture),
      colorants('/CS2 cs 1 scn BI /W 1 /H 1 /IM true ID \u0000 EI', fixture),
      colorants('/Sh1 sh', fixture),
    ]).toStrictEqual([
      ['Gold spot p= s= d=resources', 'Image spot p=image s= d=', 'Shade spot p= s= d=resources', 'Silver spot p= s= d=resources'],
      ['Gold spot p=image-mask s= d=', 'Image spot p= s= d=resources', 'Shade spot p= s= d=resources', 'Silver spot p= s= d=resources'],
      ['Gold spot p= s= d=resources', 'Image spot p= s= d=resources', 'Shade spot p= s= d=resources', 'Silver spot p=inline-image s= d='],
      ['Gold spot p= s= d=resources', 'Image spot p= s= d=resources', 'Shade spot p= s= d=resources', 'Silver spot p=image-mask s= d='],
      ['Gold spot p= s= d=resources', 'Image spot p= s= d=resources', 'Shade spot p=shading s= d=', 'Silver spot p= s= d=resources'],
    ]);
  });

  it('reports the spaces patterns paint in: a shading pattern, an uncoloured pattern base and a coloured pattern cell', () => {
    const objects: Array<TestObject> = [
      { number: 130, body: `<</PatternType 2/Shading<</ShadingType 2/ColorSpace ${separation('Shade')}/Coords[0 0 1 0]/Function ${TINT}>>>>` },
      { number: 131, body: streamBody(`/PatternType 1/PaintType 2/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1/Resources<<${SPACES}>>`, '/CS2 cs 0 0 1 1 re f') },
      {
        number: 132,
        body: streamBody(`/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1/Resources<<${SPACES}>>`, '/CS2 cs 1 scn 0 0 1 1 re f'),
      },
    ];
    const fixture: Fixture = { resources: '/Pattern<</P1 130 0 R/P2 131 0 R/P3 132 0 R>>', spaces: `/PG [/Pattern ${separation('Base')}]`, objects };
    expect([
      colorants('/Pattern cs /P1 scn 0 0 10 10 re f', fixture),
      colorants('/PG cs 1 /P2 scn 0 0 10 10 re f', fixture),
      colorants('/Pattern cs /P3 scn 0 0 10 10 re f', fixture),
    ]).toStrictEqual([
      ['Base spot p= s= d=resources', 'Gold spot p= s= d=resources', 'Shade spot p=fill,pattern s= d=', 'Silver spot p= s= d=resources'],
      ['Base spot p=fill,pattern s= d=', 'Gold spot p= s= d=resources', 'Shade spot p= s= d=resources', 'Silver spot p= s= d=resources,uncoloured-pattern'],
      ['Base spot p= s= d=resources', 'Gold spot p= s= d=resources', 'Shade spot p= s= d=resources', 'Silver spot p=fill,pattern s= d='],
    ]);
  });

  it('counts colours a d0 glyph sets, and the current colour a d1 glyph paints with, while colours set in a d1 glyph are declared', () => {
    const d0: Array<TestObject> = [
      { number: 110, body: type3Font(SPACES) },
      { number: 111, body: streamBody('', '1000 0 d0 /CS2 cs 1 scn 0 0 750 750 re f') },
    ];
    const d1: Array<TestObject> = [
      { number: 110, body: type3Font(SPACES) },
      { number: 111, body: streamBody('', '1000 0 0 0 750 750 d1 /CS2 cs 1 scn 0 0 750 750 re f') },
    ];
    const resources = '/Font<</T3 110 0 R>>';
    expect([
      colorants('BT /T3 12 Tf (a) Tj ET', { resources, objects: d0 }),
      colorants('BT /T3 12 Tf /CS1 cs 1 scn (a) Tj ET', { resources, objects: d1 }),
    ]).toStrictEqual([
      ['Gold spot p= s= d=resources', 'Silver spot p=fill,type3-glyph s= d='],
      ['Gold spot p=fill,text,type3-glyph s= d=', 'Silver spot p= s= d=resources,d1-glyph'],
    ]);
  });

  it('reports printable annotation appearances as painted and others as declared', () => {
    const annotations =
      '/Annots[<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/F 4/AP<</N 140 0 R>>>> <</Type/Annot/Subtype/Square/Rect[0 0 10 10]/F 6/AP<</N 141 0 R>>>>]';
    expect(colorants('', { objects: [appearance(140, 'CS1'), appearance(141, 'CS2')], entries: annotations })).toStrictEqual([
      'Gold spot p=fill,annotation s= d=',
      'Silver spot p= s= d=resources,annotation-not-printed',
    ]);
  });

  // ISO 32000-1:2008, 8.6.5.6: a device colour operator paints in the Default space of its family when the current resources define one.
  it.each([
    ['g with DefaultGray', '0.5 g 0 0 10 10 re f', `/DefaultGray ${separation('G')}`, ['G spot p=fill s= d=', 'Gold spot p= s= d=resources', SILVER_UNUSED]],
    [
      'rg with DefaultRGB',
      '1 0 0 rg 0 0 10 10 re f',
      `/DefaultRGB[/DeviceN[/R/Gx/B]/DeviceRGB ${TINT}]`,
      ['B spot p=fill s= d=', 'Gold spot p= s= d=resources', 'Gx spot p=fill s= d=', 'R spot p=fill s= d=', SILVER_UNUSED],
    ],
    [
      'rg with only DefaultGray',
      '1 0 0 rg 0 0 10 10 re f',
      `/DefaultGray ${separation('G')}`,
      ['G spot p= s= d=resources', 'Gold spot p= s= d=resources', SILVER_UNUSED],
    ],
  ])('paints %s in the Default space', (_, content, spaces, expected) => {
    expect(colorants(content, { spaces })).toStrictEqual(expected);
  });
});

describe('colorants in patterns', () => {
  const SHADINGS: Array<TestObject> = [
    { number: 160, body: `<</PatternType 2/Shading<</ShadingType 2/ColorSpace ${separation('Red')}/Coords[0 0 1 0]/Function ${TINT}>>>>` },
    { number: 161, body: `<</PatternType 2/Shading<</ShadingType 2/ColorSpace ${separation('Green')}/Coords[0 0 1 0]/Function ${TINT}>>>>` },
    { number: 162, body: streamBody('/PatternType 1/PaintType 2/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1/Resources<<>>', '0 0 1 1 re f') },
  ];
  const resources = '/Pattern<</R 160 0 R/G 161 0 R/U 162 0 R>>/ExtGState<</Clear<</ca 0>>>>';

  it('tells the fill pattern from the stroke pattern of one operation', () => {
    expect(colorants('/Pattern cs /R scn /Pattern CS /G SCN 0 0 10 10 re B', { resources, objects: SHADINGS }).slice(1, 3)).toStrictEqual([
      'Green spot p=stroke,pattern s= d=',
      'Red spot p=fill,pattern s= d=',
    ]);
  });

  it('reports the base of an uncoloured pattern that only clips as clip-only', () => {
    expect(colorants('/PU cs 1 /U scn 0 0 10 10 re W n', { resources, spaces: `/PU[/Pattern ${separation('Blue')}]`, objects: SHADINGS })[0]).toBe(
      'Blue spot p= s=clip-only d=resources',
    );
  });

  it('reports text at alpha 0 as invisible, in a pattern colour and in the procedures of Type 3 glyphs', () => {
    const glyphs: Array<TestObject> = [
      { number: 110, body: type3Font(SPACES) },
      { number: 111, body: streamBody('', '1000 0 d0 /CS2 cs 1 scn 0 0 750 750 re f') },
    ];
    const inGlyphs = colorants('/Clear gs BT /T3 12 Tf /CS1 cs 1 scn (a) Tj ET', {
      resources: `${resources}/Font<</T3 110 0 R>>`,
      objects: [...SHADINGS, ...glyphs],
    });
    const inPattern = colorants('/Clear gs BT /F1 12 Tf /Pattern cs /R scn (a) Tj ET', { resources, objects: SHADINGS });
    expect([inGlyphs, inPattern.find(line => line.startsWith('Red'))]).toStrictEqual([
      [
        'Gold spot p= s=invisible-text d=resources',
        'Green spot p= s= d=resources',
        'Red spot p= s= d=resources',
        'Silver spot p= s=invisible-text d=resources',
      ],
      'Red spot p= s=invisible-text d=resources',
    ]);
  });
});

describe('selected colorants', () => {
  it('reports a selection without a painting operator, invisible text and a path that only clips', () => {
    const alpha = '/ExtGState<</Clear<</ca 0>>>>';
    expect([
      colorants('/CS1 cs'),
      colorants('BT /F1 12 Tf 3 Tr /CS1 cs 1 scn (a) Tj ET'),
      colorants('/Clear gs BT /F1 12 Tf /CS1 cs 1 scn (a) Tj ET', { resources: alpha }),
      colorants('/CS1 cs 0 0 10 10 re W n'),
    ]).toStrictEqual([
      ['Gold spot p= s=colour-space-only d=resources', 'Silver spot p= s= d=resources'],
      ['Gold spot p= s=invisible-text d=resources', 'Silver spot p= s= d=resources'],
      ['Gold spot p= s=invisible-text d=resources', 'Silver spot p= s= d=resources'],
      ['Gold spot p= s=clip-only d=resources', 'Silver spot p= s= d=resources'],
    ]);
  });

  const group = streamBody(
    `/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency>>/Resources<<${SPACES}${FONT}>>`,
    'BT /F1 12 Tf /CS1 cs 1 scn (a) Tj ET',
  );
  const fixture: Fixture = {
    resources: '/ExtGState<</Clear<</ca 0>>/NoStroke<</CA 0/ca 1>>>>/XObject<</G1 170 0 R>>',
    objects: [{ number: 170, body: group }],
  };

  // ISO 32000-1:2008, 9.3.6, Table 106: modes 0, 2, 4 and 6 fill glyphs and modes 1, 2, 5 and 6 stroke them; 11.6.4.4: a group's results are painted at the fill alpha in force where it is drawn.
  it.each([
    ['a path filled at fill alpha 0', '/Clear gs /CS1 cs 1 scn 0 0 10 10 re f', ['Gold spot p=fill s= d=', SILVER_UNUSED]],
    ['text stroked at stroke alpha 0', '/NoStroke gs BT /F1 12 Tf 1 Tr /CS1 CS 1 SCN (a) Tj ET', ['Gold spot p= s=invisible-text d=resources', SILVER_UNUSED]],
    ['text filled at stroke alpha 0', '/NoStroke gs BT /F1 12 Tf /CS1 cs 1 scn (a) Tj ET', ['Gold spot p=text s= d=', SILVER_UNUSED]],
    [
      'text filled and stroked at stroke alpha 0',
      '/NoStroke gs BT /F1 12 Tf 2 Tr /CS1 cs 1 scn /CS2 CS 1 SCN (a) Tj ET',
      ['Gold spot p=text s= d=', 'Silver spot p= s=invisible-text d=resources'],
    ],
    ['text in a transparency group drawn at fill alpha 0', '/Clear gs /G1 Do', ['Gold spot p= s=invisible-text d=resources', SILVER_UNUSED]],
    ['text in a transparency group drawn at fill alpha 1', '/G1 Do', ['Gold spot p=text s= d=', SILVER_UNUSED]],
    ['text in render mode 7', 'BT /F1 12 Tf 7 Tr /CS1 cs 1 scn (a) Tj ET', ['Gold spot p= s=clip-only d=resources', SILVER_UNUSED]],
    ['an empty string in render mode 3', 'BT /F1 12 Tf 3 Tr /CS1 cs 1 scn () Tj ET', ['Gold spot p= s=colour-space-only d=resources', SILVER_UNUSED]],
  ])('tells painted from selected for %s', (_, content, expected) => {
    expect(colorants(content, fixture)).toStrictEqual(expected);
  });
});

describe('declared colorants', () => {
  it('reports colorants painted only inside a soft mask', () => {
    const objects: Array<TestObject> = [
      {
        number: 150,
        body: streamBody(
          `/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceGray>>/Resources<<${SPACES}>>`,
          '/CS2 cs 1 scn 0 0 10 10 re f',
        ),
      },
    ];
    expect(
      colorants('/Mask gs /CS1 cs 1 scn 0 0 10 10 re f', { resources: '/ExtGState<</Mask<</SMask<</S/Luminosity/G 150 0 R>>>>>>', objects }),
    ).toStrictEqual(['Gold spot p=fill s= d=', 'Silver spot p= s= d=resources,soft-mask']);
  });

  it('reports colorants an NChannel space lists without using them, and those a SeparationInfo names', () => {
    const nchannel = `[/DeviceN[/Gold]/DeviceCMYK ${TINT}<</Subtype/NChannel/Colorants<</Gold ${separation('Gold')}/Extra ${separation('Extra')}>>>>]`;
    // The device colorant and the colour space name different colorants, so that each entry is seen to be read.
    const info = `/SeparationInfo<</Pages[3 0 R]/DeviceColorant(Device)/ColorSpace ${separation('Space')}>>`;
    expect(colorants('/N1 cs 1 scn 0 0 10 10 re f', { spaces: `/N1 ${nchannel}`, entries: info })).toStrictEqual([
      'Device spot p= s= d=separation-info',
      'Extra spot p= s= d=nchannel-colorants',
      'Gold spot p=fill s= d=',
      'Silver spot p= s= d=resources',
      'Space spot p= s= d=separation-info',
    ]);
  });

  it('keeps every declared reason of a painted colorant', () => {
    const d1: Array<TestObject> = [
      { number: 110, body: type3Font(SPACES) },
      { number: 111, body: streamBody('', '1000 0 0 0 750 750 d1 /CS1 cs 0 0 750 750 re f') },
    ];
    expect(colorants('BT /T3 12 Tf /CS1 cs 1 scn (a) Tj ET', { resources: '/Font<</T3 110 0 R>>', objects: d1 })).toStrictEqual([
      'Gold spot p=fill,text,type3-glyph s= d=d1-glyph',
      'Silver spot p= s= d=resources',
    ]);
  });

  // ISO 32000-1:2008, 8.7.4.1: a shading pattern paints in its shading's colour space.
  it('declares the space of a shading pattern chosen in a d1 glyph', () => {
    const glyph: Array<TestObject> = [
      { number: 110, body: type3Font(`${SPACES}/Pattern<</P 151 0 R>>`) },
      { number: 111, body: streamBody('', '1000 0 0 0 750 750 d1 /Pattern cs /P scn 0 0 750 750 re f') },
      { number: 151, body: `<</PatternType 2/Shading<</ShadingType 2/ColorSpace ${separation('Shade')}/Coords[0 0 1 0]/Function ${TINT}>>>>` },
    ];
    expect(colorants('BT /T3 12 Tf /CS1 cs 1 scn (a) Tj ET', { resources: '/Font<</T3 110 0 R>>', objects: glyph })).toStrictEqual([
      'Gold spot p=fill,text,type3-glyph s= d=',
      'Shade spot p= s= d=resources,d1-glyph',
      SILVER_UNUSED,
    ]);
  });

  // ISO 32000-1:2008, 8.6.6.4 reserves All and None, and the process names are those of 8.6.6.5.
  it.each([
    ['Cyan', 'process'],
    ['Black', 'process'],
    ['All', 'all'],
    ['None', 'none'],
    ['Spot', 'spot'],
  ])('gives the SeparationInfo device colorant %s the kind %s', (name, kind) => {
    const lines = colorants('', { entries: `/SeparationInfo<</Pages[3 0 R]/DeviceColorant/${name}>>` });
    expect(lines.filter(line => line.startsWith(`${name} `))).toStrictEqual([`${name} ${kind} p= s= d=separation-info`]);
  });
});

describe('colorant names and kinds', () => {
  it('reports All, None and process separations with their kinds, and keeps escaped names as bytes', () => {
    const resources = `/ColorSpace<</A ${separation('All')}/N ${separation('None')}/C ${separation('Cyan')}/J ${separation('#E7#89#B9')}>>`;
    const [page] = pagesOf([{ content: '/A cs 1 scn 0 0 1 1 re f /N cs 1 scn 0 0 1 1 re f /C cs 1 scn 0 0 1 1 re f /J cs 1 scn 0 0 1 1 re f', resources }]);
    expect(page?.colorants.map(use => [[...use.name], use.kind])).toStrictEqual([
      [[...new TextEncoder().encode('All')], 'all'],
      [[...new TextEncoder().encode('Cyan')], 'process'],
      [[...new TextEncoder().encode('None')], 'none'],
      [[0xe7, 0x89, 0xb9], 'spot'],
    ]);
  });

  it('lists each distinct definition of a colorant', () => {
    const resources = `/ColorSpace<</A ${separation('Gold')}/B ${separation('Gold', '/DeviceRGB')}/C ${separation('Gold')}>>`;
    const [page] = pagesOf([{ content: '/A cs /B cs /C cs', resources }]);
    expect(page?.colorants.map(use => use.alternates.map(alternate => alternate.family))).toStrictEqual([['DeviceCMYK', 'DeviceRGB']]);
  });

  it('sorts names by their bytes, a name before the longer names it begins', () => {
    const resources = `/ColorSpace<</A ${separation('GoldX')}/B ${separation('#E7')}/C ${separation('Gold')}>>`;
    const [page] = pagesOf([{ content: '/A cs /B cs /C cs', resources }]);
    expect(page?.colorants.map(use => [...use.name])).toStrictEqual([[...latin1Bytes('Gold')], [...latin1Bytes('GoldX')], [0xe7]]);
  });
});

describe('damaged colour spaces', () => {
  const DAMAGED: TestObject = { number: 150, body: '<</A [ 1 2' };

  it('keeps colorants whose tint transform, listed colorants or neighbouring resources cannot be read', () => {
    const nchannel = `[/DeviceN[/Gold]/DeviceCMYK ${TINT}<</Subtype/NChannel/Colorants<</Gold ${separation('Gold')}/Extra 150 0 R>>>>]`;
    expect([
      colorants('/T cs 1 scn 0 0 1 1 re f', { spaces: '/T[/Separation/Tinted/DeviceCMYK 150 0 R]', objects: [DAMAGED] })[2],
      colorants('/N cs 1 scn 0 0 1 1 re f', { spaces: `/N ${nchannel}`, objects: [DAMAGED] })[1],
      colorants('', { spaces: '/Bad 150 0 R', objects: [DAMAGED] })[0],
    ]).toStrictEqual(['Tinted spot p=fill s= d=', 'Gold spot p=fill s= d=', 'Gold spot p= s= d=resources']);
  });

  it('goes on interpreting after a pattern that cannot be read is chosen where colours are ignored', () => {
    const glyph: Array<TestObject> = [
      { number: 110, body: type3Font(`${SPACES}/Pattern<</P 151 0 R>>`) },
      { number: 111, body: streamBody('', '1000 0 0 0 750 750 d1 /Pattern cs /P scn 0 0 750 750 re f') },
      { number: 151, body: '<</PatternType 150 0 R/Shading<<>>>>' },
      DAMAGED,
    ];
    expect(colorants('BT /T3 12 Tf /CS1 cs 1 scn (a) Tj ET', { resources: '/Font<</T3 110 0 R>>', objects: glyph })[0]).toBe(
      'Gold spot p=fill,text,type3-glyph s= d=',
    );
  });

  it.each([
    [
      'a tint transform that cannot be read',
      '/T cs 1 scn 0 0 1 1 re f',
      { spaces: '/T[/Separation/Tinted/DeviceCMYK 150 0 R]', objects: [DAMAGED] },
      false,
      ['colorspace-unreadable'],
    ],
    ['a DeviceN space that names All', '/D cs 1 1 scn 0 0 1 1 re f', { spaces: `/D[/DeviceN[/All/Gold]/DeviceCMYK ${TINT}]` }, true, ['devicen-all']],
    ['a SeparationInfo that cannot be read', '', { entries: '/SeparationInfo 150 0 R', objects: [DAMAGED] }, false, ['content-unreadable']],
    [
      'a graphics state resource that cannot be read and is never used',
      '',
      { resources: '/ExtGState<</G9 150 0 R>>', objects: [DAMAGED] },
      false,
      ['content-unreadable'],
    ],
  ])('reports %s, and whether the page was read completely', (_, content, fixture: Fixture, complete, codes) => {
    const page = firstPage(content, fixture);
    expect([page?.complete, page?.warnings.map(warning => warning.code)]).toStrictEqual([complete, codes]);
  });

  it('reports one damaged object that two colour spaces refer to once', () => {
    const page = firstPage('/T1 cs 1 scn 0 0 1 1 re f /T2 cs 1 scn 0 0 1 1 re f', {
      spaces: '/T1[/Separation/One/DeviceCMYK 150 0 R]/T2[/Separation/Two/DeviceCMYK 150 0 R]',
      objects: [DAMAGED],
    });
    expect(page?.warnings.map(warning => warning.code)).toStrictEqual(['colorspace-unreadable']);
  });
});

describe('pages', () => {
  it('reports the pages asked for, and says when a page could not be read completely', () => {
    const pages = pagesOf([
      { content: '/CS1 cs', resources: SPACES },
      { content: '/Missing cs 0 0 1 1 re f', resources: SPACES },
    ]);
    const [second] = listColorants(
      loadDocument(
        textPdfBytes({
          pages: [
            { content: '/CS1 cs', resources: SPACES },
            { content: '/Missing cs', resources: SPACES },
          ],
        }),
      ),
      {
        pages: [1],
      },
    );
    expect([pages.map(page => [page.page, page.complete]), second?.page, second?.warnings.map(warning => warning.code)]).toStrictEqual([
      [
        [0, true],
        [1, false],
      ],
      1,
      ['resource-missing'],
    ]);
  });

  it('refuses a page index that is not a page', () => {
    expect(() => listColorants(loadDocument(textPdfBytes({ pages: [{}] })), { pages: [1] })).toThrow(InvalidArgumentError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the page index %d', index => {
    expect(() => listColorants(loadDocument(textPdfBytes({ pages: [{}] })), { pages: [index] })).toThrow(InvalidArgumentError);
  });

  it('inspects no page for an empty list of pages', () => {
    expect(listColorants(loadDocument(textPdfBytes({ pages: [{ content: '/CS1 cs', resources: SPACES }] })), { pages: [] })).toStrictEqual([]);
  });

  it('refuses a value that is not a loaded document', () => {
    const source = loadDocument(textPdfBytes({ pages: [{}] }));
    expect(() => listColorants({ ...source })).toThrow(InvalidArgumentError);
  });

  it('refuses pages that is not an array of page indexes', () => {
    const document = loadDocument(textPdfBytes({ pages: [{}] }));
    for (const value of [5, '0', null, [0.5], ['0']]) {
      const options: ListColorantsOptions = {};
      Reflect.set(options, 'pages', value);
      expect(() => listColorants(document, options)).toThrow(InvalidArgumentError);
    }
  });
});

// The values of an order that a list holds, in that order and once each.
const inOrder = (values: ReadonlyArray<string>, order: ReadonlyArray<string>): Array<string> => order.filter(value => values.includes(value));

describe('properties', () => {
  // Operations over spot spaces, device spaces, an NChannel space with a listed colorant, alpha, text render modes, clipping, an image and a SeparationInfo.
  const OPERATIONS = [
    '/CS1 cs 1 scn',
    '/CS2 CS 1 SCN',
    '/D cs 1 1 scn',
    '/N cs 1 scn',
    '0 g',
    '0 0 10 10 re f',
    '0 0 m 10 10 l S',
    '0 0 10 10 re B',
    '0 0 10 10 re W n',
    'BT /F1 12 Tf (a) Tj ET',
    'BT /F1 12 Tf 2 Tr (a) Tj ET',
    'BT /F1 12 Tf 3 Tr (a) Tj ET',
    'BT /F1 12 Tf 7 Tr (a) Tj ET',
    '/Clear gs',
    '/Opaque gs',
    '/Im1 Do',
    'q /CS2 cs 1 scn 0 0 1 1 re f Q',
  ];
  const RESOURCES = [
    `/ColorSpace<</CS1 ${separation('Gold')}/CS2 ${separation('Silver')}/D[/DeviceN[/Bronze/Cyan]/DeviceCMYK ${TINT}]`,
    `/N[/DeviceN[/Gold]/DeviceCMYK ${TINT}<</Subtype/NChannel/Colorants<</Gold ${separation('Gold')}/Extra ${separation('Extra')}>>>>]`,
    `/DefaultGray ${separation('Ink')}/Unused ${separation('Unused')}>>`,
    `/ExtGState<</Clear<</ca 0/CA 0>>/Opaque<</ca 1/CA 1>>>>/XObject<</Im1 120 0 R>>${FONT}`,
  ].join('');
  const OBJECTS: ReadonlyArray<TestObject> = [{ number: 120, body: imageObject(separation('Image')) }];
  const page = fc.record({
    content: fc.array(fc.constantFrom(...OPERATIONS), { maxLength: 12 }).map(operations => operations.join(' ')),
    info: fc.constantFrom('', `/SeparationInfo<</Pages[3 0 R]/DeviceColorant/Gold/ColorSpace ${separation('Plate')}>>`),
  });
  const PAINTED = ['fill', 'stroke', 'text', 'image', 'image-mask', 'inline-image', 'shading', 'pattern', 'type3-glyph', 'annotation'];
  const SELECTED = ['colour-space-only', 'invisible-text', 'clip-only'];
  const DECLARED = ['resources', 'soft-mask', 'd1-glyph', 'uncoloured-pattern', 'annotation-not-printed', 'nchannel-colorants', 'separation-info'];

  it('lists each colorant once in byte order, with consistent painted, selected and declared lists', () => {
    fc.assert(
      fc.property(page, ({ content, info }) => {
        const [result] = pagesOf([{ content, resources: RESOURCES, entries: info }], OBJECTS);
        const uses = result?.colorants ?? [];
        const names = uses.map(use => latin1Text(use.name));
        // Latin-1 text compares by code unit, which is byte order.
        expect([...new Set(names)].toSorted((left, right) => (left < right ? -1 : 1))).toStrictEqual(names);
        for (const { painted, selected, declared } of uses) {
          expect([painted, selected, declared]).toStrictEqual([inOrder(painted, PAINTED), inOrder(selected, SELECTED), inOrder(declared, DECLARED)]);
          expect(painted.length > 0 && declared.includes('resources')).toBe(false);
          expect(selected.includes('colour-space-only') && (painted.length > 0 || selected.length > 1)).toBe(false);
        }
      }),
    );
  });

  it('reports the pages asked for in the order asked, each as the whole document reports it', () => {
    const pages: ReadonlyArray<TestPage> = [
      { content: '/CS1 cs 1 scn 0 0 10 10 re f', resources: RESOURCES },
      { content: 'BT /F1 12 Tf 3 Tr /CS2 cs 1 scn (a) Tj ET', resources: RESOURCES },
      { content: '/Missing cs /Im1 Do', resources: RESOURCES },
    ];
    const document = loadDocument(textPdfBytes({ pages, objects: OBJECTS }));
    const whole = listColorants(document);
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }), indexes => {
        expect(listColorants(document, { pages: indexes })).toStrictEqual(indexes.map(index => whole[index]));
      }),
    );
  });
});

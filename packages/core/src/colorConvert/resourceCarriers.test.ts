import type { LoadedDocument, LoadOptions } from '../document/loadDocument.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { ShadingConversionReport } from './convertShadings.ts';
import type { CarrierSeen, ResourceCarrier } from './resourceCarriers.ts';

import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertIndexedSpaces } from './convertIndexed.ts';
import { convertShadings } from './convertShadings.ts';
import { convertSpotSpaces } from './convertSpots.ts';
import { convertToCmyk } from './convertToCmyk.ts';
import { carrierSeen, resourceCarriers } from './resourceCarriers.ts';

const source = parseIccProfile(srgbBytes);
const destination = parseIccProfile(fograBytes);
const rgbTransform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });

const PATTERN = '/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10';
const TYPE3 =
  '/Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</A 6 0 R>>/Encoding<</Type/Encoding/Differences[65/A]>>/FirstChar 65/LastChar 65/Widths[1000]';
const OWN_INDEXED = '/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 0 <ff8040>]>>>>';
const OWN_SPOT = '/Resources<</ColorSpace<</CS1[/Separation/Spot/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[1 0 0]/N 1>>]>>>>';
const OWN_SHADING =
  '/Resources<</Shading<</Sh1<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>>>>>>>';
const FULL_OPTIONS = { sourceRgbProfile: srgbBytes, outputProfile: fograBytes, outputIntent: { outputConditionIdentifier: 'FOGRA28' } } as const;

const carrierPdf = (page: string, objects: ReadonlyArray<TestObject>, content = '0 0 1 1 re f', options: LoadOptions = {}): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R${page}>>` },
          { number: 4, body: streamBody('', content) },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
    options,
  );

const cmykOf = (...rgb: ReadonlyArray<number>): Float64Array => {
  const output = new Float64Array(4);
  rgbTransform.convert(Float64Array.from(rgb), output);
  return output;
};

const close = (actual: ReadonlyArray<number>, expected: Float64Array): boolean =>
  actual.length === expected.length && actual.every((value, index) => Math.abs(value - (expected[index] ?? Number.NaN)) <= 0.005);

// ISO 32000-1:2008, 8.6.6.3: one lookup entry per index, each holding one colour in the base space.
const lookupOf = (rgb: ReadonlyArray<number>): Uint8Array => {
  const output = new Uint8Array((rgb.length / 3) * 4);
  rgbTransform.convertRow8(Uint8Array.from(rgb), output, rgb.length / 3);
  return output;
};

const decodedObject = (document: LoadedDocument, object: PdfObject): PdfObject => {
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('document internals are missing');
  }
  if (object.kind !== 'stream') {
    return object;
  }
  const data = decodedData(internals, object);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return { kind: 'stream', dictionary: object.dictionary, data };
};

const functionOf = (document: LoadedDocument, value: PdfDirectObject | undefined): PdfFunction => {
  if (value === undefined) {
    throw new Error('function is missing');
  }
  const resolve = (item: PdfDirectObject): PdfObject => decodedObject(document, item.kind === 'reference' ? document.get(item) : item);
  return createPdfFunction(resolve(value), resolve);
};

const deref = (document: LoadedDocument, value: PdfDirectObject | undefined): PdfObject | undefined => internalsOf(document)?.objects.deref(value);

const entriesOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') {
    return value.entries;
  }
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const ownResource = (document: LoadedDocument, owner: number, category: string, name: string): PdfObject | undefined => {
  const resources = entriesOf(deref(document, entriesOf(document.get(pdfReference(owner, 0)))?.get(pdfName('Resources').bytes)));
  return deref(document, entriesOf(deref(document, resources?.get(pdfName(category).bytes)))?.get(pdfName(name).bytes));
};

const indexedLookup = (space: PdfObject | undefined) => {
  const [, base, , lookup] = space?.kind === 'array' ? space.items : [];
  if (base?.kind !== 'name' || lookup?.kind !== 'string') {
    throw new Error('Indexed space is missing');
  }
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes };
};

const expectIndexed = (space: PdfObject | undefined): void => {
  expect(indexedLookup(space)).toStrictEqual({ base: 'DeviceCMYK', lookup: lookupOf([255, 128, 64]) });
};

const expectSpot = (document: LoadedDocument, space: PdfObject | undefined): void => {
  const items = space?.kind === 'array' ? space.items : [];
  const tint = functionOf(document, items.at(3));
  expect(items.at(2)).toStrictEqual(pdfName('DeviceCMYK'));
  expect([close(tint([0]), cmykOf(1, 1, 1)), close(tint([1]), cmykOf(1, 0, 0))]).toStrictEqual([true, true]);
};

const expectShading = (document: LoadedDocument, shading: PdfObject | undefined): void => {
  if (shading?.kind !== 'dictionary') {
    throw new Error('carrier shading is missing');
  }
  const evaluate = functionOf(document, shading.entries.get(pdfName('Function').bytes));
  expect(shading.entries.get(pdfName('ColorSpace').bytes)).toStrictEqual(pdfName('DeviceCMYK'));
  expect([close(evaluate([0]), cmykOf(1, 0, 0)), close(evaluate([1]), cmykOf(0, 0, 1))]).toStrictEqual([true, true]);
};

const streamText = (document: LoadedDocument, number: number): string => {
  const stream = decodedObject(document, document.get(pdfReference(number, 0)));
  if (stream.kind !== 'stream') {
    throw new Error('stream is missing');
  }
  return latin1Text(stream.data);
};

/** The carriers each pass reaches; `own` is the resource dictionary text the carrier holds and `paint` the operators that use it. */
const carriers = (own: string, paint: string) => [
  {
    carrier: 'a tiling pattern',
    page: '/Resources<</Pattern<</P 5 0 R>>>>',
    objects: [{ number: 5, body: streamBody(`${PATTERN}${own}`, paint) }],
    owner: 5,
  },
  {
    carrier: 'a Type 3 font',
    page: '/Resources<</Font<</F 5 0 R>>>>',
    objects: [
      { number: 5, body: `<<${TYPE3}${own}>>` },
      { number: 6, body: streamBody('', `1000 0 d0 ${paint} 0 0 500 500 re f`) },
    ],
    owner: 5,
  },
  {
    carrier: 'an appearance stream',
    page: '/Resources<<>>/Annots[5 0 R]',
    objects: [
      { number: 5, body: '<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/AP<</N 6 0 R>>>>' },
      { number: 6, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]${own}`, paint) },
    ],
    owner: 6,
  },
  {
    carrier: 'an appearance subdictionary state',
    page: '/Resources<<>>/Annots[5 0 R]',
    objects: [
      { number: 5, body: '<</Type/Annot/Subtype/Widget/Rect[0 0 10 10]/AS/On/AP<</D<</On 6 0 R>>>>>>' },
      { number: 6, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]${own}`, paint) },
    ],
    owner: 6,
  },
  {
    carrier: 'a form that only a tiling pattern uses',
    page: '/Resources<</Pattern<</P 5 0 R>>>>',
    objects: [
      { number: 5, body: streamBody(`${PATTERN}/Resources<</XObject<</Fm 6 0 R>>>>`, '/Fm Do') },
      { number: 6, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]${own}`, paint) },
    ],
    owner: 6,
  },
  {
    carrier: 'a form that only a Type 3 glyph uses',
    page: '/Resources<</Font<</F 5 0 R>>>>',
    objects: [
      { number: 5, body: `<<${TYPE3}/Resources<</XObject<</Fm 7 0 R>>>>>>` },
      { number: 6, body: streamBody('', '1000 0 d0 /Fm Do') },
      { number: 7, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]${own}`, paint) },
    ],
    owner: 7,
  },
  {
    carrier: 'a form that only an appearance uses',
    page: '/Resources<<>>/Annots[5 0 R]',
    objects: [
      { number: 5, body: '<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/AP<</N 6 0 R>>>>' },
      { number: 6, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</XObject<</Fm 7 0 R>>>>', '/Fm Do') },
      { number: 7, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]${own}`, paint) },
    ],
    owner: 7,
  },
];

// ISO 32000-1:2008, 7.8.3: a pattern, a Type 3 font, an appearance stream and a form each name resources in their own resource dictionary.
describe('Indexed spaces in resource carriers', () => {
  it.each(carriers(OWN_INDEXED, '/CS1 cs 0 sc'))('converts a lookup in the own Resources of $carrier', ({ page, objects, owner }) => {
    const document = carrierPdf(page, objects);
    expect(convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(1);
    expectIndexed(ownResource(document, owner, 'ColorSpace', 'CS1'));
  });

  it('converts a tiling pattern reached from the page and from a form once, and stops at a pattern that names itself', () => {
    const document = carrierPdf('/Resources<</Pattern<</P 5 0 R>>/XObject<</Fm 6 0 R>>>>', [
      { number: 5, body: streamBody(`${PATTERN}/Resources<</Pattern<</Self 5 0 R>>/ColorSpace<</CS1[/Indexed/DeviceRGB 0 <ff8040>]>>>>`, '/CS1 cs 0 sc') },
      { number: 6, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</Pattern<</P 5 0 R>>>>', '/Pattern cs /P scn 0 0 10 10 re f') },
    ]);
    expect(convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(1);
    expectIndexed(ownResource(document, 5, 'ColorSpace', 'CS1'));
  });

  it('converts a tiling pattern lookup without changing its painted index when the whole document is converted', () => {
    const document = carrierPdf(
      '/Resources<</Pattern<</P 5 0 R>>>>',
      [{ number: 5, body: streamBody(`${PATTERN}${OWN_INDEXED}`, '/CS1 cs 0 sc 0 0 10 10 re f') }],
      '/Pattern cs /P scn 0 0 100 100 re f',
    );
    expect(convertToCmyk(document, FULL_OPTIONS).indexed.indexed).toBe(1);
    expectIndexed(ownResource(document, 5, 'ColorSpace', 'CS1'));
    expect(streamText(document, 5)).toBe('/CS1 cs 0 sc 0 0 10 10 re f');
  });

  it('converts an appearance stream lookup when the whole document is converted and saved', () => {
    const document = carrierPdf('/Resources<<>>/Annots[5 0 R]', [
      { number: 5, body: '<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/F 4/AP<</N 6 0 R>>>>' },
      { number: 6, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]${OWN_INDEXED}`, '/CS1 cs 0 sc 0 0 10 10 re f 0 1 0 rg 0 0 5 5 re f') },
    ]);
    const report = convertToCmyk(document, FULL_OPTIONS);
    const reloaded = loadDocument(document.save().toBytes());
    expect(report.indexed.indexed).toBe(1);
    expectIndexed(ownResource(reloaded, 6, 'ColorSpace', 'CS1'));
  });
});

describe('spot spaces in resource carriers', () => {
  it.each(carriers(OWN_SPOT, '/CS1 cs 1 scn'))('converts a Separation alternate in the own Resources of $carrier', ({ page, objects, owner }) => {
    const document = carrierPdf(page, objects);
    expect(convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).separations).toBe(1);
    expectSpot(document, ownResource(document, owner, 'ColorSpace', 'CS1'));
  });

  it('converts a tiling pattern Separation alternate when the whole document is converted', () => {
    const document = carrierPdf(
      '/Resources<</Pattern<</P 5 0 R>>>>',
      [{ number: 5, body: streamBody(`${PATTERN}${OWN_SPOT}`, '/CS1 cs 1 scn 0 0 10 10 re f') }],
      '/Pattern cs /P scn 0 0 100 100 re f',
    );
    expect(convertToCmyk(document, FULL_OPTIONS).spots.separations).toBe(1);
    expectSpot(document, ownResource(document, 5, 'ColorSpace', 'CS1'));
  });

  it('converts a Type 3 font Separation alternate when the whole document is converted and saved', () => {
    const document = carrierPdf(
      '/Resources<</Font<</F 5 0 R>>>>',
      [
        { number: 5, body: `<<${TYPE3}${OWN_SPOT}>>` },
        { number: 6, body: streamBody('', '1000 0 d0 /CS1 cs 1 scn 0 0 500 500 re f') },
      ],
      'BT /F 12 Tf 10 10 Td (A) Tj ET',
    );
    const report = convertToCmyk(document, FULL_OPTIONS);
    const reloaded = loadDocument(document.save().toBytes());
    expect(report.spots.separations).toBe(1);
    expectSpot(reloaded, ownResource(reloaded, 5, 'ColorSpace', 'CS1'));
  });
});

describe('direct shadings in resource carriers', () => {
  it.each(carriers(OWN_SHADING, '/Sh1 sh'))('converts a direct shading in the own Resources of $carrier', ({ page, objects, owner }) => {
    const document = carrierPdf(page, objects);
    expect(convertShadings(document, { sourceRgbProfile: source, outputProfile: destination }).shadings).toBe(1);
    expectShading(document, ownResource(document, owner, 'Shading', 'Sh1'));
  });

  it('converts a direct shading in a tiling pattern when the whole document is converted', () => {
    const document = carrierPdf(
      '/Resources<</Pattern<</P 5 0 R>>>>',
      [{ number: 5, body: streamBody(`${PATTERN}${OWN_SHADING}`, '/Sh1 sh') }],
      '/Pattern cs /P scn 0 0 100 100 re f',
    );
    expect(convertToCmyk(document, FULL_OPTIONS).shadings.shadings).toBe(1);
    expectShading(document, ownResource(document, 5, 'Shading', 'Sh1'));
  });
});

const INDEXED = '[/Indexed/DeviceRGB 0 <ff8040>]';
const SPOT = '[/Separation/Spot/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[1 0 0]/N 1>>]';
const SHADING = '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>>>';
const GLYPH = { number: 6, body: streamBody('', '1000 0 d0 0 0 500 500 re f') };

/** Follows dictionary keys from an indirect object, dereferencing each step. */
const at = (document: LoadedDocument, owner: number, keys: ReadonlyArray<string>): PdfObject | undefined =>
  keys.reduce<PdfObject | undefined>((value, key) => deref(document, entriesOf(value)?.get(pdfName(key).bytes)), document.get(pdfReference(owner, 0)));

const passes = [
  {
    pass: 'Indexed',
    category: 'ColorSpace',
    value: INDEXED,
    convert: (document: LoadedDocument) => convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed,
    check: (_document: LoadedDocument, value: PdfObject | undefined) => {
      expectIndexed(value);
    },
  },
  {
    pass: 'spot',
    category: 'ColorSpace',
    value: SPOT,
    convert: (document: LoadedDocument) => convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).separations,
    check: expectSpot,
  },
  {
    pass: 'shading',
    category: 'Shading',
    value: SHADING,
    convert: (document: LoadedDocument) => convertShadings(document, { sourceRgbProfile: source, outputProfile: destination }).shadings,
    check: expectShading,
  },
];

const directFont = (category: string, value: string, extra = ''): string => `<<${TYPE3}/Resources<</${category}<</X1 ${value}>>${extra}>>>>`;

/** Holders of a direct Type 3 font that each also hold an entry X0 of their own, so a replacement that drops either one shows. */
const fontHolders = (category: string, value: string) =>
  [
    {
      holder: 'a page',
      page: `/Resources<</${category}<</X0 ${value}>>/Font<</F ${directFont(category, value)}>>>>`,
      objects: [GLYPH],
      paths: [
        [3, ['Resources', category, 'X0']],
        [3, ['Resources', 'Font', 'F', 'Resources', category, 'X1']],
      ],
    },
    {
      holder: 'a form',
      page: '/Resources<</XObject<</Fm 5 0 R>>>>',
      objects: [
        GLYPH,
        {
          number: 5,
          body: streamBody(
            `/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</${category}<</X0 ${value}>>/Font<</F ${directFont(category, value)}>>>>`,
            '',
          ),
        },
      ],
      paths: [
        [5, ['Resources', category, 'X0']],
        [5, ['Resources', 'Font', 'F', 'Resources', category, 'X1']],
      ],
    },
    {
      holder: 'an indirect Font category',
      page: `/Resources<</${category}<</X0 ${value}>>/Font 5 0 R>>`,
      objects: [GLYPH, { number: 5, body: `<</F ${directFont(category, value)}>>` }],
      paths: [
        [3, ['Resources', category, 'X0']],
        [3, ['Resources', 'Font', 'F', 'Resources', category, 'X1']],
      ],
    },
    {
      holder: 'another direct Type 3 font',
      page: `/Resources<</Font<</F <<${TYPE3}/Resources<</${category}<</X0 ${value}>>/Font<</G ${directFont(category, value)}>>>>>>>>>>`,
      objects: [GLYPH],
      paths: [
        [3, ['Resources', 'Font', 'F', 'Resources', category, 'X0']],
        [3, ['Resources', 'Font', 'F', 'Resources', 'Font', 'G', 'Resources', category, 'X1']],
      ],
    },
  ] as const;

describe('direct Type 3 fonts', () => {
  it.each(passes.flatMap(pass => fontHolders(pass.category, pass.value).map(holder => ({ ...pass, ...holder }))))(
    'converts the $pass entry of a direct Type 3 font in $holder and keeps the holder entry converted',
    ({ convert, check, page, objects, paths }) => {
      // ISO 32000-1:2008, Table 112: a Type 3 font dictionary holds the Resources its glyph descriptions name, wherever the font dictionary itself is stored.
      const document = carrierPdf(page, objects);
      expect(convert(document)).toBe(2);
      for (const [owner, keys] of paths) {
        check(document, at(document, owner, keys));
      }
    },
  );

  it('converts the resources and glyph colours of a direct Type 3 font when the whole document is converted and saved', () => {
    const document = carrierPdf(
      `/Resources<</ColorSpace<</X0 ${INDEXED}>>/Font<</F <<${TYPE3}/Resources<</ColorSpace<</CS1 ${INDEXED}/Sp ${SPOT}>>/Shading<</Sh1 ${SHADING}>>>>>>>>>>`,
      [{ number: 6, body: streamBody('', '1000 0 d0 /CS1 cs 0 sc 0 0 500 500 re f /Sp cs 1 scn 0 0 5 5 re f /Sh1 sh 0 1 0 rg 0 0 5 5 re f') }],
      '/X0 cs 0 sc 0 0 10 10 re f BT /F 12 Tf 10 10 Td (A) Tj ET',
    );
    const report = convertToCmyk(document, FULL_OPTIONS);
    const reloaded = loadDocument(document.save().toBytes());
    const font = ['Resources', 'Font', 'F', 'Resources'];
    expect([report.indexed.indexed, report.spots.separations, report.shadings.shadings, report.otherCarriers.glyphs]).toStrictEqual([2, 1, 1, 1]);
    expectIndexed(at(reloaded, 3, ['Resources', 'ColorSpace', 'X0']));
    expectIndexed(at(reloaded, 3, [...font, 'ColorSpace', 'CS1']));
    expectSpot(reloaded, at(reloaded, 3, [...font, 'ColorSpace', 'Sp']));
    expectShading(reloaded, at(reloaded, 3, [...font, 'Shading', 'Sh1']));
    const glyph = /^1000 0 d0 \/CS1 cs 0 sc 0 0 500 500 re f \/Sp cs 1 scn 0 0 5 5 re f \/Sh1 sh (\S+) (\S+) (\S+) (\S+) k 0 0 5 5 re f$/u.exec(
      streamText(reloaded, 6),
    );
    expect(close((glyph?.slice(1) ?? []).map(Number), cmykOf(0, 1, 0))).toBe(true);
  });
});

describe('Type 3 fonts that a graphics state selects', () => {
  // ISO 32000-1:2008, Table 58: a graphics state parameter dictionary's Font entry is an array whose first element is an indirect reference to a font dictionary.
  const page = '/Resources<</ExtGState<</GS1 7 0 R>>>>';
  const state = { number: 7, body: '<</Type/ExtGState/Font[5 0 R 12]>>' };

  it.each(passes)('converts the $pass entry of a Type 3 font reached only through a graphics state', ({ category, value, convert, check }) => {
    const document = carrierPdf(page, [state, GLYPH, { number: 5, body: directFont(category, value) }], '/GS1 gs BT (A) Tj ET');
    expect(convert(document)).toBe(1);
    check(document, ownResource(document, 5, category, 'X1'));
  });

  it('converts the resources and glyph colours of a Type 3 font reached only through a graphics state when the whole document is converted', () => {
    const document = carrierPdf(
      page,
      [
        state,
        { number: 5, body: directFont('ColorSpace', INDEXED) },
        { number: 6, body: streamBody('', '1000 0 d0 /X1 cs 0 sc 0 0 500 500 re f 0 1 0 rg 0 0 5 5 re f') },
      ],
      '/GS1 gs BT (A) Tj ET',
    );
    const report = convertToCmyk(document, FULL_OPTIONS);
    expect([report.indexed.indexed, report.otherCarriers.glyphs]).toStrictEqual([1, 1]);
    expectIndexed(ownResource(document, 5, 'ColorSpace', 'X1'));
    const glyph = /^1000 0 d0 \/X1 cs 0 sc 0 0 500 500 re f (\S+) (\S+) (\S+) (\S+) k 0 0 5 5 re f$/u.exec(streamText(document, 6));
    expect(close((glyph?.slice(1) ?? []).map(Number), cmykOf(0, 1, 0))).toBe(true);
  });
});

describe('deeply nested carriers', () => {
  it('converts a lookup in the innermost of 5,000 nested tiling patterns', () => {
    const depth = 5000;
    const objects = Array.from({ length: depth }, (_, index) => ({
      number: 5 + index,
      body: streamBody(`${PATTERN}${index === depth - 1 ? OWN_INDEXED : `/Resources<</Pattern<</P ${String(6 + index)} 0 R>>>>`}`, '/CS1 cs 0 sc'),
    }));
    const document = carrierPdf('/Resources<</Pattern<</P 5 0 R>>>>', objects);
    expect(convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(1);
    expectIndexed(ownResource(document, 4 + depth, 'ColorSpace', 'CS1'));
  });
});

const sampled = (document: LoadedDocument, owner: number, keys: ReadonlyArray<string>): ReadonlyArray<number> => {
  const shading = at(document, owner, keys);
  return functionOf(document, shading?.kind === 'dictionary' ? shading.entries.get(pdfName('Function').bytes) : undefined)([0.5]);
};

describe('rendering intents of direct shadings in resource carriers', () => {
  const directCarrier = {
    carrier: 'a direct Type 3 font',
    page: `/Resources<</Font<</F <<${TYPE3}${OWN_SHADING}>>>>>>`,
    objects: [{ number: 6, body: streamBody('', '1000 0 d0 /Perceptual ri /Sh1 sh') }],
    owner: 3,
    keys: ['Resources', 'Font', 'F', 'Resources', 'Shading', 'Sh1'],
  };
  const cases = [...carriers(OWN_SHADING, '/Perceptual ri /Sh1 sh').map(item => ({ ...item, keys: ['Resources', 'Shading', 'Sh1'] })), directCarrier];

  it.each(cases)('samples a shading in $carrier with the intent its content selects', ({ page, objects, owner, keys }) => {
    // ISO 32000-1:2008, 8.6.5.8: the ri operator sets the rendering intent that colour conversion of later painting uses.
    const converted = (intent: 'document' | 'perceptual' | 'relativeColorimetric'): ReadonlyArray<number> => {
      const document = carrierPdf(page, objects);
      convertShadings(document, { sourceRgbProfile: source, outputProfile: destination, intent });
      return sampled(document, owner, keys);
    };
    expect(converted('perceptual')).not.toStrictEqual(converted('relativeColorimetric'));
    expect(converted('document')).toStrictEqual(converted('perceptual'));
  });
});

const glyphFont = (charProcs: number, rest: string): string =>
  `<<${TYPE3.replace('/CharProcs<</A 6 0 R>>', `/CharProcs<</A ${String(charProcs)} 0 R>>`)}${rest}>>`;

/** Direct Type 3 fonts whose resources are reached again through an indirect object, so a walk that expands each path separately never ends or repeats work. */
const sharedFonts = (category: string, value: string) => {
  const depth = 25;
  const fanOut = Array.from({ length: depth }, (_, index) => {
    const next = index === depth - 1 ? '' : `/Font<</F <<${TYPE3}/Resources ${String(8 + index)} 0 R>>/G <<${TYPE3}/Resources ${String(8 + index)} 0 R>>>>`;
    return { number: 7 + index, body: `<</${category}<</X1 ${value}>>${next}>>` };
  });
  return [
    {
      shape: 'names its own Resources',
      page: '/Resources 7 0 R',
      objects: [GLYPH, { number: 7, body: `<</${category}<</X1 ${value}>>/Font<</F <<${TYPE3}/Resources 7 0 R>>>>>>` }],
      count: 2,
      paths: [
        [3, ['Resources', category, 'X1']],
        [3, ['Resources', 'Font', 'F', 'Resources', category, 'X1']],
        [3, ['Resources', 'Font', 'F', 'Resources', 'Font', 'F', 'Resources', category, 'X1']],
      ],
    },
    {
      shape: `shares Resources over ${String(depth)} levels`,
      page: '/Resources 7 0 R',
      objects: [GLYPH, ...fanOut],
      count: depth,
      // Each level is reached from the page through F at every level above it and through G at its own.
      paths: fanOut.map(
        (_, level) =>
          [
            3,
            [
              'Resources',
              ...Array.from({ length: Math.max(0, level - 1) }, () => ['Font', 'F', 'Resources']).flat(),
              ...(level === 0 ? [] : ['Font', 'G', 'Resources']),
              category,
              'X1',
            ],
          ] as const,
      ),
    },
  ] as const;
};

/** Holders that share the dictionary a direct Type 3 font lives in or names, where converting only the first holder leaves the others unconverted. */
const sharingHolders = (category: string, value: string) =>
  [
    {
      holder: 'two fonts share Resources',
      page: `/Resources<</Font<</F <<${TYPE3}/Resources 7 0 R>>/G <<${TYPE3}/Resources 7 0 R>>>>>>`,
      objects: [GLYPH, { number: 7, body: `<</${category}<</X1 ${value}>>>>` }],
      paths: [
        [3, ['Resources', 'Font', 'F', 'Resources', category, 'X1']],
        [3, ['Resources', 'Font', 'G', 'Resources', category, 'X1']],
      ],
    },
    {
      holder: 'fonts nest through Resources',
      page: `/Resources<</Font<</F <<${TYPE3}/Resources 7 0 R>>>>>>`,
      objects: [GLYPH, { number: 7, body: `<</Font<</G <<${TYPE3}/Resources 8 0 R>>>>>>` }, { number: 8, body: `<</${category}<</X1 ${value}>>>>` }],
      paths: [[3, ['Resources', 'Font', 'F', 'Resources', 'Font', 'G', 'Resources', category, 'X1']]],
    },
    {
      holder: 'a page and form share a Font category',
      page: '/Resources<</Font 7 0 R/XObject<</Fm 8 0 R>>>>',
      objects: [
        GLYPH,
        { number: 7, body: `<</F ${directFont(category, value)}>>` },
        { number: 8, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</Font 7 0 R>>', '') },
      ],
      paths: [
        [3, ['Resources', 'Font', 'F', 'Resources', category, 'X1']],
        [8, ['Resources', 'Font', 'F', 'Resources', category, 'X1']],
      ],
    },
  ] as const;

type Intent = 'document' | 'perceptual' | 'relativeColorimetric';

/** Converts the shading of two direct Type 3 fonts that share one indirect Resources, where only the second font's glyph paints it. */
const sharedShadingSample = (intent: Intent): ReadonlyArray<number> => {
  const document = carrierPdf(`/Resources<</Font<</F ${glyphFont(6, '/Resources 7 0 R')}/G ${glyphFont(8, '/Resources 7 0 R')}>>>>`, [
    GLYPH,
    { number: 7, body: `<</Shading<</Sh1 ${SHADING}>>>>` },
    { number: 8, body: streamBody('', '1000 0 d0 /Perceptual ri /Sh1 sh') },
  ]);
  convertShadings(document, { sourceRgbProfile: source, outputProfile: destination, intent });
  return sampled(document, 3, ['Resources', 'Font', 'G', 'Resources', 'Shading', 'Sh1']);
};

describe('direct Type 3 fonts reached again through an indirect object', () => {
  it.each(passes.flatMap(pass => sharedFonts(pass.category, pass.value).map(shape => ({ ...pass, ...shape }))))(
    'converts the $pass entries of a direct Type 3 font that $shape once each',
    ({ convert, check, page, objects, count, paths }) => {
      const document = carrierPdf(page, objects);
      expect(convert(document)).toBe(count);
      for (const [owner, keys] of paths) {
        check(document, at(document, owner, keys));
      }
    },
  );

  it.each(sharedFonts('ColorSpace', INDEXED))(
    'converts and saves a whole document with a direct Type 3 font that $shape',
    ({ page, objects, count, paths }) => {
      const document = carrierPdf(page, objects, 'BT /F 12 Tf 10 10 Td (A) Tj ET');
      expect(convertToCmyk(document, FULL_OPTIONS).indexed.indexed).toBe(count);
      const reloaded = loadDocument(document.save().toBytes());
      for (const [owner, keys] of paths) {
        expectIndexed(at(reloaded, owner, keys));
      }
    },
  );

  it.each(passes.flatMap(pass => sharingHolders(pass.category, pass.value).map(holder => ({ ...pass, ...holder }))))(
    'converts the shared $pass entry once for every holder when $holder',
    ({ convert, check, page, objects, paths }) => {
      const document = carrierPdf(page, objects);
      expect(convert(document)).toBe(1);
      for (const [owner, keys] of paths) {
        check(document, at(document, owner, keys));
      }
    },
  );

  it('lists a direct Type 3 font once when it sits in the indirect Font category its own Resources names', () => {
    const document = carrierPdf(`/Resources<</Font 7 0 R>>`, [
      GLYPH,
      { number: 7, body: `<</F <<${TYPE3}/Resources<</ColorSpace<</X1 ${INDEXED}>>/Font 7 0 R>>>>>>` },
    ]);
    const internals = internalsOf(document);
    if (internals === undefined) {
      throw new Error('document internals are missing');
    }
    const listed = resourceCarriers(internals, { index: 0, reference: pdfReference(3, 0), resources: document.page(0).resources() }, carrierSeen());
    expect(listed.map(carrier => carrier.owner)).toStrictEqual([{ kind: 'category', reference: pdfReference(7, 0), name: pdfName('F').bytes }]);
  });

  it('converts the shading of a direct Type 3 font whose indirect Resources a luminosity soft-mask group also names', () => {
    const document = carrierPdf(
      `/Resources<</ExtGState<</GS1 9 0 R>>/Font<</F <<${TYPE3}/Resources 7 0 R>>>>>>`,
      [
        GLYPH,
        { number: 7, body: `<</Shading<</Sh1 ${SHADING}>>>>` },
        { number: 8, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources 7 0 R', '/Sh1 sh') },
        { number: 9, body: '<</Type/ExtGState/SMask<</S/Luminosity/G 8 0 R>>>>' },
      ],
      '/GS1 gs 0 0 10 10 re f BT /F 12 Tf 10 10 Td (A) Tj ET',
    );
    expect(convertToCmyk(document, FULL_OPTIONS).groups.groups).toBe(1);
    expectShading(document, at(document, 3, ['Resources', 'Font', 'F', 'Resources', 'Shading', 'Sh1']));
  });

  it('samples a shared direct shading with the intent a glyph of the second font selects', () => {
    expect(sharedShadingSample('perceptual')).not.toStrictEqual(sharedShadingSample('relativeColorimetric'));
    expect(sharedShadingSample('document')).toStrictEqual(sharedShadingSample('perceptual'));
  });
});

/** A page that paints indirect shading 7 after selecting Perceptual and then shows a Type 3 glyph whose content follows d0 and whose font names the same shading and a form Fm that paints it. */
const glyphShadingPdf = (glyph: string): LoadedDocument =>
  carrierPdf(
    '/Resources<</Shading<</Sh 7 0 R>>/Font<</F 5 0 R>>>>',
    [
      { number: 5, body: `<<${TYPE3}/Resources<</Shading<</Sh 7 0 R>>/XObject<</Fm 8 0 R>>>>>>` },
      { number: 6, body: streamBody('', `1000 0 d0 ${glyph}`) },
      { number: 7, body: SHADING },
      { number: 8, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '/Sh sh') },
    ],
    '/Perceptual ri /Sh sh BT /F 12 Tf 10 10 Td (A) Tj ET',
  );

const glyphShadingSample = (glyph: string, intent: Intent): ReadonlyArray<number> => {
  const document = glyphShadingPdf(glyph);
  expect(convertShadings(document, { sourceRgbProfile: source, outputProfile: destination, intent }).shadings).toBe(1);
  return sampled(document, 7, []);
};

const refusedGlyphIntent = (glyph: string): ShadingConversionReport =>
  convertShadings(glyphShadingPdf(glyph), { sourceRgbProfile: source, outputProfile: destination, intent: 'document' });

describe('rendering intents of shadings that Type 3 glyphs paint', () => {
  // A glyph description runs in the graphics state of the text-showing operator that shows it, so a glyph that selects no intent paints with that operator's intent.
  it.each(['/Sh sh', 'q /Saturation ri Q /Sh sh', '/Fm Do', 'q /Saturation ri Q /Fm Do'])(
    'samples a shading that the page and a glyph showing %s share with the page intent',
    glyph => {
      expect(glyphShadingSample(glyph, 'perceptual')).not.toStrictEqual(glyphShadingSample(glyph, 'relativeColorimetric'));
      expect(glyphShadingSample(glyph, 'document')).toStrictEqual(glyphShadingSample(glyph, 'perceptual'));
    },
  );

  it.each(['/Saturation ri /Sh sh', '/Saturation ri /Fm Do'])(
    'refuses a shading that a glyph showing %s paints with an intent of its own and the page with another',
    glyph => {
      expect(() => refusedGlyphIntent(glyph)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
      expect(() => refusedGlyphIntent(glyph)).toThrow(/different rendering intents/u);
    },
  );
});

/** A document with one page per entry; page `index` is object 20 + 2 × index and its content object 21 + 2 × index. */
const pagesPdf = (pages: ReadonlyArray<{ page: string; content: string }>, objects: ReadonlyArray<TestObject>): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: `<</Type/Pages/Kids[${pages.map((_, index) => `${String(20 + 2 * index)} 0 R`).join(' ')}]/Count ${String(pages.length)}>>` },
          ...pages.flatMap(({ page, content }, index) => [
            { number: 20 + 2 * index, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents ${String(21 + 2 * index)} 0 R${page}>>` },
            { number: 21 + 2 * index, body: streamBody('', content) },
          ]),
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

const FORM = '/Type/XObject/Subtype/Form/BBox[0 0 10 10]';

/** Form 7 holds a direct shading that the first page names; the second page's appearance paints form 7 after selecting Perceptual. */
const laterAppearancePdf = (firstContent: string): LoadedDocument =>
  pagesPdf(
    [
      { page: '/Resources<</XObject<</F 7 0 R>>>>', content: firstContent },
      { page: '/Resources<<>>/Annots[10 0 R]', content: '0 0 1 1 re f' },
    ],
    [
      { number: 7, body: streamBody(`${FORM}${OWN_SHADING}`, '/Sh1 sh') },
      { number: 10, body: '<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/AP<</N 11 0 R>>>>' },
      { number: 11, body: streamBody(`${FORM}/Resources<</XObject<</F 7 0 R>>>>`, '/Perceptual ri /F Do') },
    ],
  );

const laterAppearanceSample = (intent: Intent): ReadonlyArray<number> => {
  const document = laterAppearancePdf('0 0 1 1 re f');
  convertShadings(document, { sourceRgbProfile: source, outputProfile: destination, intent });
  return sampled(document, 7, ['Resources', 'Shading', 'Sh1']);
};

const refusedLaterAppearance = (): ShadingConversionReport =>
  convertShadings(laterAppearancePdf('/F Do'), { sourceRgbProfile: source, outputProfile: destination, intent: 'document' });

describe('rendering intents of direct shadings in carriers that an earlier page listed', () => {
  it('samples the shading with the intent a later page selects before painting the carrier', () => {
    expect(laterAppearanceSample('perceptual')).not.toStrictEqual(laterAppearanceSample('relativeColorimetric'));
    expect(laterAppearanceSample('document')).toStrictEqual(laterAppearanceSample('perceptual'));
  });

  it('refuses the shading when the first page paints the carrier with another intent', () => {
    expect(refusedLaterAppearance).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
    expect(refusedLaterAppearance).toThrow(/different rendering intents/u);
  });
});

/** Form 7 holds a direct shading and selects Perceptual before painting it; it is named as a page form and is also annotation 10's appearance. */
const formAppearances = [
  {
    shape: 'on one page',
    pages: [{ page: '/Resources<</XObject<</F 7 0 R>>>>/Annots[10 0 R]', content: '0 0 1 1 re f' }],
  },
  {
    shape: 'on a later page',
    pages: [
      { page: '/Resources<</XObject<</F 7 0 R>>>>', content: '0 0 1 1 re f' },
      { page: '/Resources<<>>/Annots[10 0 R]', content: '0 0 1 1 re f' },
    ],
  },
];

describe('rendering intents of direct shadings in a form that is also an appearance', () => {
  it.each(formAppearances)('samples the shading with the intent the appearance content selects when the appearance is $shape', ({ pages }) => {
    const sample = (intent: Intent): ReadonlyArray<number> => {
      const document = pagesPdf(pages, [
        { number: 7, body: streamBody(`${FORM}${OWN_SHADING}`, '/Perceptual ri /Sh1 sh') },
        { number: 10, body: '<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/AP<</N 7 0 R>>>>' },
      ]);
      convertShadings(document, { sourceRgbProfile: source, outputProfile: destination, intent });
      return sampled(document, 7, ['Resources', 'Shading', 'Sh1']);
    };
    expect(sample('perceptual')).not.toStrictEqual(sample('relativeColorimetric'));
    expect(sample('document')).toStrictEqual(sample('perceptual'));
  });
});

/** Lists the carriers that page `index` of `document` reaches, with the pass state `seen`. */
const walkPage = (document: LoadedDocument, index: number, seen: CarrierSeen): ReadonlyArray<ResourceCarrier> => {
  const internals = internalsOf(document);
  const entry = internals?.pages[index];
  if (internals === undefined || entry === undefined) {
    throw new Error('document internals are missing');
  }
  return resourceCarriers(internals, { index, reference: entry.reference, resources: document.page(index).resources() }, seen);
};

const PATTERNS = '/Resources<</Pattern<</P1 5 0 R/P2 6 0 R/P3 7 0 R>>>>';
const EMPTY_PATTERNS = [5, 6, 7].map(number => ({ number, body: streamBody(`${PATTERN}/Resources<<>>`, '') }));

const walkPastLimit = (): ReadonlyArray<ResourceCarrier> => walkPage(carrierPdf(PATTERNS, EMPTY_PATTERNS), 0, carrierSeen(2));

describe('the step limit of the carrier walk', () => {
  // A page naming three tiling patterns, each with an empty Resources of its own, takes one step per pattern.
  it('lists every carrier when the walk takes as many steps as the limit', () => {
    expect(walkPage(carrierPdf(PATTERNS, EMPTY_PATTERNS), 0, carrierSeen(3)).map(carrier => carrier.key)).toStrictEqual(['5 0 R', '6 0 R', '7 0 R']);
  });

  it('refuses a walk that takes one step more than the limit', () => {
    expect(walkPastLimit).toThrow(ResourceLimitError);
    expect(walkPastLimit).toThrow(/more than 2 steps/u);
  });

  it('counts the steps of every page walk that shares the pass state', () => {
    const document = pagesPdf(
      [
        { page: PATTERNS, content: '' },
        { page: PATTERNS, content: '' },
      ],
      EMPTY_PATTERNS,
    );
    const seen = carrierSeen(5);
    expect(walkPage(document, 0, seen)).toHaveLength(3);
    expect(() => walkPage(document, 1, seen)).toThrow(/more than 5 steps/u);
  });
});

const SHARERS = 100;
const sharerForms = Array.from({ length: SHARERS }, (_, index) => `/F${String(index)} ${String(5 + index)} 0 R`).join('');

/** Forms that each name every form through one shared indirect dictionary, so a walk that expands it once per form takes steps quadratic in the form count. */
const sharedDictionaries = [
  {
    shared: 'Resources',
    page: '/Resources 200 0 R',
    form: '/Resources 200 0 R',
    dictionary: `<</XObject<<${sharerForms}>>>>`,
  },
  {
    shared: 'XObject category',
    page: '/Resources<</XObject 200 0 R>>',
    form: '/Resources<</XObject 200 0 R>>',
    dictionary: `<<${sharerForms}>>`,
  },
];

describe('carriers that share an indirect resource dictionary', () => {
  it.each(sharedDictionaries)('lists $shared sharers once each in steps linear in their count', ({ page, form, dictionary }) => {
    const document = carrierPdf(page, [
      ...Array.from({ length: SHARERS }, (_, index) => ({ number: 5 + index, body: streamBody(`${FORM}${form}`, '') })),
      { number: 200, body: dictionary },
    ]);
    const listed = walkPage(document, 0, carrierSeen(3 * SHARERS));
    expect(listed.map(carrier => carrier.key)).toStrictEqual(Array.from({ length: SHARERS }, (_, index) => `${String(5 + index)} 0 R`));
  });
});

/** Direct Type 3 fonts on a cycle back to a dictionary the walk has already reached, with the steps the walk takes and the carriers it lists. */
const fontCycles = [
  {
    shape: 'names the indirect Resources that holds it',
    page: '/Resources 7 0 R',
    dictionary: `<</ColorSpace<</X1 ${INDEXED}>>/Font<</F <<${TYPE3}/Resources 7 0 R>>>>>>`,
    // The font from the page, then the same font from its own Resources, which only records a second place.
    steps: 2,
    owners: [{ kind: 'resources', reference: pdfReference(7, 0) }],
  },
  {
    shape: 'sits in the indirect Font category its own Resources names',
    page: '/Resources<</Font 7 0 R>>',
    dictionary: `<</F <<${TYPE3}/Resources<</ColorSpace<</X1 ${INDEXED}>>/Font 7 0 R>>>>>>`,
    // The font from the page; its own Resources only records a second holder of the category.
    steps: 1,
    owners: [{ kind: 'category', reference: pdfReference(7, 0), name: pdfName('F').bytes }],
  },
];

describe('cycles through direct Type 3 fonts', () => {
  it.each(fontCycles)('lists a direct Type 3 font that $shape once, in a counted number of steps', ({ page, dictionary, steps, owners }) => {
    const seen = carrierSeen(steps);
    const listed = walkPage(carrierPdf(page, [GLYPH, { number: 7, body: dictionary }]), 0, seen);
    expect(listed.map(carrier => carrier.owner)).toStrictEqual(owners);
    expect(seen.steps).toBe(steps);
  });
});

/** A page reaching `depth` tiling patterns, each naming the next, where the innermost holds an Indexed space. */
const nestedPatterns = (depth: number, options: LoadOptions): LoadedDocument =>
  carrierPdf(
    '/Resources<</Pattern<</P 5 0 R>>>>',
    Array.from({ length: depth }, (_, index) => ({
      number: 5 + index,
      body: streamBody(`${PATTERN}${index === depth - 1 ? OWN_INDEXED : `/Resources<</Pattern<</P ${String(6 + index)} 0 R>>>>`}`, '/CS1 cs 0 sc'),
    })),
    '0 0 1 1 re f',
    options,
  );

const convertNested = (depth: number): number =>
  convertIndexedSpaces(nestedPatterns(depth, { maxNesting: 8 }), { sourceRgbProfile: source, outputProfile: destination }).indexed;

describe('the nesting limit of the carrier walk', () => {
  it('converts a lookup in carriers nested as deep as maxNesting', () => {
    expect(convertNested(8)).toBe(1);
  });

  it('refuses carriers nested one level deeper than maxNesting', () => {
    expect(() => convertNested(9)).toThrow(ResourceLimitError);
    expect(() => convertNested(9)).toThrow(/maxNesting \(8\)/u);
  });

  it('counts the shortest nesting it knows of for forms whose own Resources each name every form', () => {
    const count = 12;
    const all = Array.from({ length: count }, (_, index) => `/F${String(index)} ${String(5 + index)} 0 R`).join('');
    const document = carrierPdf(
      `/Resources<</XObject<<${all}>>>>`,
      Array.from({ length: count }, (_, index) => ({ number: 5 + index, body: streamBody(`${FORM}/Resources<</XObject<<${all}>>>>`, '') })),
      '0 0 1 1 re f',
      { maxNesting: 8 },
    );
    expect(walkPage(document, 0, carrierSeen())).toHaveLength(count);
  });
});

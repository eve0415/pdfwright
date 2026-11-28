import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertIndexedSpaces } from './convertIndexed.ts';
import { convertShadings } from './convertShadings.ts';
import { convertSpotSpaces } from './convertSpots.ts';
import { convertToCmyk } from './convertToCmyk.ts';

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

const carrierPdf = (page: string, objects: ReadonlyArray<TestObject>, content = '0 0 1 1 re f'): LoadedDocument =>
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

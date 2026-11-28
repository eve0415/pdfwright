import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { deltaE2000 } from '../color/deltaE2000.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfDictionary, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertSpotSpaces } from './convertSpots.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const displayP3Bytes = await fixture('DisplayP3-v4.icc');
const options = { intent: 'relativeColorimetric', blackPointCompensation: true } as const;
const rgbTransform = createColorTransform({ kind: 'icc', profile: source }, destination, options);

const cmykOf = (...rgb: ReadonlyArray<number>): Float64Array => {
  const output = new Float64Array(4);
  rgbTransform.convert(Float64Array.from(rgb), output);
  return output;
};
const pdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1[/Separation/#82b#82t#82s/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[0 0 0]/N 1>>]>>>>>>',
      },
      { number: 4, body: streamBody('', '/CS1 cs 0.5 sc 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const deviceNPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS2[/DeviceN[/SpotA/SpotB]/DeviceRGB 6 0 R]>>>>>>',
      },
      { number: 4, body: streamBody('', '/CS2 cs 0.5 0.5 sc 0 0 10 10 re f') },
      {
        number: 6,
        body: streamBody(
          '/FunctionType 0/Domain[0 1 0 1]/Range[0 1 0 1 0 1]/Size[2 2]/BitsPerSample 8',
          String.fromCodePoint(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255),
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const formPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Fm Do') },
      {
        number: 5,
        body: streamBody(
          '/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</ColorSpace<</CS1[/Separation/#82b#82t#82s/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[0 0 0]/N 1>>]>>>>',
          '/CS1 cs 0.5 sc',
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const imagePdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Im Do') },
      {
        number: 5,
        body: streamBody(
          '/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace[/Separation/#82b#82t#82s/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[0 0 0]/N 1>>]',
          String.fromCodePoint(128),
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const stitchedPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1[/Separation/Spot/DeviceRGB 6 0 R]>>>>>>',
      },
      { number: 4, body: streamBody('', '/CS1 cs 0.25 sc 0 0 10 10 re f') },
      {
        number: 6,
        body: '<</FunctionType 3/Domain[0 1]/Functions[<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[1 0 0]/N 1>><</FunctionType 2/Domain[0 1]/C0[0 0 1]/C1[0 0 1]/N 1>>]/Bounds[0.5]/Encode[0 1 0 1]>>',
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const flatSpotPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1[/Separation/Spot/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[0.2 0.3 0.4]/C1[0.2 0.3 0.4]/N 1>>]>>>>>>',
      },
      { number: 4, body: streamBody('', '/CS1 cs 0.5 sc') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const calculatorStepPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1[/Separation/Spot/DeviceRGB 6 0 R]>>>>>>',
      },
      { number: 4, body: streamBody('', '/CS1 cs 0.5 sc') },
      { number: 6, body: streamBody('/FunctionType 4/Domain[0 1]/Range[0 1 0 1 0 1]', '{ dup 0.5 lt { pop 1 0 0 } { pop 0 0 1 } ifelse }') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

interface ConvertedSpot {
  readonly name: Uint8Array;
  readonly alternate: string;
  readonly evaluate: (tint: number) => Array<number>;
}

const spot = (document: ReturnType<typeof loadDocument>): ConvertedSpot => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  const value = spaces.entries.get(pdfName('CS1').bytes);
  if (value?.kind !== 'array') {
    throw new Error('Separation is missing');
  }
  const [, name, alternate, tint] = value.items;
  if (name?.kind !== 'name' || alternate?.kind !== 'name' || tint?.kind !== 'reference') {
    throw new Error('converted Separation is invalid');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('document internals are missing');
  }
  const stream = document.get(tint);
  if (stream.kind !== 'stream') {
    throw new Error('tint function is missing');
  }
  const data = decodedData(internals, stream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  const evaluate = createPdfFunction({ kind: 'stream', dictionary: stream.dictionary, data });
  return { name: name.bytes, alternate: new TextDecoder('latin1').decode(alternate.bytes), evaluate: tintValue => evaluate([tintValue]) };
};

interface ConvertedDeviceN {
  readonly names: ReadonlyArray<Uint8Array>;
  readonly alternate: string;
  readonly evaluate: (first: number, second: number) => Array<number>;
}

const deviceN = (document: ReturnType<typeof loadDocument>): ConvertedDeviceN => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  const value = spaces.entries.get(pdfName('CS2').bytes);
  if (value?.kind !== 'array') {
    throw new Error('DeviceN is missing');
  }
  const [, names, alternate, tint] = value.items;
  if (names?.kind !== 'array' || alternate?.kind !== 'name' || tint?.kind !== 'reference') {
    throw new Error('converted DeviceN is invalid');
  }
  const decodedNames = names.items.map(name => {
    if (name.kind !== 'name') {
      throw new Error('DeviceN colorant is invalid');
    }
    return name.bytes;
  });
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('document internals are missing');
  }
  const stream = document.get(tint);
  if (stream.kind !== 'stream') {
    throw new Error('DeviceN tint function is missing');
  }
  const data = decodedData(internals, stream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  const evaluate = createPdfFunction({ kind: 'stream', dictionary: stream.dictionary, data });
  return { names: decodedNames, alternate: new TextDecoder('latin1').decode(alternate.bytes), evaluate: (first, second) => evaluate([first, second]) };
};

const processAttributes = (space: 'DeviceRGB' | 'DeviceCMYK'): PdfDirectObject => {
  const process = pdfDictionary(new PdfDictionaryEntries([[pdfName('ColorSpace').bytes, pdfName(space)]]));
  return pdfDictionary(
    new PdfDictionaryEntries([
      [pdfName('Subtype').bytes, pdfName('NChannel')],
      [pdfName('Process').bytes, process],
    ]),
  );
};

const withProcess = (space: 'DeviceRGB' | 'DeviceCMYK'): ReturnType<typeof loadDocument> => {
  const document = loadDocument(deviceNPdf.bytes);
  const page = document.get(document.page(0).reference);
  if (page.kind !== 'dictionary') {
    throw new Error('page is missing');
  }
  const resources = document.page(0).resources();
  const spaces = resources.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  const value = spaces.entries.get(pdfName('CS2').bytes);
  if (value?.kind !== 'array') {
    throw new Error('DeviceN is missing');
  }
  value.items.push(processAttributes(space));
  spaces.entries.set(pdfName('CS2').bytes, value);
  page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
  document.set(document.page(0).reference, page);
  return document;
};

const withFiveColorants = (): ReturnType<typeof loadDocument> => {
  const document = loadDocument(deviceNPdf.bytes);
  const page = document.get(document.page(0).reference);
  if (page.kind !== 'dictionary') {
    throw new Error('page is missing');
  }
  const resources = document.page(0).resources();
  const spaces = resources.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  const value = spaces.entries.get(pdfName('CS2').bytes);
  if (value?.kind !== 'array') {
    throw new Error('DeviceN is missing');
  }
  const names = value.items.at(1);
  if (names?.kind !== 'array') {
    throw new Error('DeviceN colorants are missing');
  }
  names.items.push(pdfName('SpotC'), pdfName('SpotD'), pdfName('SpotE'));
  spaces.entries.set(pdfName('CS2').bytes, value);
  page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
  document.set(document.page(0).reference, page);
  return document;
};

const alternateOf = (document: ReturnType<typeof loadDocument>, objectNumber: number, resourceName?: string): string => {
  const object = document.get({ kind: 'reference', objectNumber, generation: 0 });
  if (object.kind !== 'stream') {
    throw new Error('object is not a stream');
  }
  let color = object.dictionary.get(pdfName('ColorSpace').bytes);
  if (resourceName !== undefined) {
    const resources = object.dictionary.get(pdfName('Resources').bytes);
    if (resources?.kind !== 'dictionary') {
      throw new Error('form resources are missing');
    }
    const spaces = resources.entries.get(pdfName('ColorSpace').bytes);
    if (spaces?.kind !== 'dictionary') {
      throw new Error('form ColorSpace is missing');
    }
    color = spaces.entries.get(pdfName(resourceName).bytes);
  }
  if (color?.kind !== 'array') {
    throw new Error('spot colour space is missing');
  }
  const alternate = color.items.at(2);
  if (alternate?.kind !== 'name') {
    throw new Error('spot alternate is missing');
  }
  return new TextDecoder('latin1').decode(alternate.bytes);
};

const streamData = (value: PdfObject): Uint8Array => {
  if (value.kind !== 'stream') {
    throw new Error('object is not a stream');
  }
  return value.data;
};

const boundNumber = (value: PdfObject): number => {
  if (value.kind === 'integer') {
    return value.value;
  }
  if (value.kind === 'real' && typeof value.value === 'number') {
    return value.value;
  }
  throw new Error('bound is not numeric');
};

const stitchedBounds = (document: ReturnType<typeof loadDocument>): ReadonlyArray<number> => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  const color = spaces.entries.get(pdfName('CS1').bytes);
  if (color?.kind !== 'array') {
    throw new Error('Separation is missing');
  }
  const tint = color.items.at(3);
  if (tint?.kind !== 'reference') {
    throw new Error('tint function is missing');
  }
  const object = document.get(tint);
  if (object.kind !== 'dictionary') {
    throw new Error('stitching function is missing');
  }
  const type = object.entries.get(pdfName('FunctionType').bytes);
  const bounds = object.entries.get(pdfName('Bounds').bytes);
  if (type?.kind !== 'integer' || type.value !== 3 || bounds?.kind !== 'array') {
    throw new Error('hard stop was not preserved');
  }
  return bounds.items.map(value => boundNumber(value));
};

const spotGrid = (document: ReturnType<typeof loadDocument>): number => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  const color = spaces.entries.get(pdfName('CS1').bytes);
  if (color?.kind !== 'array') {
    throw new Error('Separation is missing');
  }
  const tint = color.items.at(3);
  if (tint?.kind !== 'reference') {
    throw new Error('tint function is missing');
  }
  const object = document.get(tint);
  if (object.kind !== 'stream') {
    throw new Error('sampled tint function is missing');
  }
  const size = object.dictionary.get(pdfName('Size').bytes);
  if (size?.kind !== 'array' || size.items[0]?.kind !== 'integer') {
    throw new Error('sample grid is missing');
  }
  return size.items[0].value;
};

const separationPdf = (
  space: string,
  tint: string,
  extra: { readonly objects?: ReadonlyArray<{ readonly number: number; readonly body: string }>; readonly resources?: string } = {},
): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1${space}>>${extra.resources ?? ''}>>>>`,
        },
        { number: 4, body: streamBody('', '/CS1 cs 0 0 10 10 re f') },
        { number: 6, body: tint },
        ...(extra.objects ?? []),
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

const sharedImagePdf = (secondDefaultRgb: boolean): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R 7 0 R]/Count 2>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
        { number: 4, body: streamBody('', '/Im Do') },
        {
          number: 5,
          body: streamBody(
            '/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace[/Separation/Spot/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[1 0 0]/N 1>>]',
            String.fromCodePoint(128),
          ),
        },
        {
          number: 7,
          body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>${secondDefaultRgb ? '/ColorSpace<</DefaultRGB[/ICCBased 8 0 R]>>' : ''}>>>>`,
        },
        { number: 8, body: streamBody('/N 3', latin1Text(displayP3Bytes)) },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

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

/** Reads a written function graph, following and decoding the indirect children of a Type 3 function. */
const functionOf = (document: LoadedDocument, value: PdfDirectObject | undefined): PdfFunction => {
  if (value === undefined) {
    throw new Error('function is missing');
  }
  const resolve = (item: PdfDirectObject): PdfObject => decodedObject(document, item.kind === 'reference' ? document.get(item) : item);
  return createPdfFunction(resolve(value), resolve);
};

const pageSpace = (document: LoadedDocument, name: string): ReadonlyArray<PdfDirectObject> => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  const value = spaces.entries.get(pdfName(name).bytes);
  if (value?.kind !== 'array') {
    throw new Error(`${name} is missing`);
  }
  return value.items;
};

const close = (actual: ReadonlyArray<number>, expected: Float64Array): boolean =>
  actual.length === expected.length && actual.every((value, index) => Math.abs(value - (expected[index] ?? Number.NaN)) <= 0.005);

const sampleSize = (document: LoadedDocument, name: string): ReadonlyArray<number> => {
  const tint = pageSpace(document, name).at(3);
  if (tint?.kind !== 'reference') {
    throw new Error('tint function is missing');
  }
  const object = document.get(tint);
  const size = object.kind === 'stream' ? object.dictionary.get(pdfName('Size').bytes) : undefined;
  if (size?.kind !== 'array') {
    throw new Error('sample grid is missing');
  }
  return size.items.map(item => (item.kind === 'integer' ? item.value : Number.NaN));
};

const toPcs = sourceEvaluator(destination, 'relativeColorimetric', 'icc');
const lab = (cmyk: ReadonlyArray<number>): ReadonlyArray<number> => {
  const pcs = toPcs(cmyk);
  return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
};

/** The largest ΔE2000 between the exact CMYK tint at each cell midpoint of an evenly spaced grid and the mean of the cell's two end samples. */
const midpointError = (tint: (value: number) => ReadonlyArray<number>, grid: number): number => {
  let maximum = 0;
  for (let index = 0; index < grid - 1; index++) {
    const low = cmykOf(...tint(index / (grid - 1)));
    const high = cmykOf(...tint((index + 1) / (grid - 1)));
    const exact = cmykOf(...tint((index + 0.5) / (grid - 1)));
    const interpolated = Array.from({ length: 4 }, (_, channel) => ((low[channel] ?? 0) + (high[channel] ?? 0)) / 2);
    maximum = Math.max(maximum, deltaE2000(lab([...exact]), lab(interpolated)));
  }
  return maximum;
};

describe('spot alternate conversion', () => {
  it('keeps a Shift_JIS Separation name byte-identical and composes its tint', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const saved = loadDocument(document.save().toBytes());
    const converted = spot(saved);
    expect(report.separations).toBe(1);
    expect(converted.name).toStrictEqual(Uint8Array.of(0x82, 0x62, 0x82, 0x74, 0x82, 0x73));
    expect(converted.alternate).toBe('DeviceCMYK');
    // ISO 32000-1:2008, 8.6.6.4: the converted tint transform is the original RGB transform followed by RGB to CMYK, so tint 0 stays white and tint 1 black.
    expect([0, 0.25, 0.5, 1].map(tint => close(converted.evaluate(tint), cmykOf(1 - tint, 1 - tint, 1 - tint)))).toStrictEqual([true, true, true, true]);
  });

  it('samples a two-colorant DeviceN tint into CMYK', () => {
    const document = loadDocument(deviceNPdf.bytes);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = deviceN(document);
    expect(report.deviceN).toBe(1);
    expect(converted.names).toStrictEqual([new TextEncoder().encode('SpotA'), new TextEncoder().encode('SpotB')]);
    expect(converted.alternate).toBe('DeviceCMYK');
    // ISO 32000-1:2008, 7.10.2: the first input varies fastest in the source table, so (1, 0) is red and (0, 1) green.
    const points = [
      { input: [0, 0], rgb: [0, 0, 0] },
      { input: [1, 0], rgb: [1, 0, 0] },
      { input: [0, 1], rgb: [0, 1, 0] },
      { input: [1, 1], rgb: [0, 0, 1] },
      { input: [0.5, 0.5], rgb: [0.25, 0.25, 0.25] },
    ] as const;
    expect(points.map(({ input, rgb }) => close(converted.evaluate(input[0], input[1]), cmykOf(...rgb)))).toStrictEqual([true, true, true, true, true]);
  });

  it('samples a four-colorant DeviceN tint on a 17 by 17 by 17 by 17 grid', () => {
    const document = loadDocument(
      separationPdf('[/DeviceN[/A/B/C/D]/DeviceRGB 6 0 R]', streamBody('/FunctionType 4/Domain[0 1 0 1 0 1 0 1]/Range[0 1 0 1 0 1]', '{ pop }')),
    );
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const evaluate = functionOf(document, pageSpace(document, 'CS1').at(3));
    expect(report.deviceN).toBe(1);
    expect(sampleSize(document, 'CS1')).toStrictEqual([17, 17, 17, 17]);
    const points = [
      { input: [1, 0, 0, 0], rgb: [1, 0, 0] },
      { input: [0, 0, 1, 0], rgb: [0, 0, 1] },
      { input: [0, 0, 0, 1], rgb: [0, 0, 0] },
    ] as const;
    expect(points.map(({ input, rgb }) => close(evaluate(input), cmykOf(...rgb)))).toStrictEqual([true, true, true]);
  });

  it('refuses an NChannel process space that remains RGB', () => {
    const document = withProcess('DeviceRGB');
    expect(() => {
      convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    }).toThrow(expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'nchannel-process' }));
  });

  it('converts an NChannel space with a CMYK process space and keeps its attributes', () => {
    const document = withProcess('DeviceCMYK');
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const space = pageSpace(document, 'CS2');
    expect(report.deviceN).toBe(1);
    expect(space.at(2)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(space.at(4)).toStrictEqual(processAttributes('DeviceCMYK'));
  });

  it('refuses a DeviceN tint with more than four components', () => {
    const document = withFiveColorants();
    expect(() => {
      convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    }).toThrow(expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'device-n-components' }));
  });

  it('converts a form resource Separation alternate', () => {
    const document = loadDocument(formPdf.bytes);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.separations).toBe(1);
    expect(alternateOf(document, 5, 'CS1')).toBe('DeviceCMYK');
  });

  it('converts an image Separation alternate without changing its tint samples', () => {
    const document = loadDocument(imagePdf.bytes);
    const before = document.get({ kind: 'reference', objectNumber: 5, generation: 0 });
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const after = document.get({ kind: 'reference', objectNumber: 5, generation: 0 });
    expect(report.separations).toBe(1);
    expect(alternateOf(document, 5)).toBe('DeviceCMYK');
    expect(streamData(after)).toStrictEqual(streamData(before));
  });

  it('keeps a Type 3 tint function boundary as a hard stop', () => {
    const document = loadDocument(stitchedPdf.bytes);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.separations).toBe(1);
    expect(stitchedBounds(document)).toStrictEqual([0.5]);
    // ISO 32000-1:2008, 7.10.4: below the bound the first child (red) applies, above it the second (blue).
    const evaluate = functionOf(document, pageSpace(document, 'CS1').at(3));
    expect([close(evaluate([0.25]), cmykOf(1, 0, 0)), close(evaluate([0.75]), cmykOf(0, 0, 1))]).toStrictEqual([true, true]);
  });

  it('starts a flat Separation tint at the 256-sample grid', () => {
    const document = loadDocument(flatSpotPdf.bytes);
    convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(spotGrid(document)).toBe(256);
  });

  it('reports a discontinuity that remains above tolerance at 4096 samples', () => {
    const document = loadDocument(calculatorStepPdf.bytes);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(spotGrid(document)).toBe(4096);
    expect(report.approximations).toHaveLength(1);
    expect(report.approximations[0]?.maxDeltaE2000).toBeGreaterThan(0.1);
  });

  it.each([
    { exponent: 8, grid: 512 },
    { exponent: 14, grid: 1024 },
  ])('stops refining a tint with exponent $exponent at the first grid within tolerance ($grid)', ({ exponent, grid }) => {
    const document = loadDocument(
      separationPdf('[/Separation/Spot/DeviceRGB 6 0 R]', `<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[0 0 0]/N ${String(exponent)}>>`),
    );
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const tint = (value: number): ReadonlyArray<number> => Array.from({ length: 3 }, () => 1 - value ** exponent);
    expect(sampleSize(document, 'CS1')).toStrictEqual([grid]);
    expect(report.approximations).toStrictEqual([]);
    expect([midpointError(tint, grid / 2) > 0.1, midpointError(tint, grid) <= 0.1]).toStrictEqual([true, true]);
  });

  it.each([
    { name: 'a DeviceN with a Type 3 tint', space: '[/DeviceN[/A]/DeviceRGB 6 0 R]' },
    { name: 'a Separation with a two-input tint', space: '[/Separation/Spot/DeviceRGB 7 0 R]' },
    { name: 'a two-colorant DeviceN with a one-input tint', space: '[/DeviceN[/A/B]/DeviceRGB 8 0 R]' },
  ])('refuses $name', ({ space }) => {
    const document = loadDocument(
      separationPdf(space, '<</FunctionType 3/Domain[0 1]/Functions[<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>]/Bounds[]/Encode[0 1]>>', {
        objects: [
          {
            number: 7,
            body: streamBody(
              '/FunctionType 0/Domain[0 1 0 1]/Range[0 1 0 1 0 1]/Size[2 2]/BitsPerSample 8',
              String.fromCodePoint(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255),
            ),
          },
          { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[0 0 0]/N 1>>' },
        ],
      }),
    );
    expect(() => convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination })).toThrow(
      expect.objectContaining({ reason: 'color-space' }),
    );
  });

  it.each([
    { name: 'DeviceCMYK', alternate: '/DeviceCMYK', tint: '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 0 0 1]/N 1>>' },
    { name: 'Lab', alternate: '[/Lab<</WhitePoint[0.9505 1 1.089]>>]', tint: '<</FunctionType 2/Domain[0 1]/C0[100 0 0]/C1[0 0 0]/N 1>>' },
  ])('leaves a Separation with a $name alternate unconverted and uncounted', ({ alternate, tint }) => {
    const document = loadDocument(separationPdf(`[/Separation/Spot${alternate} 6 0 R]`, tint));
    const before = pageSpace(document, 'CS1');
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report).toStrictEqual({ separations: 0, deviceN: 0, approximations: [] });
    expect(pageSpace(document, 'CS1')).toStrictEqual(before);
  });

  it('converts a CalGray alternate through its own gamma', () => {
    const document = loadDocument(
      separationPdf('[/Separation/Spot[/CalGray<</WhitePoint[0.9505 1 1.089]/Gamma 2.2>>]6 0 R]', '<</FunctionType 2/Domain[0 1]/C0[1]/C1[0]/N 1>>'),
    );
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const space = pageSpace(document, 'CS1');
    const evaluate = functionOf(document, space.at(3));
    // ISO 32000-1:2008, 8.6.5.2: CalGray applies its Gamma to the component before the white-point scale.
    const transform = createColorTransform({ kind: 'calGray', whitePoint: { x: 0.9505, y: 1, z: 1.089 }, gamma: 2.2 }, destination, options);
    const expected = new Float64Array(4);
    transform.convert(Float64Array.of(0.75), expected);
    expect(report.separations).toBe(1);
    expect(space.at(2)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(close(evaluate([0.25]), expected)).toBe(true);
  });

  it('converts a spot image shared by two pages once', () => {
    const document = loadDocument(sharedImagePdf(false));
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.separations).toBe(1);
    expect(alternateOf(document, 5)).toBe('DeviceCMYK');
  });

  it('refuses a spot image whose alternate resolves to different profiles on two pages', () => {
    const document = loadDocument(sharedImagePdf(true));
    expect(() => convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
    expect(alternateOf(document, 5)).toBe('DeviceRGB');
  });

  it.each([
    { name: 'deletes the replaced tint function', shading: false, kind: 'null' },
    { name: 'keeps a replaced tint function that a shading still uses', shading: true, kind: 'dictionary' },
  ])('$name', ({ shading, kind }) => {
    const document = loadDocument(
      separationPdf(
        '[/Separation/Spot/DeviceRGB 6 0 R]',
        '<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[0 0 0]/N 1>>',
        shading
          ? { objects: [{ number: 7, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function 6 0 R>>' }], resources: '/Shading<</Sh1 7 0 R>>' }
          : {},
      ),
    );
    convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(pageSpace(document, 'CS1').at(3)).not.toStrictEqual(pdfReference(6, 0));
    expect(document.get(pdfReference(6, 0)).kind).toBe(kind);
  });
});

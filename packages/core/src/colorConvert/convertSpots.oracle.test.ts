import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfDictionary, pdfName } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { convertSpotSpaces } from './convertSpots.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
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
  readonly evaluate: (tint: number) => number[];
}

const closeChannels = (actual: readonly number[], expected: Float64Array): boolean[] =>
  actual.map((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 0.005);

const spot = (document: ReturnType<typeof loadDocument>): ConvertedSpot => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('ColorSpace resources are missing');
  const value = spaces.entries.get(pdfName('CS1').bytes);
  if (value?.kind !== 'array') throw new Error('Separation is missing');
  const [, name, alternate, tint] = value.items;
  if (name?.kind !== 'name' || alternate?.kind !== 'name' || tint?.kind !== 'reference') throw new Error('converted Separation is invalid');
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('document internals are missing');
  const stream = document.get(tint);
  if (stream.kind !== 'stream') throw new Error('tint function is missing');
  const data = decodedData(internals, stream);
  if (typeof data === 'string') throw new Error(data);
  const evaluate = createPdfFunction({ kind: 'stream', dictionary: stream.dictionary, data });
  return { name: name.bytes, alternate: new TextDecoder('latin1').decode(alternate.bytes), evaluate: tintValue => evaluate([tintValue]) };
};

interface ConvertedDeviceN {
  readonly names: readonly Uint8Array[];
  readonly alternate: string;
  readonly evaluate: (first: number, second: number) => number[];
}

const deviceN = (document: ReturnType<typeof loadDocument>): ConvertedDeviceN => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('ColorSpace resources are missing');
  const value = spaces.entries.get(pdfName('CS2').bytes);
  if (value?.kind !== 'array') throw new Error('DeviceN is missing');
  const [, names, alternate, tint] = value.items;
  if (names?.kind !== 'array' || alternate?.kind !== 'name' || tint?.kind !== 'reference') throw new Error('converted DeviceN is invalid');
  const decodedNames = names.items.map(name => {
    if (name.kind !== 'name') throw new Error('DeviceN colorant is invalid');
    return name.bytes;
  });
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('document internals are missing');
  const stream = document.get(tint);
  if (stream.kind !== 'stream') throw new Error('DeviceN tint function is missing');
  const data = decodedData(internals, stream);
  if (typeof data === 'string') throw new Error(data);
  const evaluate = createPdfFunction({ kind: 'stream', dictionary: stream.dictionary, data });
  return { names: decodedNames, alternate: new TextDecoder('latin1').decode(alternate.bytes), evaluate: (first, second) => evaluate([first, second]) };
};

const withRgbProcess = (): ReturnType<typeof loadDocument> => {
  const document = loadDocument(deviceNPdf.bytes);
  const page = document.get(document.page(0).reference);
  if (page.kind !== 'dictionary') throw new Error('page is missing');
  const resources = document.page(0).resources();
  const spaces = resources.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('ColorSpace resources are missing');
  const value = spaces.entries.get(pdfName('CS2').bytes);
  if (value?.kind !== 'array') throw new Error('DeviceN is missing');
  const process = pdfDictionary(new PdfDictionaryEntries([[pdfName('ColorSpace').bytes, pdfName('DeviceRGB')]]));
  const attributes = pdfDictionary(
    new PdfDictionaryEntries([
      [pdfName('Subtype').bytes, pdfName('NChannel')],
      [pdfName('Process').bytes, process],
    ]),
  );
  value.items.push(attributes);
  spaces.entries.set(pdfName('CS2').bytes, value);
  page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
  document.set(document.page(0).reference, page);
  return document;
};

const withFiveColorants = (): ReturnType<typeof loadDocument> => {
  const document = loadDocument(deviceNPdf.bytes);
  const page = document.get(document.page(0).reference);
  if (page.kind !== 'dictionary') throw new Error('page is missing');
  const resources = document.page(0).resources();
  const spaces = resources.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('ColorSpace resources are missing');
  const value = spaces.entries.get(pdfName('CS2').bytes);
  if (value?.kind !== 'array') throw new Error('DeviceN is missing');
  const names = value.items.at(1);
  if (names?.kind !== 'array') throw new Error('DeviceN colorants are missing');
  names.items.push(pdfName('SpotC'), pdfName('SpotD'), pdfName('SpotE'));
  spaces.entries.set(pdfName('CS2').bytes, value);
  page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
  document.set(document.page(0).reference, page);
  return document;
};

const alternateOf = (document: ReturnType<typeof loadDocument>, objectNumber: number, resourceName?: string): string => {
  const object = document.get({ kind: 'reference', objectNumber, generation: 0 });
  if (object.kind !== 'stream') throw new Error('object is not a stream');
  let color = object.dictionary.get(pdfName('ColorSpace').bytes);
  if (resourceName !== undefined) {
    const resources = object.dictionary.get(pdfName('Resources').bytes);
    if (resources?.kind !== 'dictionary') throw new Error('form resources are missing');
    const spaces = resources.entries.get(pdfName('ColorSpace').bytes);
    if (spaces?.kind !== 'dictionary') throw new Error('form ColorSpace is missing');
    color = spaces.entries.get(pdfName(resourceName).bytes);
  }
  if (color?.kind !== 'array') throw new Error('spot colour space is missing');
  const alternate = color.items.at(2);
  if (alternate?.kind !== 'name') throw new Error('spot alternate is missing');
  return new TextDecoder('latin1').decode(alternate.bytes);
};

const streamData = (value: PdfObject): Uint8Array => {
  if (value.kind !== 'stream') throw new Error('object is not a stream');
  return value.data;
};

const boundNumber = (value: PdfObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real' && typeof value.value === 'number') return value.value;
  throw new Error('bound is not numeric');
};

const stitchedBounds = (document: ReturnType<typeof loadDocument>): readonly number[] => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('ColorSpace resources are missing');
  const color = spaces.entries.get(pdfName('CS1').bytes);
  if (color?.kind !== 'array') throw new Error('Separation is missing');
  const tint = color.items.at(3);
  if (tint?.kind !== 'reference') throw new Error('tint function is missing');
  const object = document.get(tint);
  if (object.kind !== 'dictionary') throw new Error('stitching function is missing');
  const type = object.entries.get(pdfName('FunctionType').bytes);
  const bounds = object.entries.get(pdfName('Bounds').bytes);
  if (type?.kind !== 'integer' || type.value !== 3 || bounds?.kind !== 'array') throw new Error('hard stop was not preserved');
  return bounds.items.map(value => boundNumber(value));
};

const spotGrid = (document: ReturnType<typeof loadDocument>): number => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('ColorSpace resources are missing');
  const color = spaces.entries.get(pdfName('CS1').bytes);
  if (color?.kind !== 'array') throw new Error('Separation is missing');
  const tint = color.items.at(3);
  if (tint?.kind !== 'reference') throw new Error('tint function is missing');
  const object = document.get(tint);
  if (object.kind !== 'stream') throw new Error('sampled tint function is missing');
  const size = object.dictionary.get(pdfName('Size').bytes);
  if (size?.kind !== 'array' || size.items[0]?.kind !== 'integer') throw new Error('sample grid is missing');
  return size.items[0].value;
};

describe('spot alternate conversion', () => {
  it('keeps a Shift_JIS Separation name byte-identical and composes its tint', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const saved = loadDocument(document.save().toBytes());
    const converted = spot(saved);
    const expected = new Float64Array(4);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    transform.convert(Float64Array.of(0.5, 0.5, 0.5), expected);
    expect(report.separations).toBe(1);
    expect(converted.name).toStrictEqual(Uint8Array.of(0x82, 0x62, 0x82, 0x74, 0x82, 0x73));
    expect(converted.alternate).toBe('DeviceCMYK');
    expect(closeChannels(converted.evaluate(0.5), expected)).toStrictEqual([true, true, true, true]);
  });

  it('samples a two-colorant DeviceN tint into CMYK', () => {
    const document = loadDocument(deviceNPdf.bytes);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = deviceN(document);
    const expected = new Float64Array(4);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    transform.convert(Float64Array.of(0.25, 0.25, 0.25), expected);
    expect(report.deviceN).toBe(1);
    expect(converted.names).toStrictEqual([new TextEncoder().encode('SpotA'), new TextEncoder().encode('SpotB')]);
    expect(converted.alternate).toBe('DeviceCMYK');
    expect(closeChannels(converted.evaluate(0.5, 0.5), expected)).toStrictEqual([true, true, true, true]);
  });

  it('refuses an NChannel process space that remains RGB', () => {
    const document = withRgbProcess();
    expect(() => {
      convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    }).toThrow(expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'nchannel-process' }));
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
});

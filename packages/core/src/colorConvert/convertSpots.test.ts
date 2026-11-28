import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
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
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { convertSpotSpaces } from './convertSpots.ts';
import { convertToCmyk } from './convertToCmyk.ts';

const source = parseIccProfile(srgbBytes);
const destination = parseIccProfile(fograBytes);
const rgbTransform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });

const SEPARATION_A = '[/Separation/A/DeviceRGB<</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[1 0 0]/N 1>>]';
const SEPARATION_B = '[/Separation/B/DeviceCMYK<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 1>>]';
const RGB_TINT = { number: 6, body: streamBody('/FunctionType 4/Domain[0 1 0 1]/Range[0 1 0 1 0 1]', '{ pop 1 exch sub dup dup }') };
const CMYK_TINT = { number: 6, body: streamBody('/FunctionType 4/Domain[0 1 0 1]/Range[0 1 0 1 0 1 0 1]', '{ pop 0 0 0 }') };

const deviceNDocument = (resources: string, objects: ReadonlyArray<TestObject>, content = '/CS2 cs 1 0 scn 0 0 10 10 re f'): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<<${resources}>>>>` },
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

const functionOf = (document: LoadedDocument, value: PdfDirectObject | undefined): PdfFunction => {
  const internals = internalsOf(document);
  if (value === undefined || internals === undefined) {
    throw new Error('function is missing');
  }
  const resolve = (item: PdfDirectObject): PdfObject => {
    const object = item.kind === 'reference' ? document.get(item) : item;
    if (object.kind !== 'stream') {
      return object;
    }
    const data = decodedData(internals, object);
    if (typeof data === 'string') {
      throw new TypeError(data);
    }
    return { kind: 'stream', dictionary: object.dictionary, data };
  };
  return createPdfFunction(resolve(value), resolve);
};

const pageSpace = (document: LoadedDocument, name: string): ReadonlyArray<PdfDirectObject> => {
  const spaces = internalsOf(document)?.objects.deref(document.page(0).resources().get(pdfName('ColorSpace').bytes));
  const value = spaces?.kind === 'dictionary' ? internalsOf(document)?.objects.deref(spaces.entries.get(pdfName(name).bytes)) : undefined;
  if (value?.kind !== 'array') {
    throw new Error(`${name} is missing`);
  }
  return value.items;
};

const colorantsOf = (document: LoadedDocument, items: ReadonlyArray<PdfDirectObject>): PdfObject | undefined => {
  const internals = internalsOf(document);
  const attributes = internals?.objects.deref(items.at(4));
  return attributes?.kind === 'dictionary' ? internals?.objects.deref(attributes.entries.get(pdfName('Colorants').bytes)) : undefined;
};

const colorant = (document: LoadedDocument, items: ReadonlyArray<PdfDirectObject>, name: string): ReadonlyArray<PdfDirectObject> => {
  const colorants = colorantsOf(document, items);
  const space = colorants?.kind === 'dictionary' ? internalsOf(document)?.objects.deref(colorants.entries.get(pdfName(name).bytes)) : undefined;
  if (space?.kind !== 'array') {
    throw new Error(`Colorants ${name} is missing`);
  }
  return space.items;
};

const expectConvertedA = (document: LoadedDocument, items: ReadonlyArray<PdfDirectObject>): void => {
  const space = colorant(document, items, 'A');
  const tint = functionOf(document, space.at(3));
  expect(space.slice(0, 3)).toStrictEqual([pdfName('Separation'), pdfName('A'), pdfName('DeviceCMYK')]);
  expect([close(tint([0]), cmykOf(1, 1, 1)), close(tint([1]), cmykOf(1, 0, 0))]).toStrictEqual([true, true]);
};

// ISO 32000-1:2008, 8.6.6.5, Table 71: each Colorants entry is a Separation colour space for one of the DeviceN colorants.
describe('DeviceN Colorants', () => {
  it('converts an RGB Colorants entry of an RGB DeviceN and keeps a CMYK one', () => {
    const space = `[/DeviceN[/A/B]/DeviceRGB 6 0 R<</Colorants<</A ${SEPARATION_A}/B ${SEPARATION_B}>>>>]`;
    const document = deviceNDocument(`/ColorSpace<</CS2${space}>>`, [RGB_TINT]);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const items = pageSpace(document, 'CS2');
    expect({ deviceN: report.deviceN, separations: report.separations }).toStrictEqual({ deviceN: 1, separations: 1 });
    expect(items.at(2)).toStrictEqual(pdfName('DeviceCMYK'));
    expectConvertedA(document, items);
    const original = deviceNDocument(`/ColorSpace<</CS2${space}>>`, [RGB_TINT]);
    expect(colorant(document, items, 'B')).toStrictEqual(colorant(original, pageSpace(original, 'CS2'), 'B'));
  });

  it('converts an RGB Colorants entry of a DeviceN whose own alternate is already CMYK', () => {
    const document = deviceNDocument(`/ColorSpace<</CS2[/DeviceN[/A/B]/DeviceCMYK 6 0 R<</Colorants<</A ${SEPARATION_A}>>>>]>>`, [CMYK_TINT]);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const items = pageSpace(document, 'CS2');
    expect({ deviceN: report.deviceN, separations: report.separations }).toStrictEqual({ deviceN: 0, separations: 1 });
    expect(items.slice(2, 4)).toStrictEqual([pdfName('DeviceCMYK'), pdfReference(6, 0)]);
    expectConvertedA(document, items);
  });

  it.each([
    { family: 'Separation', space: SEPARATION_B },
    { family: 'DeviceN', space: '[/DeviceN[/A/B]/DeviceCMYK 6 0 R]' },
  ])('leaves a resource name that names a $family space needing no conversion', ({ space }) => {
    const document = deviceNDocument(`/ColorSpace<</CS2/Other/Other${space}>>`, [CMYK_TINT]);
    const report = convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect({ deviceN: report.deviceN, separations: report.separations }).toStrictEqual({ deviceN: 0, separations: 0 });
  });

  it('converts a Colorants entry reached through an indirect attributes and Colorants dictionary', () => {
    const document = deviceNDocument('/ColorSpace<</CS2[/DeviceN[/A/B]/DeviceRGB 6 0 R 7 0 R]>>', [
      RGB_TINT,
      { number: 7, body: '<</Colorants 8 0 R>>' },
      { number: 8, body: '<</A 9 0 R>>' },
      { number: 9, body: SEPARATION_A },
    ]);
    expect(convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).separations).toBe(1);
    expectConvertedA(document, pageSpace(document, 'CS2'));
  });

  it('converts a Colorants entry of a DeviceN image colour space', () => {
    const document = deviceNDocument(
      '/XObject<</Im 5 0 R>>',
      [
        {
          number: 5,
          body: streamBody(
            `/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace[/DeviceN[/A]/DeviceCMYK<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[1 0 0 0]/N 1>><</Colorants<</A ${SEPARATION_A}>>>>]`,
            String.fromCodePoint(128),
          ),
        },
      ],
      '/Im Do',
    );
    expect(convertSpotSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).separations).toBe(1);
    const image = document.get(pdfReference(5, 0));
    const space = image.kind === 'stream' ? image.dictionary.get(pdfName('ColorSpace').bytes) : undefined;
    expectConvertedA(document, space?.kind === 'array' ? space.items : []);
  });

  it('converts a DeviceN Colorants entry when the whole document is converted and saved', () => {
    const document = deviceNDocument(
      `/ColorSpace<</CS2[/DeviceN[/A]/DeviceCMYK<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[1 0 0 0]/N 1>><</Colorants<</A ${SEPARATION_A}>>>>]>>`,
      [],
      '/CS2 cs 1 scn 0 0 10 10 re f',
    );
    const report = convertToCmyk(document, { sourceRgbProfile: srgbBytes, outputProfile: fograBytes, outputIntent: { outputConditionIdentifier: 'FOGRA28' } });
    const reloaded = loadDocument(document.save().toBytes());
    expect(report.spots.separations).toBe(1);
    expectConvertedA(reloaded, pageSpace(reloaded, 'CS2'));
  });
});

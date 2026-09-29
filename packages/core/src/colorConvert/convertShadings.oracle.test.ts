import type { PdfObject, PdfReference } from '../object/pdfObject.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stdout } from 'node:process';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { deltaE2000 } from '../color/deltaE2000.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { convertShadings } from './convertShadings.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const toPcs = sourceEvaluator(destination, 'relativeColorimetric', 'icc');

const lab = (channels: readonly number[] | Float64Array): readonly number[] => {
  const pcs = toPcs([...channels]);
  return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
};
const pdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Sh1 sh') },
      { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Domain[0 1]/Background[0.25 0.5 0.75]/Function 6 0 R>>' },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const shadingPatternPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Pattern<</P 7 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 100 100 re f') },
      { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>' },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
      { number: 7, body: '<</Type/Pattern/PatternType 2/Shading 5 0 R>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const directShadingPatternPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Pattern<</P 7 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 100 100 re f') },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
      { number: 7, body: '<</Type/Pattern/PatternType 2/Shading<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const directPatternColor = (document: ReturnType<typeof loadDocument>): PdfObject | undefined => {
  const pattern = document.get(pdfReference(7, 0));
  if (pattern.kind !== 'dictionary') throw new Error('shading pattern is missing');
  const shading = pattern.entries.get(pdfName('Shading').bytes);
  if (shading?.kind !== 'dictionary') throw new Error('direct shading is missing');
  return shading.entries.get(pdfName('ColorSpace').bytes);
};

const functionPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Sh1 sh') },
      { number: 5, body: '<</ShadingType 1/ColorSpace/DeviceRGB/Domain[0 1 0 1]/Function 6 0 R>>' },
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

const radialPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Sh1 sh') },
      { number: 5, body: '<</ShadingType 3/ColorSpace/DeviceRGB/Coords[0 0 0 50 50 75]/Function[6 0 R 7 0 R 8 0 R]>>' },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1]/C1[0]/N 1>>' },
      { number: 7, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[0]/N 1>>' },
      { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' },
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
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Sh1 sh') },
      { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>' },
      {
        number: 6,
        body: '<</FunctionType 3/Domain[0 1]/Functions[7 0 R 8 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>',
      },
      { number: 7, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[1 0 0]/N 1>>' },
      { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 1]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const radialStitchedPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Sh1 sh') },
      { number: 5, body: '<</ShadingType 3/ColorSpace/DeviceRGB/Coords[0 0 0 50 50 75]/Function 6 0 R>>' },
      { number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions[7 0 R 8 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' },
      { number: 7, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[1 0 0]/N 1>>' },
      { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 1]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const directShadingPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>>>>>>>',
      },
      { number: 4, body: streamBody('', '/Sh1 sh') },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const formShadingPdf = buildPdf([
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
          '/Type/XObject/Subtype/Form/BBox[0 0 100 100]/Resources<</Shading<</Sh1<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>>>>>',
          '/Sh1 sh',
        ),
      },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

interface ConvertedShading {
  readonly space: string;
  readonly background: readonly number[];
  readonly evaluate: (value: number) => number[];
}

const numberValue = (value: PdfObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real' && typeof value.value === 'number') return value.value;
  throw new Error('shading number is invalid');
};

const closeChannels = (actual: readonly number[], expected: Float64Array): boolean[] =>
  actual.map((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 0.005);

const shadingFunction = (document: ReturnType<typeof loadDocument>): ((input: readonly number[]) => number[]) => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'dictionary') throw new Error('shading is missing');
  const reference = shading.entries.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') throw new Error('converted shading function is missing');
  const functionStream = document.get(reference);
  const internals = internalsOf(document);
  if (functionStream.kind !== 'stream' || internals === undefined) throw new Error('shading function stream is missing');
  const bytes = decodedData(internals, functionStream);
  if (typeof bytes === 'string') throw new Error(bytes);
  return createPdfFunction({ kind: 'stream', dictionary: functionStream.dictionary, data: bytes });
};

const sampledGrid = (document: ReturnType<typeof loadDocument>, reference: PdfReference): number => {
  const object = document.get(reference);
  if (object.kind !== 'stream') throw new Error('sampled function is missing');
  const size = object.dictionary.get(pdfName('Size').bytes);
  const first = size?.kind === 'array' ? size.items[0] : undefined;
  if (first?.kind !== 'integer') throw new Error('sample grid is missing');
  return first.value;
};

const shadingGrid = (document: ReturnType<typeof loadDocument>): number => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'dictionary') throw new Error('shading is missing');
  const functionValue = shading.entries.get(pdfName('Function').bytes);
  if (functionValue?.kind !== 'reference') throw new Error('function is missing');
  return sampledGrid(document, functionValue);
};

const stitchedGrids = (document: ReturnType<typeof loadDocument>): readonly number[] => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'dictionary') throw new Error('shading is missing');
  const functionReference = shading.entries.get(pdfName('Function').bytes);
  if (functionReference?.kind !== 'reference') throw new Error('stitched function is missing');
  const stitched = document.get(functionReference);
  if (stitched.kind !== 'dictionary') throw new Error('stitched function is invalid');
  const children = stitched.entries.get(pdfName('Functions').bytes);
  if (children?.kind !== 'array') throw new Error('stitched children are missing');
  return children.items.map(child => {
    if (child.kind !== 'reference') throw new Error('stitched child reference is missing');
    return sampledGrid(document, child);
  });
};

const shadingStop = (document: ReturnType<typeof loadDocument>): number => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'dictionary') throw new Error('shading is missing');
  const reference = shading.entries.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') throw new Error('shading function is missing');
  const functionObject = document.get(reference);
  if (functionObject.kind !== 'dictionary') throw new Error('stitching function is missing');
  const type = functionObject.entries.get(pdfName('FunctionType').bytes);
  const bounds = functionObject.entries.get(pdfName('Bounds').bytes);
  if (type?.kind !== 'integer' || type.value !== 3 || bounds?.kind !== 'array') throw new Error('shading hard stop was lost');
  const [stop] = bounds.items;
  return stop === undefined ? -1 : numberValue(stop);
};

const shadingCoordsKind = (document: ReturnType<typeof loadDocument>): string | undefined => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'dictionary') throw new Error('shading is missing');
  return shading.entries.get(pdfName('Coords').bytes)?.kind;
};

const directShadingSpace = (document: ReturnType<typeof loadDocument>): string => {
  const resources = document.page(0).resources();
  const category = resources.get(pdfName('Shading').bytes);
  if (category?.kind !== 'dictionary') throw new Error('Shading resources are missing');
  const shading = category.entries.get(pdfName('Sh1').bytes);
  if (shading?.kind !== 'dictionary') throw new Error('direct shading is missing');
  const color = shading.entries.get(pdfName('ColorSpace').bytes);
  if (color?.kind !== 'name') throw new Error('shading colour space is missing');
  return new TextDecoder('latin1').decode(color.bytes);
};

const formShadingSpace = (document: ReturnType<typeof loadDocument>): string => {
  const form = document.get(pdfReference(5, 0));
  if (form.kind !== 'stream') throw new Error('form is missing');
  const resources = form.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') throw new Error('form resources are missing');
  const category = resources.entries.get(pdfName('Shading').bytes);
  if (category?.kind !== 'dictionary') throw new Error('form Shading resources are missing');
  const shading = category.entries.get(pdfName('Sh1').bytes);
  if (shading?.kind !== 'dictionary') throw new Error('form shading is missing');
  const color = shading.entries.get(pdfName('ColorSpace').bytes);
  if (color?.kind !== 'name') throw new Error('form shading ColorSpace is missing');
  return new TextDecoder('latin1').decode(color.bytes);
};

const convertedShading = (document: ReturnType<typeof loadDocument>): ConvertedShading => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'dictionary') throw new Error('shading is missing');
  const color = shading.entries.get(pdfName('ColorSpace').bytes);
  const background = shading.entries.get(pdfName('Background').bytes);
  const functionReference = shading.entries.get(pdfName('Function').bytes);
  if (color?.kind !== 'name' || background?.kind !== 'array' || functionReference?.kind !== 'reference') throw new Error('converted shading is invalid');
  const functionStream = document.get(functionReference);
  const internals = internalsOf(document);
  if (functionStream.kind !== 'stream' || internals === undefined) throw new Error('shading function is missing');
  const bytes = decodedData(internals, functionStream);
  if (typeof bytes === 'string') throw new Error(bytes);
  const evaluate = createPdfFunction({ kind: 'stream', dictionary: functionStream.dictionary, data: bytes });
  return {
    space: new TextDecoder('latin1').decode(color.bytes),
    background: background.items.map(item => numberValue(item)),
    evaluate: value => evaluate([value]),
  };
};

const patternShadingColor = (document: ReturnType<typeof loadDocument>) => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'dictionary') throw new Error('pattern shading is missing');
  return shading.entries.get(pdfName('ColorSpace').bytes);
};

describe('function shading conversion', () => {
  it('converts an axial shading named by a shading pattern', () => {
    const document = loadDocument(shadingPatternPdf.bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(patternShadingColor(document)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(report.shadings).toBe(1);
  });

  it('converts a direct axial shading inside a shading pattern', () => {
    const document = loadDocument(directShadingPatternPdf.bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(directPatternColor(document)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(report.shadings).toBe(1);
  });

  it('converts axial RGB functions and the Background to CMYK', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const shading = convertedShading(document);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Float64Array(4);
    transform.convert(Float64Array.of(0.5, 0, 0.5), expected);
    expect(report.shadings).toBe(1);
    expect(shading.space).toBe('DeviceCMYK');
    expect(shading.background).toHaveLength(4);
    const difference = deltaE2000(lab(shading.evaluate(0.5)), lab(expected));
    expect(difference).toBeLessThanOrEqual(0.5);
  });

  it.each([
    { name: 'axial', bytes: pdf.bytes },
    { name: 'radial', bytes: radialPdf.bytes },
  ])('refines a saturated Type 2 $name function by its CMYK midpoint error', ({ name, bytes }) => {
    const document = loadDocument(bytes);
    convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const grid = shadingGrid(document);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const sampled = shadingFunction(document);
    let maximum = 0;
    for (let index = 0; index < grid - 1; index++) {
      const t = (index + 0.5) / (grid - 1);
      const exact = new Float64Array(4);
      transform.convert(Float64Array.of(1 - t, 0, t), exact);
      const difference = deltaE2000(lab(exact), lab(sampled([t])));
      maximum = Math.max(maximum, difference);
    }
    expect(grid).toBeGreaterThan(2);
    expect(grid).toBeLessThan(256);
    expect(maximum).toBeLessThanOrEqual(0.5);
    stdout.write(`${name} Type 2 grid: ${String(grid)}, midpoint max: ${String(maximum)}\n`);
  });

  it('samples a two-input function shading on a 65 by 65 grid', () => {
    const document = loadDocument(functionPdf.bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Float64Array(4);
    transform.convert(Float64Array.of(0.25, 0.25, 0.25), expected);
    expect(report.shadings).toBe(1);
    expect(closeChannels(shadingFunction(document)([0.5, 0.5]), expected)).toStrictEqual([true, true, true, true]);
  });

  it('converts a radial Function array without changing its coordinates', () => {
    const document = loadDocument(radialPdf.bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Float64Array(4);
    transform.convert(Float64Array.of(0.5, 0, 0.5), expected);
    expect(report.shadings).toBe(1);
    const sampled = shadingFunction(document);
    const difference = deltaE2000(lab(sampled([0.5])), lab(expected));
    expect(difference).toBeLessThanOrEqual(0.5);
    expect(shadingCoordsKind(document)).toBe('array');
  });

  it.each([
    { name: 'axial', bytes: stitchedPdf.bytes },
    { name: 'radial', bytes: radialStitchedPdf.bytes },
  ])('preserves a Type 3 $name shading function boundary', ({ name, bytes }) => {
    const document = loadDocument(bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.shadings).toBe(1);
    expect(shadingStop(document)).toBe(0.5);
    expect(stitchedGrids(document)).toStrictEqual([2, 2]);
    expect([document.get(pdfReference(7, 0)).kind, document.get(pdfReference(8, 0)).kind]).toStrictEqual(['null', 'null']);
    stdout.write(`${name} Type 3 child grids: 2, 2\n`);
  });

  it('converts a direct shading resource without losing its name', () => {
    const document = loadDocument(directShadingPdf.bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.shadings).toBe(1);
    expect(directShadingSpace(document)).toBe('DeviceCMYK');
  });

  it('converts a direct shading in a form resource dictionary', () => {
    const document = loadDocument(formShadingPdf.bytes);
    const report = convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.shadings).toBe(1);
    expect(formShadingSpace(document)).toBe('DeviceCMYK');
  });

  it('uses the rendering intent active at the sh operator', () => {
    const fromPage = loadDocument(pdf.bytes);
    const fixed = loadDocument(pdf.bytes);
    fromPage.replaceStreamData(pdfReference(4, 0), latin1Bytes('/Perceptual ri /Sh1 sh'), { filter: 'FlateDecode' });
    convertShadings(fromPage, { sourceRgbProfile: source, outputProfile: destination });
    convertShadings(fixed, { sourceRgbProfile: source, outputProfile: destination, intent: 'perceptual' });
    expect(shadingFunction(fromPage)([0.5])).toStrictEqual(shadingFunction(fixed)([0.5]));
  });

  it.each([
    { name: 'axial', bytes: pdf.bytes },
    { name: 'function', bytes: functionPdf.bytes },
    { name: 'radial', bytes: radialPdf.bytes },
    { name: 'stitched', bytes: stitchedPdf.bytes },
    { name: 'direct', bytes: directShadingPdf.bytes },
    { name: 'form', bytes: formShadingPdf.bytes },
  ])('writes a valid $name shading file', async ({ bytes }) => {
    const document = loadDocument(bytes);
    convertShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-shading-'));
    try {
      const file = path.join(directory, 'converted.pdf');
      await writeFile(file, document.save().toBytes());
      const child = spawn('qpdf', ['--check', file]);
      const events: readonly unknown[] = await once(child, 'close');
      const code = events.at(0);
      expect(code).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

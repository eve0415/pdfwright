import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB2014.icc?icc-bytes';
import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { convertToCmyk } from './convertToCmyk.ts';

const convert = (resources: string, content: string, objects: readonly TestObject[]) => {
  const { bytes } = buildPdf([
    {
      xref: 'classic',
      trailer: '/Root 1 0 R',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<${resources}>>/Contents 4 0 R>>` },
        { number: 4, body: streamBody('', content) },
        ...objects,
      ],
    },
  ]);
  const report = convertToCmyk(loadDocument(bytes), {
    sourceRgbProfile: srgbBytes,
    outputProfile: fograBytes,
    outputIntent: { outputConditionIdentifier: 'FOGRA28' },
  });
  return { shadings: report.shadings.shadings, meshes: report.meshes.meshes, separations: report.spots.separations };
};

const axial = (functionObjects: readonly TestObject[]) =>
  convert('/Shading<</Sh 5 0 R>>', '/Sh sh', [
    { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>' },
    ...functionObjects,
  ]);

// Each vertex is an 8-bit flag, x, y and t.
const triangle = String.fromCodePoint(0, 0, 0, 0, 0, 100, 0, 128, 0, 0, 100, 255);

describe('function dictionaries with indirect entries', () => {
  it('converts an axial shading whose exponential function has indirect entries', () => {
    expect(
      axial([
        { number: 6, body: '<</FunctionType 7 0 R/Domain 8 0 R/C0 9 0 R/C1[1 10 0 R 1]/N 7 0 R>>' },
        { number: 7, body: '2' },
        { number: 8, body: '[0 1]' },
        { number: 9, body: '[0 0 0]' },
        { number: 10, body: '0.5' },
      ]),
    ).toStrictEqual({ shadings: 1, meshes: 0, separations: 0 });
  });

  it('converts an axial stitching function with an indirect Functions array', () => {
    expect(
      axial([
        { number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions 7 0 R/Bounds 10 0 R/Encode[0 1 0 1]>>' },
        { number: 7, body: '[8 0 R 9 0 R]' },
        { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 1 0]/N 1>>' },
        { number: 9, body: '<</FunctionType 2/Domain[0 1]/C0[0 1 0]/C1[0 0 1]/N 1>>' },
        { number: 10, body: '[0.5]' },
      ]),
    ).toStrictEqual({ shadings: 1, meshes: 0, separations: 0 });
  });

  it('converts a parametric mesh whose stitched subfunction has an indirect Domain', () => {
    expect(
      convert('/Shading<</Sh 5 0 R>>', '/Sh sh', [
        {
          number: 5,
          body: streamBody(
            '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 8/Decode[0 100 0 100 0 1]/Function 6 0 R',
            triangle,
          ),
        },
        { number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions[7 0 R 8 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' },
        { number: 7, body: '<</FunctionType 2/Domain 9 0 R/C0[1 0 0]/C1[0 1 0]/N 1>>' },
        { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[0 1 0]/C1[0 0 1]/N 1>>' },
        { number: 9, body: '[0 1]' },
      ]),
    ).toStrictEqual({ shadings: 0, meshes: 1, separations: 0 });
  });

  it('converts a Separation whose tint transform has an indirect Domain', () => {
    expect(
      convert('/ColorSpace<</CS0[/Separation/Spot/DeviceRGB 6 0 R]>>', '/CS0 cs 1 scn 0 0 10 10 re f', [
        { number: 6, body: '<</FunctionType 2/Domain 7 0 R/C0[1 1 1]/C1[1 0 0]/N 1>>' },
        { number: 7, body: '[0 1]' },
      ]),
    ).toStrictEqual({ shadings: 0, meshes: 0, separations: 1 });
  });
});

describe('nested stitching functions', () => {
  it('converts an axial stitching function whose subfunctions stitch indirect functions', () => {
    expect(
      axial([
        { number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions[7 0 R 8 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' },
        { number: 7, body: '<</FunctionType 3/Domain[0 1]/Functions[9 0 R 10 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' },
        { number: 8, body: '<</FunctionType 3/Domain 11 0 R/Functions[10 0 R 9 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' },
        { number: 9, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 1 0]/N 1>>' },
        { number: 10, body: '<</FunctionType 2/Domain[0 1]/C0[0 1 0]/C1[0 0 1]/N 12 0 R>>' },
        { number: 11, body: '[0 1]' },
        { number: 12, body: '1' },
      ]),
    ).toStrictEqual({ shadings: 1, meshes: 0, separations: 0 });
  });
});

import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { ConvertToCmykOptions } from './convertToCmyk.ts';

import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB2014.icc?icc-bytes';
import syntheticCmykBytes from '../../../../tests/fixtures/icc/synthetic-cmyk.icc?icc-bytes';
import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { pdfArray, pdfLiteralString, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { writeGtsPdfxOutputIntent } from '../pdfx/writeOutputIntent.ts';
import { gammaCurveTag, iccProfileBytes } from '../testing/iccProfileBytes.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { convertToCmyk } from './convertToCmyk.ts';

const converted = (resources: string, content: string, objects: ReadonlyArray<TestObject>) => {
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
  const document = loadDocument(bytes);
  const report = convertToCmyk(document, {
    sourceRgbProfile: srgbBytes,
    outputProfile: fograBytes,
    outputIntent: { outputConditionIdentifier: 'FOGRA28' },
  });
  return { report, document };
};

const convert = (resources: string, content: string, objects: ReadonlyArray<TestObject>) => {
  const { report } = converted(resources, content, objects);
  return { shadings: report.shadings.shadings, meshes: report.meshes.meshes, separations: report.spots.separations };
};

const axial = (functionObjects: ReadonlyArray<TestObject>) =>
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

// Objects 7 to levels + 6 are stitching functions that each refer four times to the object below, and object 6 is a Type 2 function.
const sharedChain = (levels: number, outputs: number): Array<TestObject> => [
  { number: 6, body: `<</FunctionType 2/Domain[0 1]/C0[${' 0'.repeat(outputs)}]/C1[${' 1'.repeat(outputs)}]/N 1>>` },
  ...Array.from({ length: levels }, (_, index) => {
    const below = `${String(index + 6)} 0 R`;
    return {
      number: index + 7,
      body: `<</FunctionType 3/Domain[0 1]/Functions[${below} ${below} ${below} ${below}]/Bounds[0.25 0.5 0.75]/Encode[0 1 0 1 0 1 0 1]>>`,
    };
  }),
];

describe('shared function subtrees', () => {
  it('converts an axial shading whose Function array shares one deep stitching graph', () => {
    const shading = { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function[22 0 R 22 0 R 22 0 R]>>' };
    expect(convert('/Shading<</Sh 5 0 R>>', '/Sh sh', [shading, ...sharedChain(16, 1)])).toStrictEqual({ shadings: 1, meshes: 0, separations: 0 });
  });

  it('converts an axial stitching function whose subfunctions share one deep stitching graph', () => {
    const shading = { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 22 0 R>>' };
    expect(convert('/Shading<</Sh 5 0 R>>', '/Sh sh', [shading, ...sharedChain(16, 3)])).toStrictEqual({ shadings: 1, meshes: 0, separations: 0 });
  });
});

// Object numbers 6 to 12 that are still in use after converting, saving and loading again.
const remainingFunctionObjects = (resources: string, content: string, objects: ReadonlyArray<TestObject>): Array<number> => {
  const saved = converted(resources, content, objects).document.save().toBytes();
  const reloaded = loadDocument(saved);
  return [6, 7, 8, 9, 10, 11, 12].filter(number => reloaded.get(pdfReference(number, 0)).kind !== 'null');
};

// A stitching function whose Functions entry is an indirect array, with a nested stitching child, a shared grandchild and an indirect exponent.
const stitchedGraph = (outputs: string): Array<TestObject> => [
  { number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions 7 0 R/Bounds[0.5]/Encode[0 1 0 1]>>' },
  { number: 7, body: '[8 0 R 9 0 R]' },
  { number: 8, body: '<</FunctionType 3/Domain[0 1]/Functions 10 0 R/Bounds[0.5]/Encode[0 1 0 1]>>' },
  { number: 9, body: `<</FunctionType 2/Domain[0 1]/C0[${outputs}]/C1[${outputs}]/N 11 0 R>>` },
  { number: 10, body: '[9 0 R 12 0 R]' },
  { number: 11, body: '1' },
  { number: 12, body: `<</FunctionType 2/Domain[0 1]/C0[${outputs}]/C1[${outputs}]/N 1>>` },
];

describe('replaced function objects', () => {
  it('deletes every object of an axial shading function graph', () => {
    const shading = { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>' };
    expect(remainingFunctionObjects('/Shading<</Sh 5 0 R>>', '/Sh sh', [shading, ...stitchedGraph('1 0 0')])).toStrictEqual([]);
  });

  it('deletes every object of a parametric mesh function graph', () => {
    const shading = {
      number: 5,
      body: streamBody(
        '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 8/Decode[0 100 0 100 0 1]/Function 6 0 R',
        triangle,
      ),
    };
    expect(remainingFunctionObjects('/Shading<</Sh 5 0 R>>', '/Sh sh', [shading, ...stitchedGraph('0 1 0')])).toStrictEqual([]);
  });

  it('deletes every object of a Separation tint transform graph', () => {
    expect(
      remainingFunctionObjects('/ColorSpace<</CS0[/Separation/Spot/DeviceRGB 6 0 R]>>', '/CS0 cs 1 scn 0 0 10 10 re f', stitchedGraph('0 0 1')),
    ).toStrictEqual([]);
  });
});

interface TestPage {
  readonly resources: string;
  readonly content: string;
}

// Page i is object 100 + 2i with its content stream in 101 + 2i, so fixtures number their own objects below 100.
const documentBytes = (pages: ReadonlyArray<TestPage>, objects: ReadonlyArray<TestObject>, catalog = ''): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      trailer: `/Root 1 0 R/ID[<${'01'.repeat(16)}><${'02'.repeat(16)}>]`,
      objects: [
        { number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` },
        { number: 2, body: `<</Type/Pages/Kids[${pages.map((_, index) => `${String(100 + index * 2)} 0 R`).join(' ')}]/Count ${String(pages.length)}>>` },
        ...pages.flatMap(({ resources, content }, index) => [
          {
            number: 100 + index * 2,
            body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<${resources}>>/Contents ${String(101 + index * 2)} 0 R>>`,
          },
          { number: 101 + index * 2, body: streamBody('', content) },
        ]),
        ...objects,
      ],
    },
  ]).bytes;

const cmykOptions = { sourceRgbProfile: srgbBytes, outputProfile: fograBytes, outputIntent: { outputConditionIdentifier: 'FOGRA28' } } as const;

interface Refusal {
  readonly error: unknown;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
}

// The error a conversion throws, with the saved bytes from before the call and after its rollback.
const refusal = (document: LoadedDocument, options: ConvertToCmykOptions): Refusal => {
  const before = document.save().toBytes();
  try {
    convertToCmyk(document, options);
  } catch (error: unknown) {
    return { error, before, after: document.save().toBytes() };
  }
  throw new Error('the conversion was not refused');
};

const shadingPage = { resources: '/Shading<</Sh 5 0 R>>', content: '/Sh sh' };
const unpainted = { resources: '', content: '0 0 10 10 re f' };

const grayProfile = iccProfileBytes({ profileClass: 'mntr', colorSpace: 'GRAY', pcs: 'XYZ ', tags: [['kTRC', gammaCurveTag(2.2)]] });

describe('conversion options', () => {
  it.each([
    ['a CMYK', fograBytes],
    ['a Gray', grayProfile],
  ])('refuses %s source RGB profile and leaves the document unchanged', (_, sourceRgbProfile) => {
    const { error, before, after } = refusal(loadDocument(documentBytes([unpainted], [])), { ...cmykOptions, sourceRgbProfile });
    expect([error, after]).toStrictEqual([expect.any(ValidationError), before]);
    expect(error).toMatchObject({ reason: 'color-space' });
  });

  it('refuses to replace an existing output intent for another printing condition by default', () => {
    const document = loadDocument(documentBytes([unpainted], []));
    writeGtsPdfxOutputIntent(document, { outputProfile: syntheticCmykBytes, outputConditionIdentifier: 'Synthetic', info: 'Synthetic CMYK' });
    const { error, before, after } = refusal(loadDocument(document.save().toBytes()), cmykOptions);
    expect([error, after]).toStrictEqual([expect.any(ValidationError), before]);
    expect(error).toMatchObject({ reason: 'output-intent-conflict' });
  });

  it('replaces an existing output intent for another printing condition when asked to', () => {
    const existing = loadDocument(documentBytes([unpainted], []));
    writeGtsPdfxOutputIntent(existing, { outputProfile: syntheticCmykBytes, outputConditionIdentifier: 'Synthetic', info: 'Synthetic CMYK' });
    const document = loadDocument(existing.save().toBytes());
    const report = convertToCmyk(document, { ...cmykOptions, outputIntent: { outputConditionIdentifier: 'FOGRA28', existing: 'replace' } });
    const reloaded = loadDocument(document.save().toBytes());
    const intents = reloaded.catalog().get(pdfName('OutputIntents').bytes);
    const intent = intents?.kind === 'array' && intents.items.length === 1 ? intents.items[0] : undefined;
    const entries = intent?.kind === 'reference' ? reloaded.get(intent) : intent;
    if (entries?.kind !== 'dictionary') {
      throw new Error('the reloaded catalog does not hold exactly one output intent');
    }
    expect([report.outputIntent.action, report.outputIntent.removedSubtypes]).toStrictEqual(['replaced', ['GTS_PDFX']]);
    expect(entries.entries.get(pdfName('OutputConditionIdentifier').bytes)).toStrictEqual(pdfLiteralString('FOGRA28'));
  });

  // ISO 15930-7:2010, 6.1 sets the PDF version a PDF/X-4 file declares, so only a conversion with pdfx options lowers the version, and only then are TrimBoxes added.
  it.each([
    ['omitted', undefined, [undefined, undefined, '%PDF-1.7', false]],
    ['false', false, [undefined, undefined, '%PDF-1.7', false]],
    [
      'options',
      { trapped: 'False', metadataDate: pdfDate({ year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }) },
      [{ addedTrimBoxes: [0], addedPageGroups: [] }, 'uuid', '%PDF-1.6', true],
    ],
  ] as const)('runs the PDF/X-4 page and metadata steps only when pdfx is given %s', (_, pdfx, expected) => {
    const document = loadDocument(documentBytes([unpainted], [], '/Version/1.7'));
    const report = convertToCmyk(document, pdfx === undefined ? cmykOptions : { ...cmykOptions, pdfx });
    const saved = document.save().toBytes();
    const reloaded = loadDocument(saved);
    const page = reloaded.get(reloaded.page(0).reference);
    expect([
      report.pageBoxes,
      report.metadata?.documentId.slice(0, 4),
      new TextDecoder('latin1').decode(saved.subarray(0, 8)),
      page.kind === 'dictionary' && page.entries.has(pdfName('TrimBox').bytes),
    ]).toStrictEqual(expected);
  });
});

describe('refused shading functions', () => {
  it('refuses a shading function nested one level past 16 and leaves the document unchanged', () => {
    const shading = { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function[23 0 R 23 0 R 23 0 R]>>' };
    const { error, before, after } = refusal(loadDocument(documentBytes([shadingPage], [shading, ...sharedChain(17, 1)])), cmykOptions);
    expect([error, after]).toStrictEqual([expect.any(ResourceLimitError), before]);
    expect(error).toMatchObject({ code: 'resource-limit' });
  });

  // ISO 32000-1:2008, 8.7.4.5.3 Table 80: a Function array holds one single-output function per colour component, and Domain holds two numbers for an axial shading.
  it.each([
    ['a Function array of two for three components', '/Function[6 0 R 6 0 R]'],
    ['a Function array of four for three components', '/Function[6 0 R 6 0 R 6 0 R 6 0 R]'],
    ['a Domain of four numbers', '/Domain[0 1 0 1]/Function[6 0 R 6 0 R 6 0 R]'],
    ['a stitching function with no subfunctions', '/Function 7 0 R'],
    ['a stitching function whose subfunction is missing', '/Function 8 0 R'],
  ])('refuses an axial shading with %s and leaves the document unchanged', (_, entries) => {
    const objects = [
      { number: 5, body: `<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]${entries}>>` },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' },
      { number: 7, body: '<</FunctionType 3/Domain[0 1]/Functions[]/Bounds[]/Encode[0 1]>>' },
      { number: 8, body: '<</FunctionType 3/Domain[0 1]/Functions[99 0 R]/Bounds[]/Encode[0 1]>>' },
    ];
    const { error, before, after } = refusal(loadDocument(documentBytes([shadingPage], objects)), cmykOptions);
    expect([error, after]).toStrictEqual([expect.any(ValidationError), before]);
    expect(error).toMatchObject({ reason: 'color-space' });
  });

  it.each([
    ['a Function array of three for three components', '/Function[6 0 R 6 0 R 6 0 R]'],
    ['a Domain of two numbers', '/Domain[0.2 0.8]/Function[6 0 R 6 0 R 6 0 R]'],
  ])('converts an axial shading with %s', (_, entries) => {
    const objects = [
      { number: 5, body: `<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]${entries}>>` },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' },
    ];
    expect(convertToCmyk(loadDocument(documentBytes([shadingPage], objects)), cmykOptions).shadings.shadings).toBe(1);
  });
});

const resolved = (document: LoadedDocument, value: PdfObject | undefined): PdfObject | undefined => (value?.kind === 'reference' ? document.get(value) : value);

const pageShading = (document: LoadedDocument, page: number): PdfObject | undefined => {
  const shadings = resolved(document, document.page(page).resources().get(pdfName('Shading').bytes));
  return shadings?.kind === 'dictionary' ? resolved(document, shadings.entries.get(pdfName('Sh').bytes)) : undefined;
};

describe('replaced function objects still in use', () => {
  it('keeps an indirect Bounds array that the converted stitching function still refers to', () => {
    const document = loadDocument(
      documentBytes(
        [shadingPage],
        [
          { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>' },
          { number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions 7 0 R/Bounds 10 0 R/Encode[0 1 0 1]>>' },
          { number: 7, body: '[8 0 R 9 0 R]' },
          { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 1 0]/N 1>>' },
          { number: 9, body: '<</FunctionType 2/Domain[0 1]/C0[0 1 0]/C1[0 0 1]/N 1>>' },
          { number: 10, body: '[0.5]' },
        ],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const reloaded = loadDocument(document.save().toBytes());
    const shading = pageShading(reloaded, 0);
    const wrapper = shading?.kind === 'dictionary' ? resolved(reloaded, shading.entries.get(pdfName('Function').bytes)) : undefined;
    const bounds = wrapper?.kind === 'dictionary' ? resolved(reloaded, wrapper.entries.get(pdfName('Bounds').bytes)) : undefined;
    expect(bounds).toStrictEqual(pdfArray([pdfReal(0.5)]));
  });

  it('keeps a function that a shading on an unconverted page still uses', () => {
    const objects = [
      { number: 5, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function[8 0 R 8 0 R 8 0 R]>>' },
      { number: 6, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 0 100]/Function[8 0 R 8 0 R 8 0 R]>>' },
      { number: 7, body: '<</ShadingType 2/ColorSpace/DeviceCMYK/Coords[0 0 100 100]/Function[8 0 R 8 0 R 8 0 R 8 0 R]>>' },
      { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' },
    ];
    const pages = ['5', '6', '7'].map(number => ({ resources: `/Shading<</Sh ${number} 0 R>>`, content: '/Sh sh' }));
    const document = loadDocument(documentBytes(pages, objects));
    expect(convertToCmyk(document, cmykOptions).shadings.shadings).toBe(2);
    const reloaded = loadDocument(document.save().toBytes());
    const kept = pageShading(reloaded, 2);
    const functions = kept?.kind === 'dictionary' ? kept.entries.get(pdfName('Function').bytes) : undefined;
    expect(functions?.kind === 'array' ? functions.items.map(item => resolved(reloaded, item)?.kind) : functions).toStrictEqual([
      'dictionary',
      'dictionary',
      'dictionary',
      'dictionary',
    ]);
  });
});

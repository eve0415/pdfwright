import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { ConvertToCmykOptions } from './convertToCmyk.ts';

import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB2014.icc?icc-bytes';
import syntheticCmykBytes from '../../../../tests/fixtures/icc/synthetic-cmyk.icc?icc-bytes';
import { pdfDate } from '../date/pdfDate.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { pdfArray, pdfLiteralString, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { writeGtsPdfxOutputIntent } from '../pdfx/writeOutputIntent.ts';
import { gammaCurveTag, iccProfileBytes } from '../testing/iccProfileBytes.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertToCmyk } from './convertToCmyk.ts';
import { MeshBitReader } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';

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

// The decoded content of a stream object, as text.
const streamText = (document: LoadedDocument, number: number): string => {
  const stream = document.get(pdfReference(number, 0));
  const internals = internalsOf(document);
  if (stream.kind !== 'stream' || internals === undefined) {
    throw new Error(`object ${String(number)} is not a stream`);
  }
  const data = decodedData(internals, stream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return latin1Text(data);
};

// The four operands a page writes for an RGB colour set with the given operator, which a form must write for the same colour under an inherited RGB space.
const pageCmyk = (operator: 'rg' | 'RG', rgb: string): string => {
  const document = loadDocument(documentBytes([{ resources: '', content: `${rgb} ${operator} 0 0 10 10 re f` }], []));
  convertToCmyk(document, cmykOptions);
  const page = document.get(document.page(0).reference);
  const contents = page.kind === 'dictionary' ? page.entries.get(pdfName('Contents').bytes) : undefined;
  if (contents?.kind !== 'reference') {
    throw new Error('the converted page has no content stream');
  }
  const cmyk = /^((?:[\d.]+ ){4})[kK] /u.exec(streamText(document, contents.objectNumber))?.[1];
  if (cmyk === undefined) {
    throw new Error('the converted page sets no CMYK colour');
  }
  return cmyk;
};

describe('forms drawn from converted pages', () => {
  // ISO 32000-1:2008, 8.10.1: a form inherits the graphics state in effect at Do; 8.6.8: sc and SC take one operand per component of the current space.
  it.each([
    { name: 'fill', page: '0.2 0.4 0.6 rg', form: '0.9 0.5 0.1 sc', operator: 'rg', paint: 'sc' },
    { name: 'stroke', page: '0.2 0.4 0.6 RG', form: '0.9 0.5 0.1 SC', operator: 'RG', paint: 'SC' },
  ] as const)('converts the $name colour a form sets in the RGB space it inherits from the page', ({ page, form, operator, paint }) => {
    const document = loadDocument(
      documentBytes(
        [{ resources: '/XObject<</Fm 5 0 R>>', content: `${page} /Fm Do` }],
        [{ number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', `${form} 0 0 10 10 re f`) }],
      ),
    );
    const report = convertToCmyk(document, cmykOptions);
    expect(report.forms).toStrictEqual({ forms: 1, clones: 0 });
    expect(streamText(document, 5)).toBe(`${pageCmyk(operator, '0.9 0.5 0.1')}${paint} 0 0 10 10 re f`);
  });

  it('converts the page and both copies of a form it draws under two RGB spaces', () => {
    const document = loadDocument(
      documentBytes(
        [
          {
            resources: '/ColorSpace<</CR[/CalRGB<</WhitePoint[0.9505 1 1.089]>>]>>/XObject<</Fm 5 0 R>>',
            content: '/CR cs 0.1 0.2 0.3 sc /Fm Do 0.2 0.4 0.6 rg /Fm Do',
          },
        ],
        [{ number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0.9 0.5 0.1 sc 0 0 10 10 re f') }],
      ),
    );
    const report = convertToCmyk(document, cmykOptions);
    const page = document.get(document.page(0).reference);
    const contents = page.kind === 'dictionary' ? page.entries.get(pdfName('Contents').bytes) : undefined;
    const xobjects = resolved(document, document.page(0).resources().get(pdfName('XObject').bytes));
    const pageText = contents?.kind === 'reference' ? streamText(document, contents.objectNumber) : 'no content stream';
    const names = [...pageText.matchAll(/\/(\w+) Do/gu)].map(match => match[1] ?? '');
    const forms = names.map(name => {
      const form = xobjects?.kind === 'dictionary' ? xobjects.entries.get(pdfName(name).bytes) : undefined;
      return form?.kind === 'reference' ? streamText(document, form.objectNumber) : `no form ${name}`;
    });
    expect(report.forms).toStrictEqual({ forms: 2, clones: 1 });
    expect(pageText).toMatch(/^\/DeviceCMYK cs (?:[\d.]+ ){4}sc \/\w+ Do (?:[\d.]+ ){4}k \/\w+ Do$/u);
    expect(new Set(names).size).toBe(2);
    expect(forms).toStrictEqual([expect.stringMatching(/^(?:[\d.]+ ){4}sc 0 0 10 10 re f$/u), `${pageCmyk('rg', '0.9 0.5 0.1')}sc 0 0 10 10 re f`]);
    expect(forms[0]).not.toBe(forms[1]);
  });

  // Operands left on the stack before BI are discarded with the inline image.
  it.each([
    { name: 'an inline image', before: '' },
    { name: 'an inline image with stray operands before BI', before: '1 2 ' },
  ] as const)('renames the Do of a form copy that follows $name', ({ before }) => {
    const document = loadDocument(
      documentBytes(
        [
          {
            resources: '/ColorSpace<</CR[/CalRGB<</WhitePoint[0.9505 1 1.089]>>]>>/XObject<</Fm 5 0 R>>',
            content: `${before}BI /W 1 /H 1 /BPC 8 /CS /RGB ID ${String.fromCodePoint(255, 0, 0)} EI /CR cs 0.1 0.2 0.3 sc /Fm Do 0.2 0.4 0.6 rg /Fm Do`,
          },
        ],
        [{ number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0.9 0.5 0.1 sc 0 0 10 10 re f') }],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const page = document.get(document.page(0).reference);
    const contents = page.kind === 'dictionary' ? page.entries.get(pdfName('Contents').bytes) : undefined;
    const xobjects = resolved(document, document.page(0).resources().get(pdfName('XObject').bytes));
    const pageText = contents?.kind === 'reference' ? streamText(document, contents.objectNumber) : 'no content stream';
    const forms = [...pageText.matchAll(/\/(\w+) Do/gu)].map(match => {
      const form = xobjects?.kind === 'dictionary' ? xobjects.entries.get(pdfName(match[1] ?? '').bytes) : undefined;
      return form?.kind === 'reference' ? streamText(document, form.objectNumber) : `no form ${match[1] ?? ''}`;
    });
    expect(pageText).toMatch(/^BI \/W 1 \/H 1 \/BPC 8 \/CS \/CMYK [^]*EI \/DeviceCMYK cs (?:[\d.]+ ){4}sc \/\w+ Do (?:[\d.]+ ){4}k \/\w+ Do$/u);
    expect(forms).toStrictEqual([expect.stringMatching(/^(?:[\d.]+ ){4}sc 0 0 10 10 re f$/u), `${pageCmyk('rg', '0.9 0.5 0.1')}sc 0 0 10 10 re f`]);
    expect(forms[0]).not.toBe(forms[1]);
  });

  it('keeps the colour space set before an inline image with a stray operand for the forms drawn after it', () => {
    const document = loadDocument(
      documentBytes(
        [
          {
            resources: '/ColorSpace<</CR[/CalRGB<</WhitePoint[0.9505 1 1.089]>>]>>/XObject<</Fm 5 0 R>>',
            content: `/CR cs 0.5 BI /W 1 /H 1 /BPC 8 /CS /RGB ID ${String.fromCodePoint(255, 0, 0)} EI 0.1 0.2 0.3 sc /Fm Do 0.2 0.4 0.6 rg /Fm Do`,
          },
        ],
        [{ number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0.9 0.5 0.1 sc 0 0 10 10 re f') }],
      ),
    );
    const report = convertToCmyk(document, cmykOptions);
    const page = document.get(document.page(0).reference);
    const contents = page.kind === 'dictionary' ? page.entries.get(pdfName('Contents').bytes) : undefined;
    const xobjects = resolved(document, document.page(0).resources().get(pdfName('XObject').bytes));
    const pageText = contents?.kind === 'reference' ? streamText(document, contents.objectNumber) : 'no content stream';
    const forms = [...pageText.matchAll(/\/(\w+) Do/gu)].map(match => {
      const form = xobjects?.kind === 'dictionary' ? xobjects.entries.get(pdfName(match[1] ?? '').bytes) : undefined;
      return form?.kind === 'reference' ? streamText(document, form.objectNumber) : `no form ${match[1] ?? ''}`;
    });
    expect(report.forms).toStrictEqual({ forms: 2, clones: 1 });
    expect(pageText).toMatch(/^\/DeviceCMYK cs BI \/W 1 \/H 1 \/BPC 8 \/CS \/CMYK [^]*EI (?:[\d.]+ ){4}sc \/\w+ Do (?:[\d.]+ ){4}k \/\w+ Do$/u);
    expect(forms).toStrictEqual([expect.stringMatching(/^(?:[\d.]+ ){4}sc 0 0 10 10 re f$/u), `${pageCmyk('rg', '0.9 0.5 0.1')}sc 0 0 10 10 re f`]);
    expect(forms[0]).not.toBe(forms[1]);
  });

  it('names the second copy of a form apart from an image in an indirect XObject dictionary', () => {
    const document = loadDocument(
      documentBytes(
        [
          {
            resources: '/ColorSpace<</CR[/CalRGB<</WhitePoint[0.9505 1 1.089]>>]>>/XObject 9 0 R',
            content: '/CR cs 0.1 0.2 0.3 sc /Fm Do 0.2 0.4 0.6 rg /Fm Do /PWFORM0 Do',
          },
        ],
        [
          { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0.9 0.5 0.1 sc 0 0 10 10 re f') },
          { number: 7, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceGray', String.fromCodePoint(10)) },
          { number: 9, body: '<</Fm 5 0 R/PWFORM0 7 0 R>>' },
        ],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const page = document.get(document.page(0).reference);
    const contents = page.kind === 'dictionary' ? page.entries.get(pdfName('Contents').bytes) : undefined;
    const xobjects = resolved(document, document.page(0).resources().get(pdfName('XObject').bytes));
    const pageText = contents?.kind === 'reference' ? streamText(document, contents.objectNumber) : 'no content stream';
    const drawn = [...pageText.matchAll(/\/(\w+) Do/gu)].map(match => {
      const value = xobjects?.kind === 'dictionary' ? resolved(document, xobjects.entries.get(pdfName(match[1] ?? '').bytes)) : undefined;
      return value?.kind === 'stream' ? value.dictionary.get(pdfName('Subtype').bytes) : undefined;
    });
    expect(drawn).toStrictEqual([pdfName('Form'), pdfName('Form'), pdfName('Image')]);
  });
});

// The page paints through a luminosity soft mask whose DeviceRGB group is object 6.
const maskPage = { resources: '/ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>', content: '/GS gs 1 0 0 rg 0 0 10 10 re f' };

const maskGroup = (resources: string, content: string): TestObject => ({
  number: 6,
  body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<<${resources}>>`, content),
});

interface MaskResource {
  readonly entries: PdfDictionaryEntries;
  readonly data: Uint8Array | undefined;
}

// The stream, or the dictionary with its stream data decoded, that the mask group's resources name in the given category.
const maskResource = (document: LoadedDocument, category: string, name: string): MaskResource => {
  const group = document.get(pdfReference(6, 0));
  const internals = internalsOf(document);
  const resources = group.kind === 'stream' ? resolved(document, group.dictionary.get(pdfName('Resources').bytes)) : undefined;
  const named = resources?.kind === 'dictionary' ? resolved(document, resources.entries.get(pdfName(category).bytes)) : undefined;
  const object = named?.kind === 'dictionary' ? resolved(document, named.entries.get(pdfName(name).bytes)) : undefined;
  if (object?.kind === 'dictionary') {
    return { entries: object.entries, data: undefined };
  }
  if (object?.kind !== 'stream' || internals === undefined) {
    throw new Error(`the mask group names no ${category} ${name}`);
  }
  const data = decodedData(internals, object);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return { entries: object.dictionary, data };
};

const maskGroupSpace = (document: LoadedDocument): PdfObject | undefined => {
  const group = document.get(pdfReference(6, 0));
  const attributes = group.kind === 'stream' ? resolved(document, group.dictionary.get(pdfName('Group').bytes)) : undefined;
  return attributes?.kind === 'dictionary' ? attributes.entries.get(pdfName('CS').bytes) : undefined;
};

// Three vertices of a free-form triangle mesh, each a 2-bit flag, 8-bit x and y, and 8-bit red, green and blue.
const rgbTriangle = (): string => {
  const writer = new MeshBitWriter();
  for (const vertex of [
    [0, 0, 255, 0, 0],
    [10, 0, 0, 255, 0],
    [0, 10, 0, 0, 255],
  ]) {
    writer.write(2, 0);
    for (const value of vertex) {
      writer.write(8, value);
    }
    writer.alignByte();
  }
  return latin1Text(writer.finish(1024));
};

const calGray = '[/CalGray<</WhitePoint[0.9505 1 1.089]/Gamma 2.2>>]';
const grayImage = (space: string): TestObject => ({
  number: 9,
  body: streamBody(`/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace${space}`, String.fromCodePoint(128)),
});
const grayProfileObject: TestObject = { number: 10, body: streamBody('/N 1', latin1Text(grayProfile)) };
const grayPaint = [
  { name: 'a CalGray image', resources: '/XObject<</Im 9 0 R>>', content: '/Im Do', objects: [grayImage(calGray)], category: 'XObject', key: 'Im' },
  {
    name: 'an ICC gray image',
    resources: '/XObject<</Im 9 0 R>>',
    content: '/Im Do',
    objects: [grayImage('[/ICCBased 10 0 R]'), grayProfileObject],
    category: 'XObject',
    key: 'Im',
  },
  {
    name: 'a CalGray axial shading',
    resources: '/Shading<</Sh1 9 0 R>>',
    content: '/Sh1 sh',
    objects: [{ number: 9, body: `<</ShadingType 2/ColorSpace${calGray}/Coords[0 0 10 0]/Function<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>>>` }],
    category: 'Shading',
    key: 'Sh1',
  },
] as const;

// ISO 32000-1:2008, 11.6.5.3, Table 146: Matte holds one value per component of the image's colour space, so it cannot stay on the gray image as three RGB values.
const softMasked = (matte: string, mask = '/Width 1/Height 1/BitsPerComponent 8', maskData = String.fromCodePoint(128)): ReadonlyArray<TestObject> => [
  maskGroup('/XObject<</Im 9 0 R>>', '/Im Do'),
  {
    number: 9,
    body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/SMask 10 0 R', String.fromCodePoint(200, 100, 50)),
  },
  {
    number: 10,
    body: streamBody(`/Type/XObject/Subtype/Image${mask}/ColorSpace/DeviceGray${matte}`, maskData),
  },
];

describe('luminosity soft masks', () => {
  // ISO 32000-1:2008, 11.6.5.2, Table 144: a Luminosity soft mask derives its values from its group, which becomes DeviceGray, so red, green and blue paint becomes 0.3, 0.59 and 0.11 gray.
  it('converts an RGB image the mask draws into a gray image', () => {
    const document = loadDocument(
      documentBytes(
        [maskPage],
        [
          maskGroup('/XObject<</Im 9 0 R>>', '/Im Do'),
          {
            number: 9,
            body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB', String.fromCodePoint(255, 0, 0)),
          },
        ],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const image = maskResource(document, 'XObject', 'Im');
    expect([maskGroupSpace(document), image.entries.get(pdfName('ColorSpace').bytes), image.data]).toStrictEqual([
      pdfName('DeviceGray'),
      pdfName('DeviceGray'),
      Uint8Array.of(77),
    ]);
  });

  // ISO 32000-1:2008, 8.9.6.4: a colour-key mask tests the raw RGB samples, so the gray image gets a stencil that keys the same pixels.
  it('keys the same pixels of a colour-keyed RGB image the mask draws as gray', () => {
    const document = loadDocument(
      documentBytes(
        [maskPage],
        [
          maskGroup('/XObject<</Im 9 0 R>>', '/Im Do'),
          {
            number: 9,
            // Red is keyed and green is not, and both become gray 77.
            body: streamBody(
              '/Type/XObject/Subtype/Image/Width 2/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/Mask[200 255 0 10 0 10]',
              String.fromCodePoint(255, 0, 0, 0, 130, 0),
            ),
          },
        ],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const image = maskResource(document, 'XObject', 'Im');
    const key = resolved(document, image.entries.get(pdfName('Mask').bytes));
    const internals = internalsOf(document);
    const stencil = key?.kind === 'stream' && internals !== undefined ? decodedData(internals, key) : 'no stencil mask';
    const entry = (name: string): PdfObject | undefined => (key?.kind === 'stream' ? key.dictionary.get(pdfName(name).bytes) : undefined);
    expect([image.entries.get(pdfName('ColorSpace').bytes), image.data]).toStrictEqual([pdfName('DeviceGray'), Uint8Array.of(77, 77)]);
    expect([entry('ImageMask'), entry('Width'), entry('Height'), entry('BitsPerComponent'), stencil]).toStrictEqual([
      { kind: 'boolean', value: true },
      { kind: 'integer', value: 2 },
      { kind: 'integer', value: 1 },
      { kind: 'integer', value: 1 },
      Uint8Array.of(0b1000_0000),
    ]);
  });

  it('converts an RGB axial shading the mask paints into a gray shading', () => {
    const document = loadDocument(
      documentBytes(
        [maskPage],
        [
          maskGroup('/Shading<</Sh1 9 0 R>>', '/Sh1 sh'),
          { number: 9, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function 10 0 R>>' },
          { number: 10, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
        ],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const shading = maskResource(document, 'Shading', 'Sh1');
    const functionValue = resolved(document, shading.entries.get(pdfName('Function').bytes));
    const internals = internalsOf(document);
    const data = functionValue?.kind === 'stream' && internals !== undefined ? decodedData(internals, functionValue) : 'no sampled function';
    if (functionValue?.kind !== 'stream' || typeof data === 'string') {
      throw new Error('the gray shading has no sampled function');
    }
    const gray = createPdfFunction({ kind: 'stream', dictionary: functionValue.dictionary, data });
    expect([maskGroupSpace(document), shading.entries.get(pdfName('ColorSpace').bytes)]).toStrictEqual([pdfName('DeviceGray'), pdfName('DeviceGray')]);
    expect(gray([0])[0]).toBeCloseTo(0.3, 3);
    expect(gray([1])[0]).toBeCloseTo(0.11, 3);
  });

  it('converts an RGB mesh shading the mask paints into gray vertices', () => {
    const document = loadDocument(
      documentBytes(
        [maskPage],
        [
          maskGroup('/Shading<</Sh1 9 0 R>>', '/Sh1 sh'),
          {
            number: 9,
            body: streamBody(
              '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 10 0 10 0 1 0 1 0 1]',
              rgbTriangle(),
            ),
          },
        ],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const shading = maskResource(document, 'Shading', 'Sh1');
    const reader = new MeshBitReader(shading.data ?? new Uint8Array());
    const records: Array<ReadonlyArray<number>> = [];
    while (reader.remainingBits > 0) {
      records.push([reader.read(2), reader.read(8), reader.read(8), reader.read(8)]);
      reader.alignByte();
    }
    expect([maskGroupSpace(document), shading.entries.get(pdfName('ColorSpace').bytes)]).toStrictEqual([pdfName('DeviceGray'), pdfName('DeviceGray')]);
    expect(records).toStrictEqual([
      [0, 0, 0, 77],
      [0, 10, 0, 150],
      [0, 0, 10, 28],
    ]);
  });

  it('converts a form the page and the mask both draw into CMYK for the page and gray for the mask', () => {
    const document = loadDocument(
      documentBytes(
        [{ resources: `${maskPage.resources}/XObject<</Fm 9 0 R>>`, content: `${maskPage.content} /Fm Do` }],
        [
          maskGroup('/XObject<</Fm 9 0 R>>', '/Fm Do'),
          { number: 9, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0 1 0 rg 0 0 10 10 re f') },
        ],
      ),
    );
    convertToCmyk(document, cmykOptions);
    const masked = maskResource(document, 'XObject', 'Fm');
    expect([latin1Text(masked.data ?? new Uint8Array()), streamText(document, 9)]).toStrictEqual([
      '0.59 g 0 0 10 10 re f',
      expect.stringMatching(/^(?:[\d.]+ ){4}k 0 0 10 10 re f$/u),
    ]);
  });

  // ISO 32000-1:2008, 11.6.5.2: the mask takes its values from the group's own paint, so calibrated gray paint that the other passes would turn into CMYK inside the gray group is refused.
  it.each(grayPaint)('refuses $name in an RGB luminosity mask and leaves the document unchanged', ({ resources, content, objects }) => {
    const { error, before, after } = refusal(loadDocument(documentBytes([maskPage], [maskGroup(resources, content), ...objects])), cmykOptions);
    expect(after).toStrictEqual(before);
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error instanceof Error ? error.message : error).toMatch(/calibrated gray/u);
  });

  it.each(grayPaint)('keeps $name in an RGB luminosity mask when calibrated gray is kept', ({ resources, content, objects, category, key }) => {
    const bytes = documentBytes([maskPage], [maskGroup(resources, content), ...objects]);
    const document = loadDocument(bytes);
    convertToCmyk(document, { ...cmykOptions, iccGray: 'keep' });
    const source = maskResource(loadDocument(bytes), category, key);
    const paint = maskResource(document, category, key);
    const space = pdfName('ColorSpace').bytes;
    expect([maskGroupSpace(document), paint.entries.get(space), paint.data]).toStrictEqual([pdfName('DeviceGray'), source.entries.get(space), source.data]);
  });

  it('refuses an RGB image with a preblended soft mask in an RGB luminosity mask and leaves the document unchanged', () => {
    const { error, before, after } = refusal(loadDocument(documentBytes([maskPage], softMasked('/Matte[1 0 0]'))), cmykOptions);
    expect(after).toStrictEqual(before);
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error instanceof Error ? error.message : error).toMatch(/Matte/u);
  });

  // ISO 32000-1:2008, 11.6.5.3, Table 146: a Matte with other than one value per image component, a preblended soft mask of another size, or a soft mask that is not a valid image (8.9.5) is malformed rather than unsupported.
  it.each([
    { name: 'one Matte value for an RGB image', matte: '/Matte[1]', mask: undefined, maskData: undefined },
    { name: 'a non-numeric Matte value', matte: '/Matte[/A 0 0]', mask: undefined, maskData: undefined },
    { name: 'a preblended soft mask wider than the image', matte: '/Matte[1 0 0]', mask: '/Width 2/Height 1/BitsPerComponent 8', maskData: 'AA' },
    { name: 'a preblended soft mask taller than the image', matte: '/Matte[1 0 0]', mask: '/Width 1/Height 2/BitsPerComponent 8', maskData: 'AA' },
    { name: 'a preblended soft mask of 3 bits per component', matte: '/Matte[1 0 0]', mask: '/Width 1/Height 1/BitsPerComponent 3', maskData: 'A' },
    { name: 'a preblended soft mask with a one-value Decode', matte: '/Matte[1 0 0]', mask: '/Width 1/Height 1/BitsPerComponent 8/Decode[0]', maskData: 'A' },
    { name: 'a preblended soft mask with no samples', matte: '/Matte[1 0 0]', mask: undefined, maskData: '' },
  ])('rejects $name in an RGB luminosity mask as invalid and leaves the document unchanged', ({ matte, mask, maskData }) => {
    const { error, before, after } = refusal(loadDocument(documentBytes([maskPage], softMasked(matte, mask, maskData))), cmykOptions);
    expect(after).toStrictEqual(before);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ reason: 'color-space' });
  });

  it('keeps the soft mask of an RGB image the mask draws as gray when the image is not preblended', () => {
    const document = loadDocument(documentBytes([maskPage], softMasked('')));
    convertToCmyk(document, cmykOptions);
    const image = maskResource(document, 'XObject', 'Im');
    expect([image.entries.get(pdfName('ColorSpace').bytes), image.entries.get(pdfName('SMask').bytes)]).toStrictEqual([
      pdfName('DeviceGray'),
      pdfReference(10, 0),
    ]);
  });

  // ISO 32000-1:2008, 8.10.1 and 11.6.5.2: a form drawn with Do paints with the state at Do, while the same stream as a soft-mask group only supplies mask values.
  it.each([
    { name: 'a luminosity mask', subtype: 'Luminosity', before: '', color: '1 0 0', mask: '0.3 g 0 0 10 10 re f', maskSpace: 'DeviceGray' },
    {
      name: 'a luminosity mask under an RGB fill',
      subtype: 'Luminosity',
      before: '0.2 0.4 0.6 rg ',
      color: '1 0 0',
      mask: '0.3 g 0 0 10 10 re f',
      maskSpace: 'DeviceGray',
    },
    {
      name: 'an alpha mask under the Saturation intent',
      subtype: 'Alpha',
      before: '/Saturation ri ',
      color: '0.2 0.8 0.3',
      mask: undefined,
      maskSpace: 'DeviceCMYK',
    },
  ] as const)('keeps the page colour of a form that is also the group of $name', ({ subtype, before, color, mask, maskSpace }) => {
    const form = maskGroup('', `${color} rg 0 0 10 10 re f`);
    const pageContent = `${before}/Fx Do`;
    const document = loadDocument(
      documentBytes(
        [
          {
            resources: `/ExtGState<</GS<</SMask<</S/${subtype}/G 6 0 R>>>>>>/XObject<</Fx 6 0 R>>`,
            content: `q /GS gs 0 0 1 rg 0 0 10 10 re f Q ${pageContent}`,
          },
        ],
        [form],
      ),
    );
    // The same page without the mask shows what the form must paint when the page draws it.
    const unmasked = loadDocument(documentBytes([{ resources: '/XObject<</Fx 6 0 R>>', content: pageContent }], [form]));
    convertToCmyk(document, cmykOptions);
    convertToCmyk(unmasked, cmykOptions);
    const states = resolved(document, document.page(0).resources().get(pdfName('ExtGState').bytes));
    const state = states?.kind === 'dictionary' ? resolved(document, states.entries.get(pdfName('GS').bytes)) : undefined;
    const softMask = state?.kind === 'dictionary' ? resolved(document, state.entries.get(pdfName('SMask').bytes)) : undefined;
    const group = softMask?.kind === 'dictionary' ? softMask.entries.get(pdfName('G').bytes) : undefined;
    if (group?.kind !== 'reference') {
      throw new Error('the soft mask has no group reference');
    }
    const groupSpace = (number: number): PdfObject | undefined => {
      const stream = document.get(pdfReference(number, 0));
      const attributes = stream.kind === 'stream' ? resolved(document, stream.dictionary.get(pdfName('Group').bytes)) : undefined;
      return attributes?.kind === 'dictionary' ? attributes.entries.get(pdfName('CS').bytes) : undefined;
    };
    expect(group.objectNumber).not.toBe(6);
    expect([streamText(document, 6), groupSpace(6)]).toStrictEqual([streamText(unmasked, 6), pdfName('DeviceCMYK')]);
    expect([streamText(document, group.objectNumber), groupSpace(group.objectNumber)]).toStrictEqual([
      mask ?? `${pageCmyk('rg', color)}k 0 0 10 10 re f`,
      pdfName(maskSpace),
    ]);
  });
});

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

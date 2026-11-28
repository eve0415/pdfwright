import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runChecked, runQpdf } from '../../../../scripts/readerOracle.ts';
import { readContent } from '../content/contentOperations.ts';
import { pageContent } from '../content/pageContent.ts';
import { pdfDate } from '../date/pdfDate.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { createDocument } from '../document/pdfDocument.ts';
import { rect } from '../document/rect.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { pt } from '../length/length.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { checkPdfX4 } from '../pdfx/checkPdfX4.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertToCmyk } from './convertToCmyk.ts';

const sourcePath = fileURLToPath(new URL('../../../../tests/fixtures/icc/sRGB.icm', import.meta.url));
const outputPath = fileURLToPath(new URL('../../../../tests/fixtures/icc/fogra28l.icc', import.meta.url));
const source = Uint8Array.from(await readFile(sourcePath));
const output = Uint8Array.from(await readFile(outputPath));
const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const fixture = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>/Contents 4 0 R>>' },
      { number: 4, body: streamBody('', '0.2 0.4 0.6 rg 10 10 80 80 re f') },
    ],
    trailer: `/Root 1 0 R/ID[<${'01'.repeat(16)}><${'02'.repeat(16)}>]`,
  },
]);

const untagged = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>/Contents 4 0 R>>' },
      { number: 4, body: streamBody('', '0.2 0.4 0.6 rg 10 10 80 80 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]).bytes;

const dictionaryEntries = (value: PdfObject): PdfDictionaryEntries => {
  if (value.kind !== 'dictionary') {
    throw new Error('expected dictionary');
  }
  return value.entries;
};

// The cap is parseIccProfile's 24 MiB default; the header size stays that of the real profile, so only the padding changes the byte count.
const padded = (profile: Uint8Array, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set(profile);
  return bytes;
};

const operatorsOf = (bytes: Uint8Array): ReadonlyArray<string> => {
  const document = loadDocument(bytes);
  const internals = internalsOf(document);
  const entry = internals?.pages[0];
  if (internals === undefined || entry === undefined) {
    throw new Error('page is unavailable');
  }
  const content = pageContent(internals, entry);
  return [...readContent(content.streams, internals.maxNesting)].map(operation => operation.operator);
};

describe('convert to cmyk', () => {
  it('refuses a loaded file with page PieceInfo by default', () => {
    const created = createDocument();
    const page = created.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.pieceInfo({ lastModified: date, data: { Illustrator: { private: { kind: 'boolean', value: true } } } });
    const document = loadDocument(created.save().toBytes());
    expect(() =>
      convertToCmyk(document, {
        sourceRgbProfile: source,
        outputProfile: output,
        outputIntent: { outputConditionIdentifier: 'FOGRA28' },
        pdfx: { trapped: 'False', metadataDate: date },
      }),
    ).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'application-data' }));
  });

  it('composes colour conversion and PDF/X-4 output in one call', () => {
    const document = loadDocument(fixture.bytes);
    const report = convertToCmyk(document, {
      sourceRgbProfile: source,
      outputProfile: output,
      outputIntent: { outputConditionIdentifier: 'FOGRA28' },
      pdfx: { trapped: 'False', metadataDate: date },
    });
    expect(report.page.operators).toBe(1);
    expect(report.pageBoxes?.addedTrimBoxes).toStrictEqual([0]);
    const saved = document.save().toBytes();
    expect(operatorsOf(saved)).toContain('k');
    expect(checkPdfX4(loadDocument(saved)).summary).toBe('no-violation-found-by-these-rules');
  });

  it('converts an RGB image and streams its saved bytes without PDF/X-4 metadata', () => {
    const created = createDocument();
    const image = created.image({ width: 2, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples: Uint8Array.of(255, 0, 0, 0, 0, 255) });
    const page = created.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.image(image, [20, 0, 0, 20, 0, 0]);
    });
    const document = loadDocument(created.save().toBytes());
    const report = convertToCmyk(document, { sourceRgbProfile: source, outputProfile: output, outputIntent: { outputConditionIdentifier: 'FOGRA28' } });
    const saved = document.save();
    expect(report.images.converted).toBe(1);
    expect(saved.kind).toBe('streamed');
    expect(report.metadata).toBeUndefined();
    expect(report.pageBoxes).toBeUndefined();
    const bytes = saved.toBytes();
    expect(latin1Text(bytes.subarray(0, 8))).toBe('%PDF-1.7');
    const reloaded = loadDocument(bytes);
    expect(reloaded.catalog().has(pdfName('Metadata').bytes)).toBe(false);
    expect(dictionaryEntries(reloaded.get(reloaded.page(0).reference)).has(pdfName('TrimBox').bytes)).toBe(false);
  });

  it('leaves saved bytes identical when a later compressed-image refusal occurs', () => {
    const input = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</XObject<</Im 5 0 R>>>>/Contents 4 0 R>>' },
          { number: 4, body: streamBody('', '0.2 0.4 0.6 rg /Im Do') },
          { number: 5, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/DCTDecode', 'JPEG') },
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes;
    const document = loadDocument(input);
    const beforeSave = document.save();
    const before = beforeSave.toBytes();
    expect(() =>
      convertToCmyk(document, {
        sourceRgbProfile: source,
        outputProfile: output,
        outputIntent: { outputConditionIdentifier: 'FOGRA28' },
        compressedRgbImages: 'refuse',
        pdfx: { trapped: 'False', metadataDate: date },
      }),
    ).toThrow(UnsupportedFeatureError);
    const afterSave = document.save();
    expect(afterSave.toBytes()).toStrictEqual(before);
    expect(afterSave.warnings).toStrictEqual(beforeSave.warnings);
  });

  it('rolls back every edit and the PDF/X version state when the metadata step fails', () => {
    // No /ID and no documentId: writePdfX4Metadata refuses after the output intent, the colours and the page boxes have been written.
    const document = loadDocument(untagged);
    const before = document.save().toBytes();
    expect(() =>
      convertToCmyk(document, {
        sourceRgbProfile: source,
        outputProfile: output,
        outputIntent: { outputConditionIdentifier: 'FOGRA28' },
        pdfx: { trapped: 'False', metadataDate: date },
      }),
    ).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'document-id-required' }));
    expect(document.save().toBytes()).toStrictEqual(before);
    convertToCmyk(document, { sourceRgbProfile: source, outputProfile: output, outputIntent: { outputConditionIdentifier: 'FOGRA28' } });
    const after = document.save();
    expect(latin1Text(after.toBytes().subarray(0, 8))).toBe('%PDF-1.7');
    expect(after.warnings.map(warning => warning.code)).not.toContain('version-lowered');
  });

  it('parses each profile under the 24 MiB default cap and refuses one byte more', () => {
    const cap = 24 * 1024 * 1024;
    const options = { outputIntent: { outputConditionIdentifier: 'FOGRA28' } };
    const atCap = convertToCmyk(loadDocument(fixture.bytes), { ...options, sourceRgbProfile: padded(source, cap), outputProfile: output });
    expect(atCap.page.operators).toBe(1);
    expect(() => convertToCmyk(loadDocument(fixture.bytes), { ...options, sourceRgbProfile: padded(source, cap + 1), outputProfile: output })).toThrow(
      ResourceLimitError,
    );
    expect(() => convertToCmyk(loadDocument(fixture.bytes), { ...options, sourceRgbProfile: source, outputProfile: padded(output, cap + 1) })).toThrow(
      ResourceLimitError,
    );
  });
});

// A one-page file whose page has the given resources and content, with further objects numbered from 5.
const pagePdf = (resources: string, content: string, objects: ReadonlyArray<{ number: number; body: string }>): Uint8Array =>
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
  ]).bytes;

const decodedStream = (document: ReturnType<typeof loadDocument>, value: PdfObject | undefined): Uint8Array => {
  const stream = value?.kind === 'reference' ? document.get(value) : value;
  const internals = internalsOf(document);
  if (stream?.kind !== 'stream' || internals === undefined) {
    throw new Error('expected a stream');
  }
  const data = decodedData(internals, stream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return data;
};

// The CMYK values LittleCMS gives for 8-bit sRGB values with the relative colorimetric intent and black point compensation.
const transicc = async (rgb: ReadonlyArray<number>): Promise<ReadonlyArray<number>> => {
  const run = await runChecked('transicc', ['-n', `-i${sourcePath}`, `-o${outputPath}`, '-t1', '-b', '-c0'], new TextEncoder().encode(`${rgb.join(' ')}\n`));
  return new TextDecoder()
    .decode(run.stdout)
    .trim()
    .split(/\s+/u)
    .map(value => Number(value) / 100);
};

// The page paints through a luminosity soft mask whose DeviceRGB group, object 6, draws an RGB image or paints an RGB axial shading.
const maskPdf = (kind: 'image' | 'axial'): Uint8Array =>
  pagePdf(
    '/ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>',
    '/GS gs 1 0 0 rg 0 0 10 10 re f',
    kind === 'image'
      ? [
          {
            number: 6,
            body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</XObject<</Im 9 0 R>>>>', '/Im Do'),
          },
          {
            number: 9,
            body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB', String.fromCodePoint(255, 0, 0)),
          },
        ]
      : [
          {
            number: 6,
            body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</Shading<</Sh1 9 0 R>>>>', '/Sh1 sh'),
          },
          { number: 9, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function 10 0 R>>' },
          { number: 10, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
        ],
  );

// The colour space of the image or shading the mask group's resources name.
const maskPaintSpace = (document: ReturnType<typeof loadDocument>, kind: 'image' | 'axial'): PdfObject | undefined => {
  const group = document.get(pdfReference(6, 0));
  const resources = group.kind === 'stream' ? group.dictionary.get(pdfName('Resources').bytes) : undefined;
  const category = resources?.kind === 'dictionary' ? resources.entries.get(pdfName(kind === 'image' ? 'XObject' : 'Shading').bytes) : undefined;
  const reference = category?.kind === 'dictionary' ? category.entries.get(pdfName(kind === 'image' ? 'Im' : 'Sh1').bytes) : undefined;
  const paint = reference?.kind === 'reference' ? document.get(reference) : undefined;
  if (paint?.kind === 'stream') {
    return paint.dictionary.get(pdfName('ColorSpace').bytes);
  }
  return paint?.kind === 'dictionary' ? paint.entries.get(pdfName('ColorSpace').bytes) : undefined;
};

describe('convert to cmyk in pass order', () => {
  // ISO 32000-1:2008, 8.10.1: a form inherits the graphics state in effect at Do; 8.6.8: sc takes one operand per component of the current space, which the converted page makes DeviceCMYK.
  it('writes the colour a form sets in its inherited RGB space as LittleCMS converts it', async () => {
    const document = loadDocument(
      pagePdf('/XObject<</Fm 5 0 R>>', '0.2 0.4 0.6 rg /Fm Do', [
        { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0.9 0.5 0.1 sc 0 0 10 10 re f') },
      ]),
    );
    convertToCmyk(document, { sourceRgbProfile: source, outputProfile: output, outputIntent: { outputConditionIdentifier: 'FOGRA28' } });
    const form = latin1Text(decodedStream(document, pdfReference(5, 0)));
    const operands = /^((?:[\d.]+ ){4})sc 0 0 10 10 re f$/u.exec(form)?.[1]?.trim().split(' ').map(Number);
    const expected = await transicc([229.5, 127.5, 25.5]);
    expect(operands).toHaveLength(4);
    expect(expected).toHaveLength(4);
    for (const [index, value] of expected.entries()) {
      expect(operands?.[index]).toBeCloseTo(value, 3);
    }
  });

  // ISO 32000-1:2008, 11.6.5.2, Table 144: a Luminosity soft mask derives its values from its group, which the conversion makes DeviceGray.
  it.each([
    { kind: 'image', luminosityGroups: undefined },
    { kind: 'image', luminosityGroups: 'gray' },
    { kind: 'axial', luminosityGroups: undefined },
    { kind: 'axial', luminosityGroups: 'gray' },
  ] as const)(
    'converts an RGB $kind in a luminosity soft mask to gray with luminosityGroups $luminosityGroups and writes a valid file',
    async ({ kind, luminosityGroups }) => {
      const document = loadDocument(maskPdf(kind));
      const options = { sourceRgbProfile: source, outputProfile: output, outputIntent: { outputConditionIdentifier: 'FOGRA28' } };
      convertToCmyk(document, luminosityGroups === undefined ? options : { ...options, luminosityGroups });
      expect(maskPaintSpace(document, kind)).toStrictEqual(pdfName('DeviceGray'));
      const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-mask-'));
      try {
        const file = path.join(directory, 'converted.pdf');
        await writeFile(file, document.save().toBytes());
        // runQpdf rejects unless qpdf exits 0, so a warning (exit 3) fails the test as well as an error.
        await expect(runQpdf(['--check', file])).resolves.toMatchObject({ stderr: '' });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

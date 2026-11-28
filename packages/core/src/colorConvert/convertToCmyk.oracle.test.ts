import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

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
import { pt } from '../length/length.ts';
import { pdfName } from '../object/pdfObject.ts';
import { checkPdfX4 } from '../pdfx/checkPdfX4.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertToCmyk } from './convertToCmyk.ts';

const source = Uint8Array.from(await readFile(new URL('../../../../tests/fixtures/icc/sRGB.icm', import.meta.url)));
const output = Uint8Array.from(await readFile(new URL('../../../../tests/fixtures/icc/fogra28l.icc', import.meta.url)));
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

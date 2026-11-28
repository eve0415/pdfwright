import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfObject } from '../object/pdfObject.ts';

import { describe, expect, inject, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { pdfDate } from '../date/pdfDate.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfInteger, pdfName } from '../object/pdfObject.ts';
import { checkPdfX4 } from '../pdfx/checkPdfX4.ts';

import { convertImages } from './convertImages.ts';
import { convertToCmyk } from './convertToCmyk.ts';
import { imageConversionFixture, measureImageConversion } from './performanceFixture.ts';

const joined = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

const resolved = (document: LoadedDocument, value: PdfObject | undefined): PdfObject | undefined => (value?.kind === 'reference' ? document.get(value) : value);

// The image XObject the fixture page draws, with its colour space, dimensions and decoded sample count.
const pageImage = (document: LoadedDocument): ReadonlyArray<unknown> => {
  const xobjects = resolved(document, document.page(0).resources().get(pdfName('XObject').bytes));
  const internals = internalsOf(document);
  if (xobjects?.kind !== 'dictionary' || internals === undefined) {
    throw new Error('the page has no XObject resources');
  }
  const images = [...xobjects.entries.entries()].map(([, value]) => resolved(document, value));
  const [image] = images;
  if (images.length !== 1 || image?.kind !== 'stream') {
    throw new Error('the page does not draw exactly one image');
  }
  const data = decodedData(internals, image);
  const entry = (name: string): PdfObject | undefined => image.dictionary.get(pdfName(name).bytes);
  return [entry('ColorSpace'), entry('Width'), entry('Height'), typeof data === 'string' ? data : data.length];
};

describe('image conversion performance', () => {
  it.skipIf(inject('runtime') !== 'workers')(
    'measures conversion and streamed save in workerd',
    async () => {
      const input = imageConversionFixture();
      const source = parseIccProfile(srgbBytes);
      const output = parseIccProfile(fograBytes);
      const result = await measureImageConversion(input, { source, output });
      expect([result.converted, result.kind]).toStrictEqual([1, 'streamed']);
      expect(result.elapsedMs).toBeLessThan(60_000);
      // The measurement keeps only a byte count, so a buffered save of the same conversion shows that the stream was not cut short.
      const buffered = loadDocument(input);
      convertImages(buffered, { sourceRgbProfile: source, outputProfile: output });
      expect(result.savedBytes).toBe(buffered.save().toBytes().length);
    },
    120_000,
  );

  it.skipIf(inject('runtime') !== 'workers')(
    'converts RGB pages and PDF/X metadata through a streamed save in workerd',
    async () => {
      const document = loadDocument(imageConversionFixture());
      const report = convertToCmyk(document, {
        sourceRgbProfile: srgbBytes,
        outputProfile: fograBytes,
        outputIntent: { outputConditionIdentifier: 'FOGRA28' },
        pdfx: {
          trapped: 'False',
          documentId: 'uuid:10c18da4-d7f3-4bc2-8c22-6a490b9f55f2',
          metadataDate: pdfDate({ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }),
        },
      });
      expect([report.images.converted, report.pageBoxes, report.metadata?.documentId]).toStrictEqual([
        1,
        { addedTrimBoxes: [0], addedPageGroups: [] },
        'uuid:10c18da4-d7f3-4bc2-8c22-6a490b9f55f2',
      ]);
      const saved = document.save();
      expect(saved.kind).toBe('streamed');
      const chunks: Array<Uint8Array> = [];
      for await (const chunk of saved.toStream()) {
        chunks.push(chunk);
      }
      const reloaded = loadDocument(joined(chunks));
      expect(checkPdfX4(reloaded).summary).toBe('no-violation-found-by-these-rules');
      expect(pageImage(reloaded)).toStrictEqual([pdfName('DeviceCMYK'), pdfInteger(1024), pdfInteger(512), 1024 * 512 * 4]);
    },
    120_000,
  );
});

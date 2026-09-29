import { describe, expect, inject, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';

import { convertToCmyk } from './convertToCmyk.ts';
import { imageConversionFixture, measureImageConversion } from './performanceFixture.ts';

describe('image conversion performance', () => {
  it.skipIf(inject('runtime') !== 'workers')(
    'measures conversion and streamed save in workerd',
    async () => {
      const input = imageConversionFixture();
      const source = parseIccProfile(srgbBytes);
      const output = parseIccProfile(fograBytes);
      const result = await measureImageConversion(input, { source, output });
      expect([result.converted, result.kind, result.pixels]).toStrictEqual([1, 'streamed', 524_288]);
      expect(result.elapsedMs).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeLessThan(60_000);
      expect(result.savedBytes).toBeGreaterThan(0);
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
      expect(report.images.converted).toBe(1);
      const saved = document.save();
      expect(saved.kind).toBe('streamed');
      let written = 0;
      for await (const chunk of saved.toStream()) written += chunk.length;
      expect(written).toBeGreaterThan(0);
    },
    120_000,
  );
});

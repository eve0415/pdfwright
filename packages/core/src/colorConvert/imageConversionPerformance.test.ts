import { describe, expect, inject, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { parseIccProfile } from '../icc/iccProfile.ts';

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
});

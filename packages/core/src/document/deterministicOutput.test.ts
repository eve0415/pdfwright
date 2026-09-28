import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { convertToCmyk } from '../colorConvert/convertToCmyk.ts';
import { pdfDate } from '../date/pdfDate.ts';
import { md5 } from '../hash/md5.ts';
import { pt } from '../length/length.ts';
import { setMetadata } from '../metadata/setMetadata.ts';

import { rgb } from './color.ts';
import { loadDocument } from './loadDocument.ts';
import { createDocument } from './pdfDocument.ts';
import { createProductionPage } from './productionPageFixture.ts';
import { rect } from './rect.ts';

const date = pdfDate({ year: 2024, month: 3, day: 2, hour: 1, minute: 4, second: 5, offset: 'Z' });
const digest = (bytes: Uint8Array): string => [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

const metadataBytes = (): Uint8Array => {
  const document = createDocument({ info: { title: 'Print proof', author: '山田 太郎', modificationDate: date } });
  document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  return document.save().toBytes();
};

const conversionBytes = (): Uint8Array => {
  const created = createDocument();
  const image = created.image({ width: 2, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples: Uint8Array.of(255, 0, 0, 0, 0, 255) });
  const group = created.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)), isolated: true, colorSpace: 'DeviceRGB' }, content => {
    content.fillColor(rgb(0.2, 0.4, 0.6));
    content.path(draw => draw.rect(0, 0, 20, 20));
    content.fill('nonzero');
  });
  const page = created.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  page.draw(content => {
    content.image(image, [20, 0, 0, 20, 10, 10]);
    content.group(group, [1, 0, 0, 1, 50, 50]);
  });
  const document = loadDocument(created.save().toBytes());
  convertToCmyk(document, {
    sourceRgbProfile: srgbBytes,
    outputProfile: fograBytes,
    outputIntent: { outputConditionIdentifier: 'FOGRA28' },
    pdfx: { trapped: 'False', metadataDate: date },
  });
  return document.save().toBytes();
};

describe('deterministic output across runtimes', () => {
  it('pins a production page, fresh XMP, metadata edit and CMYK conversion', () => {
    const fresh = metadataBytes();
    const edited = loadDocument(fresh);
    setMetadata(edited, { title: 'Print proof revised', modificationDate: date });
    const conversion = conversionBytes();
    expect(conversionBytes()).toStrictEqual(conversion);
    expect([digest(createProductionPage().saved.toBytes()), digest(fresh), digest(edited.save().toBytes()), digest(conversion)]).toStrictEqual([
      '124344a266be6ea30f6d0cfdf50f1f88',
      '5df1da55bcb99e2e6c4cd75f9261ce57',
      'b00fdef4a60db3ee9ab472bda59afb9f',
      '93d21276335bff761cdea57ba89f8453',
    ]);
  });
});

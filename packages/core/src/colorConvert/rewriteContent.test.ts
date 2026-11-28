import { describe, expect, it } from 'vitest';

import destinationBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import sourceBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { createColorTransform } from '../color/createColorTransform.ts';
import { readContent } from '../content/contentOperations.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';
import { readInlineImage } from '../testing/readInlineImage.ts';
import { seededBytes } from '../testing/seededBytes.ts';

import { encodeAscii85 } from './inlineAscii85.ts';
import { rewriteContentColors } from './rewriteContent.ts';

const source = parseIccProfile(sourceBytes);
const destination = parseIccProfile(destinationBytes);

const document = loadDocument(
  buildPdf([
    {
      xref: 'classic',
      trailer: '/Root 1 0 R',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R>>' },
        { number: 4, body: streamBody('', '') },
      ],
    },
  ]).bytes,
);

const rewrite = (content: string) =>
  rewriteContentColors(document, latin1Bytes(content), {
    resources: document.page(0).resources(),
    options: { sourceRgbProfile: source, outputProfile: destination },
  });

const rgbRow = (rgb: Uint8Array): Uint8Array => {
  const output = new Uint8Array((rgb.length / 3) * 4);
  createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true }).convertRow8(
    rgb,
    output,
    rgb.length / 3,
  );
  return output;
};

// A 32 by 32 image converts to exactly 4,096 bytes of CMYK samples; its first 940 pixels are noise from the seed and the rest are black, which sets how far the samples compress.
const noisyImage = (seed: number): Uint8Array => {
  const pixels = new Uint8Array(32 * 32 * 3);
  pixels.set(seededBytes(940 * 3, seed));
  return pixels;
};

describe('inline image conversion', () => {
  it('writes a converted inline image whose zlib data holds white space, EI and white space so that it reads back whole', () => {
    // These pixels convert to samples whose zlib data holds that run, which ends filtered inline data early when written as raw bytes (inlineImageData.ts).
    const pixels = Uint8Array.of(18, 128, 192, 0, 0, 64, 0, 0, 57, 0, 0, 0);
    expect(latin1Text(deflateZlib(rgbRow(pixels)))).toMatch(/[\0\t\n\f\r ]EI[\0\t\n\f\r ]/u);
    const result = rewrite(`BI /W 4 /H 1 /BPC 8 /CS /RGB ID\n${latin1Text(pixels)}\nEI`);
    expect(readInlineImage(result.bytes)).toStrictEqual({ operators: ['BI'], warnings: [], samples: rgbRow(pixels) });
  });

  it('keeps a converted inline image inline when it writes 4,096 bytes between ID and EI', () => {
    const pixels = noisyImage(15);
    const result = rewrite(`BI /W 32 /H 32 /BPC 8 /CS /RGB ID\n${latin1Text(pixels)}\nEI`);
    expect(result.newInlineImages).toStrictEqual([]);
    expect([...readContent(result.bytes, 32)][0]?.inlineImage?.data).toHaveLength(4096);
    expect(readInlineImage(result.bytes)).toStrictEqual({ operators: ['BI'], warnings: [], samples: rgbRow(pixels) });
  });

  it('moves a converted inline image to an XObject when it would write 4,097 bytes between ID and EI', () => {
    const pixels = noisyImage(5);
    const result = rewrite(`BI /W 32 /H 32 /BPC 8 /CS /RGB ID\n${latin1Text(pixels)}\nEI`);
    expect(latin1Text(result.bytes)).toBe('/PWIM0 Do');
    expect(result.newInlineImages.map(image => [image.name, image.width, image.height, image.bits])).toStrictEqual([['PWIM0', 32, 32, 8]]);
    const data = result.newInlineImages[0]?.data ?? new Uint8Array();
    expect(encodeAscii85(data)).toHaveLength(4097);
    expect(inflateZlib(data).data).toStrictEqual(rgbRow(pixels));
  });
});

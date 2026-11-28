import { describe, expect, it } from 'vitest';

import { readContent } from '../content/contentOperations.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';
import { readInlineImage } from '../testing/readInlineImage.ts';

import { grayInlineImage } from './luminosityInline.ts';

describe('luminosity inline image conversion', () => {
  it('writes a gray inline image whose zlib data ends in white space and EI so that it reads back whole', () => {
    // 36 samples of 178 and 64 of 177 in this order give an Adler-32 trailer ending in newline, E and I, which a newline written before EI would complete as a false end of raw Flate inline data.
    const gray = Uint8Array.from(
      '0001001001111000000101001010110001001011100011001000000010001010100011111000000110001000001010000011',
      digit => 177 + Number(digit),
    );
    expect([...deflateZlib(gray)].slice(-3)).toStrictEqual([0x0a, 0x45, 0x49]);
    const rgb = latin1Text(Uint8Array.from([...gray].flatMap(value => [value, value, value])));
    const image = [...readContent(latin1Bytes(`BI /W 100 /H 1 /BPC 8 /CS /RGB ID\n${rgb}\nEI`), 32)][0]?.inlineImage;
    if (image === undefined) {
      throw new Error('source inline image is missing');
    }
    const written = grayInlineImage(image, ([red = 0]) => red, 1_048_576);
    if (written === null) {
      throw new Error('the RGB inline image was not converted');
    }
    expect(readInlineImage(written)).toStrictEqual({ operators: ['BI'], warnings: [], samples: gray });
  });
});

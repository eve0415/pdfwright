import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('image XObjects', () => {
  it('validates pixels and mask dimensions', () => {
    const document = createDocument();
    expect(() => document.image({ width: 2, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples: new Uint8Array(5) })).toThrow(ValidationError);
    expect(() => document.image({ width: 0, height: 1, colorSpace: 'DeviceGray', bitsPerComponent: 8, samples: new Uint8Array() })).toThrow(ValidationError);
    expect(() =>
      document.image({
        width: 1,
        height: 1,
        colorSpace: 'DeviceGray',
        bitsPerComponent: 8,
        samples: new Uint8Array(1),
        softMask: { width: 2, height: 1, samples: new Uint8Array(1) },
      }),
    ).toThrow(ValidationError);
  });

  it('writes Flate-compressed image and DeviceGray soft mask objects', () => {
    const document = createDocument();
    const image = document.image({
      width: 1,
      height: 1,
      colorSpace: 'DeviceRGB',
      bitsPerComponent: 8,
      samples: new Uint8Array([255, 0, 0]),
      softMask: { width: 1, height: 1, samples: new Uint8Array([128]) },
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.image(image, [20, 0, 0, 20, 0, 0]);
    });
    const bytes = document.save().toBytes();
    const pdf = ascii(bytes);
    for (const fragment of ['/XObject<</Im1', '/Subtype/Image', '/ColorSpace/DeviceGray', '/ColorSpace/DeviceRGB', '/SMask']) expect(pdf).toContain(fragment);
    const streams = [...pdf.matchAll(/\nstream\n/gu)].map(match => match.index + 8);
    const decoded = streams.map(start => {
      const compressed = bytes.subarray(start, pdf.indexOf('\nendstream', start));
      return ascii(inflateZlib(compressed).data);
    });
    expect(decoded).toContain('\u00FF\u0000\u0000');
  });

  it('writes a Separation image with an explicit ink decode range', () => {
    const document = createDocument();
    const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
    const image = document.image({ width: 1, height: 1, colorSpace: white, bitsPerComponent: 8, samples: new Uint8Array([255]) });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.image(image, [20, 0, 0, 20, 0, 0]);
    });
    const pdf = ascii(document.save().toBytes());
    expect(pdf).toContain('/Decode[0 1]');
    expect(pdf).toContain('/Separation /White');
  });

  it('returns a frozen handle that keeps its own copy of the samples', () => {
    const document = createDocument();
    const samples = new Uint8Array([10, 20, 30]);
    const image = document.image({ width: 1, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples });
    samples.fill(0);
    expect([Object.isFrozen(image), Object.keys(image)]).toStrictEqual([true, ['kind']]);
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.image(image, [20, 0, 0, 20, 0, 0]);
    });
    const bytes = document.save().toBytes();
    const pdf = ascii(bytes);
    const decoded = [...pdf.matchAll(/\nstream\n/gu)].map(match => {
      const start = match.index + 8;
      const compressed = bytes.subarray(start, pdf.indexOf('\nendstream', start));
      return ascii(inflateZlib(compressed).data);
    });
    expect(decoded).toContain('\u000A\u0014\u001E');
  });
});

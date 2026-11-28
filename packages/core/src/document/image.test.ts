import type { PdfObject } from '../object/pdfObject.ts';
import type { ImageOptions } from './image.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';
import { pdfInteger, pdfName } from '../object/pdfObject.ts';

import { cmyk } from './color.ts';
import { entry, keys, objectText, pageContent, pageResource, reload, streamBytes } from './inspectSaved.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

// 'accepted', or the class of the error the call throws.
const attempt = (options: ImageOptions, document = createDocument()): string => {
  try {
    document.image(options);
  } catch (error: unknown) {
    return error instanceof ValidationError ? 'ValidationError' : String(error);
  }
  return 'accepted';
};

const gray = (width: number, height: number, length: number): ImageOptions => ({
  width,
  height,
  colorSpace: 'DeviceGray',
  bitsPerComponent: 8,
  samples: new Uint8Array(length),
});

const stencil = (width: number, height: number, length: number): ImageOptions => ({
  width,
  height,
  colorSpace: 'ImageMask',
  bitsPerComponent: 1,
  samples: new Uint8Array(length),
});

const box = rect(pt(0), pt(0), pt(20), pt(20));

// The parts of an image object a reader decides on: its dictionary as written and its decoded samples.
const described = (image: PdfObject): [string, Array<number>] => [objectText(image), [...streamBytes(image)]];

describe('image XObjects', () => {
  // ISO 32000-1:2008, 8.9.5.1, Table 89: Width and Height are positive integers and the samples fill the image exactly.
  it.each([
    ['too few RGB samples', { width: 2, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples: new Uint8Array(5) }, 'ValidationError'],
    ['a zero width', gray(0, 1, 0), 'ValidationError'],
    ['a zero height', gray(1, 0, 0), 'ValidationError'],
    // Each sample count below matches width × height, so only the dimension rule can refuse it.
    ['a fractional width', gray(1.5, 2, 3), 'ValidationError'],
    ['a negative width and height', gray(-1, -1, 1), 'ValidationError'],
    ['four CMYK samples for one pixel', { width: 1, height: 1, colorSpace: 'DeviceCMYK', bitsPerComponent: 8, samples: new Uint8Array(4) }, 'accepted'],
    ['three CMYK samples for one pixel', { width: 1, height: 1, colorSpace: 'DeviceCMYK', bitsPerComponent: 8, samples: new Uint8Array(3) }, 'ValidationError'],
    ['a 9 by 2 stencil of 4 bytes', stencil(9, 2, 4), 'accepted'],
    ['a 9 by 2 stencil of 3 bytes', stencil(9, 2, 3), 'ValidationError'],
    ['a 9 by 2 stencil of 5 bytes', stencil(9, 2, 5), 'ValidationError'],
    ['an 8 by 1 stencil of 1 byte', stencil(8, 1, 1), 'accepted'],
    ['an 8 by 1 stencil of 2 bytes', stencil(8, 1, 2), 'ValidationError'],
    ['a soft mask with too many samples for its size', { ...gray(1, 1, 1), softMask: { width: 1, height: 1, samples: new Uint8Array(2) } }, 'ValidationError'],
    ['a soft mask of zero width', { ...gray(1, 1, 1), softMask: { width: 0, height: 1, samples: new Uint8Array() } }, 'ValidationError'],
    ['a matching soft mask', { ...gray(2, 1, 2), softMask: { width: 2, height: 1, samples: new Uint8Array(2) } }, 'accepted'],
  ] satisfies Array<[string, ImageOptions, string]>)('checks %s', (_, options, expected) => {
    expect(attempt(options)).toBe(expected);
  });

  it('counts one channel per pixel for a Separation image', () => {
    const document = createDocument();
    const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
    const separation = (length: number): string =>
      attempt({ width: 2, height: 1, colorSpace: white, bitsPerComponent: 8, samples: new Uint8Array(length) }, document);
    expect([separation(2), separation(8)]).toStrictEqual(['accepted', 'ValidationError']);
  });

  // ISO 32000-1:2008, 8.9.6.2: a stencil mask has BitsPerComponent 1, and an ordinary image here has 8.
  it.each([
    ['an 8-bit stencil', 'ImageMask', 8],
    ['a 1-bit gray image', 'DeviceGray', 1],
  ] as const)('refuses %s', (_, colorSpace, bitsPerComponent) => {
    // @ts-expect-error The ImageOptions type pairs each colour space with its bit depth, and this call breaks the pairing on purpose.
    expect(attempt({ width: 8, height: 1, colorSpace, bitsPerComponent, samples: new Uint8Array(8) })).toBe('ValidationError');
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
    const page = document.addPage({ mediaBox: box });
    page.draw(content => {
      content.image(image, [20, 0, 0, 20, 0, 0]);
    });
    const saved = reload(document.save());
    const written = pageResource(saved, 0, 'XObject', 'Im1');
    // ISO 32000-1:2008, 11.6.5.3, Table 145: a soft-mask image is a DeviceGray image XObject.
    expect([keys(written), described(written), described(entry(saved, written, 'SMask'))]).toStrictEqual([
      ['Type', 'Subtype', 'Width', 'Height', 'BitsPerComponent', 'Filter', 'ColorSpace', 'SMask', 'Length'],
      [expect.stringContaining('/ColorSpace/DeviceRGB'), [255, 0, 0]],
      ['<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode/Length 9>>', [0x80]],
    ]);
  });

  // ISO 32000-1:2008, 8.9.5.2 and 8.6.6.4, NOTE 5: Separation samples are ink amounts, so only a Separation image needs Decode [0 1].
  it('writes an explicit ink decode range for a Separation image and none for a device image', () => {
    const document = createDocument();
    const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
    const ink = document.image({ width: 1, height: 1, colorSpace: white, bitsPerComponent: 8, samples: new Uint8Array([255]) });
    const rgb = document.image({ width: 1, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples: new Uint8Array([1, 2, 3]) });
    const page = document.addPage({ mediaBox: box });
    page.draw(content => {
      content.image(ink, [20, 0, 0, 20, 0, 0]);
      content.image(rgb, [20, 0, 0, 20, 0, 0]);
    });
    const saved = reload(document.save());
    const separation = pageResource(saved, 0, 'XObject', 'Im1');
    const device = pageResource(saved, 0, 'XObject', 'Im2');
    expect([
      objectText(entry(saved, separation, 'Decode')),
      objectText(entry(saved, separation, 'ColorSpace')).startsWith('[/Separation /White '),
      keys(device).includes('Decode'),
    ]).toStrictEqual(['[0 1]', true, false]);
  });

  it('writes a one-bit stencil that uses the current spot colour and a soft mask', () => {
    const document = createDocument();
    const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
    const image = document.image({
      width: 3,
      height: 1,
      colorSpace: 'ImageMask',
      bitsPerComponent: 1,
      samples: Uint8Array.of(0xc0),
      softMask: { width: 3, height: 1, samples: Uint8Array.of(255, 128, 0) },
    });
    document.addPage({ mediaBox: box }).draw(content => {
      content.fillColor(white, 1);
      content.image(image, [20, 0, 0, 20, 0, 0]);
    });
    const saved = reload(document.save());
    const written = pageResource(saved, 0, 'XObject', 'Im1');
    const mask = entry(saved, written, 'SMask');
    // ISO 32000-1:2008, 8.9.6.2: a stencil has no ColorSpace, and its set bits paint with the current nonstroking colour.
    expect([
      keys(written),
      [entry(saved, written, 'ImageMask'), entry(saved, written, 'BitsPerComponent'), objectText(entry(saved, written, 'Decode'))],
      [entry(saved, mask, 'ColorSpace'), entry(saved, mask, 'Width'), [...streamBytes(mask)]],
      pageContent(saved, 0),
    ]).toStrictEqual([
      ['Type', 'Subtype', 'Width', 'Height', 'BitsPerComponent', 'Filter', 'ImageMask', 'Decode', 'SMask', 'Length'],
      [{ kind: 'boolean', value: true }, pdfInteger(1), '[1 0]'],
      [pdfName('DeviceGray'), pdfInteger(3), [0xff, 0x80, 0x00]],
      'q\n/CS1 cs\n1 scn\nq\n20 0 0 20 0 0 cm\n/Im1 Do\nQ\nQ\n',
    ]);
  });

  it('guards invisible white overprint when painting a stencil image, and not for an image with its own colour space', () => {
    const document = createDocument();
    const mask = document.image({ width: 1, height: 1, colorSpace: 'ImageMask', bitsPerComponent: 1, samples: Uint8Array.of(0x80) });
    const opaque = document.image(gray(1, 1, 1));
    document.addPage({ mediaBox: box }).draw(content => {
      content.fillColor(cmyk(0, 0, 0, 0));
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      expect(() => {
        content.image(mask, [20, 0, 0, 20, 0, 0]);
      }).toThrow(expect.objectContaining({ reason: 'invisible-overprint' }));
      expect(() => {
        content.image(opaque, [20, 0, 0, 20, 0, 0]);
      }).not.toThrow();
    });
  });

  it('returns a frozen handle that keeps its own copy of the samples', () => {
    const document = createDocument();
    const samples = new Uint8Array([10, 20, 30]);
    const image = document.image({ width: 1, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples });
    samples.fill(0);
    expect([Object.isFrozen(image), Object.keys(image)]).toStrictEqual([true, ['kind']]);
    const page = document.addPage({ mediaBox: box });
    page.draw(content => {
      content.image(image, [20, 0, 0, 20, 0, 0]);
    });
    const saved = reload(document.save());
    expect([...streamBytes(pageResource(saved, 0, 'XObject', 'Im1'))]).toStrictEqual([10, 20, 30]);
  });
});

describe('properties', () => {
  const channels = { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4 } as const;

  it('accepts samples exactly when their length fills the image', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom('DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'ImageMask'),
        fc.integer({ min: -2, max: 2 }),
        (width, height, colorSpace, offset) => {
          const expected = colorSpace === 'ImageMask' ? Math.ceil(width / 8) * height : width * height * channels[colorSpace];
          const length = Math.max(0, expected + offset);
          const samples = new Uint8Array(length);
          const options: ImageOptions =
            colorSpace === 'ImageMask'
              ? { width, height, colorSpace, bitsPerComponent: 1, samples }
              : { width, height, colorSpace, bitsPerComponent: 8, samples };
          expect(attempt(options)).toBe(length === expected ? 'accepted' : 'ValidationError');
        },
      ),
    );
  });
});

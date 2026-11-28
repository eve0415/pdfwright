import type { PdfObject } from '../object/pdfObject.ts';
import type { PageOptions } from './pdfDocument.ts';
import type { PdfRect } from './rect.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { formatLength, mm, pt } from '../length/length.ts';
import { pdfInteger, pdfName, pdfReference, pdfString } from '../object/pdfObject.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { cmyk } from './color.ts';
import { loadDocument } from './loadDocument.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const entry = (value: PdfObject, key: string): PdfObject | undefined => (value.kind === 'dictionary' ? value.entries.get(pdfName(key).bytes) : undefined);

const nameText = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? latin1Text(value.bytes) : undefined);

// The rectangle operands of each content stream the first page's Contents names, in Contents order.
const contentRects = (bytes: Uint8Array): Array<string | undefined> => {
  const document = loadDocument(bytes);
  const contents = entry(document.get(document.page(0).reference), 'Contents');
  const references = contents?.kind === 'array' ? contents.items : [contents];
  return references.map(reference => {
    const stream = reference?.kind === 'reference' ? document.get(reference) : undefined;
    return stream?.kind === 'stream' ? /(\S+ \S+ \S+ \S+) re/u.exec(latin1Text(inflateZlib(stream.data).data))?.[1] : undefined;
  });
};

// The soft mask object each image in the saved file names, in object order.
const softMasks = (bytes: Uint8Array): Array<number> => {
  const document = loadDocument(bytes);
  return Array.from({ length: 20 }, (_, index) => document.get(pdfReference(index + 1, 0))).flatMap(value => {
    const mask = value.kind === 'stream' ? value.dictionary.get(pdfName('SMask').bytes) : undefined;
    return mask?.kind === 'reference' ? [mask.objectNumber] : [];
  });
};

const square = (size: number): PdfRect => rect(pt(0), pt(0), pt(size), pt(size));

describe('minimal PDF document', () => {
  it('reserves one graphics state level for each isolated draw stream', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: [pt(0), pt(0), pt(20), pt(20)] });
    page.draw(content => {
      for (let index = 0; index < 27; index++) {
        content.save();
      }
      expect(() => {
        content.save();
      }).toThrow(ValidationError);
      for (let index = 0; index < 27; index++) {
        content.restore();
      }
    });
  });

  it('isolates graphics state between separate draw streams', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: [pt(0), pt(0), pt(20), pt(20)] });
    page.draw(content => {
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
    });
    page.draw(content => {
      content.fillColor(cmyk(0, 0, 0, 0));
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
    });
    const bytes = document.save().toBytes();
    const pdf = ascii(bytes);
    const starts = [...pdf.matchAll(/\nstream\n/gu)].map(match => match.index + 8);
    const streams = starts.map(start => {
      const compressed = bytes.subarray(start, pdf.indexOf('\nendstream', start));
      return ascii(inflateZlib(compressed).data);
    });
    expect(streams[0]).toBe('q\n/GS1 gs\nQ\n');
    expect(streams[1]).toBe('q\n0 0 0 0 k\n0 0 20 20 re\nf\nQ\n');
  });

  it('writes empty A4 pages with exact media boxes and no contents', () => {
    const document = createDocument();
    const mediaBox = [pt(0), pt(0), mm(210), mm(297)] as const;
    document.addPage({ mediaBox: [...mediaBox] });
    document.addPage({ mediaBox: [...mediaBox] });
    document.addPage({ mediaBox: [...mediaBox] });
    const text = ascii(document.save().toBytes());
    expect(text).toContain('/Count 3');
    expect(text.match(/\/MediaBox\[0 0 595\.27559 841\.88976\]/gu)).toHaveLength(3);
    expect(text).not.toContain('/Contents');
    expect(text).toContain('/Resources<<>>');
  });

  it('returns identical bytes on repeated saves and keeps supplied file IDs', () => {
    const firstId = new Uint8Array(16).fill(0x11);
    const secondId = new Uint8Array(16).fill(0x22);
    const document = createDocument({ fileIdentifier: [firstId, secondId] });
    document.addPage({ mediaBox: [pt(0), pt(0), mm(210), mm(297)] });
    const first = document.save();
    expect(document.save().toBytes()).toStrictEqual(first.toBytes());
    expect(ascii(first.toBytes())).toContain(`/ID[<${'11'.repeat(16)}> <${'22'.repeat(16)}>]`);
  });

  it('writes page boxes from exact lengths without a second rounding', () => {
    const document = createDocument({ fractionDigits: 10 });
    document.addPage({ mediaBox: [pt(0), pt(0), mm(1_000_000), mm(1_000_000)] });
    expect(ascii(document.save().toBytes())).toContain('/MediaBox[0 0 2834645.6692913386 2834645.6692913386]');
  });

  it('writes no exponent-form number tokens', () => {
    const document = createDocument({ fractionDigits: 10 });
    document.addPage({ mediaBox: [pt(0), pt(0), mm(0.000001), mm(297)] });
    const text = ascii(document.save().toBytes()).replaceAll(/<[0-9A-F]+>/gu, '');
    const numericTokens = text.split(/[^0-9A-Za-z.+-]+/u).filter(token => /^[-+]?\d/u.test(token));
    expect(numericTokens.filter(token => /[eE]/u.test(token))).toStrictEqual([]);
  });

  it('lists the content streams of several draws in draw order and a single draw as a bare reference', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: square(20) });
    for (const size of [1, 2, 3]) {
      page.draw(content => {
        content.path(path => path.rect(0, 0, size, size));
        content.fill('nonzero');
      });
    }
    const single = createDocument();
    single.addPage({ mediaBox: square(20) }).draw(content => {
      content.path(path => path.rect(0, 0, 4, 4));
      content.fill('nonzero');
    });
    const singleBytes = single.save().toBytes();
    const loaded = loadDocument(singleBytes);
    // ISO 32000-1:2008, 7.7.3.3, Table 30, Contents: a stream or an array of streams, concatenated in order.
    expect([contentRects(document.save().toBytes()), contentRects(singleBytes), entry(loaded.get(loaded.page(0).reference), 'Contents')?.kind]).toStrictEqual([
      ['0 0 1 1', '0 0 2 2', '0 0 3 3'],
      ['0 0 4 4'],
      'reference',
    ]);
  });

  it.each([
    { edge: 'a TrimBox equal to the MediaBox', right: 100, written: 100 },
    { edge: 'a right edge that rounds onto the MediaBox edge', right: 100.4, written: 100 },
  ])('accepts $edge at the save precision', ({ right, written }) => {
    const document = createDocument({ fractionDigits: 0 });
    document.addPage({ mediaBox: square(100), trimBox: rect(pt(0), pt(0), pt(right), pt(100)) });
    expect(loadDocument(document.save().toBytes()).page(0).boxes().TrimBox).toStrictEqual({ rect: [0, 0, written, 100], explicit: true });
  });

  it('rejects a right edge that rounds past the MediaBox edge', () => {
    const document = createDocument({ fractionDigits: 0 });
    expect(() => document.addPage({ mediaBox: square(100), trimBox: rect(pt(0), pt(0), pt(100.6), pt(100)) })).toThrow(ValidationError);
  });

  it.each([
    { masks: 'equal samples and dimensions', dimensions: [3, 1, 3, 1], distinct: 1 },
    { masks: 'equal samples in other dimensions', dimensions: [3, 1, 1, 3], distinct: 2 },
  ])(
    'shares a soft mask between images whose masks have $masks only when the dimensions agree',
    ({ dimensions: [firstWidth = 0, firstHeight = 0, secondWidth = 0, secondHeight = 0], distinct }) => {
      const document = createDocument();
      const samples = new Uint8Array([255, 128, 0]);
      for (const [width, height] of [
        [firstWidth, firstHeight],
        [secondWidth, secondHeight],
      ] as const) {
        document.image({ width, height, colorSpace: 'DeviceGray', bitsPerComponent: 8, samples, softMask: { width, height, samples } });
      }
      document.addPage({ mediaBox: square(10) });
      const masks = softMasks(document.save().toBytes());
      expect([masks.length, new Set(masks).size]).toStrictEqual([2, distinct]);
    },
  );

  it('numbers caller objects from 3 in call order, before the pages', () => {
    const document = createDocument();
    const first = pdfInteger(7);
    const second = pdfString(new TextEncoder().encode('second'));
    expect([document.object(first), document.object(second)]).toStrictEqual([pdfReference(3, 0), pdfReference(4, 0)]);
    document.addPage({ mediaBox: square(10) });
    const loaded = loadDocument(document.save().toBytes());
    expect([loaded.get(pdfReference(3, 0)), loaded.get(pdfReference(4, 0)), loaded.page(0).reference]).toStrictEqual([first, second, pdfReference(5, 0)]);
  });

  it('writes a page transparency group with its blending colour space', () => {
    const document = createDocument();
    document.addPage({ mediaBox: square(10), group: { colorSpace: 'DeviceRGB' } });
    document.addPage({ mediaBox: square(10) });
    const loaded = loadDocument(document.save().toBytes());
    const groups = [0, 1].map(index => entry(loaded.get(loaded.page(index).reference), 'Group'));
    // ISO 32000-1:2008, 11.6.6, Table 147: a transparency group attributes dictionary has S Transparency and an optional CS.
    expect(groups.map(group => (group === undefined ? undefined : [nameText(entry(group, 'S')), nameText(entry(group, 'CS'))]))).toStrictEqual([
      ['Transparency', 'DeviceRGB'],
      undefined,
    ]);
  });

  it('writes pages in the order they were added', () => {
    const document = createDocument();
    for (const size of [10, 20, 30]) {
      document.addPage({ mediaBox: square(size) });
    }
    const loaded = loadDocument(document.save().toBytes());
    expect([0, 1, 2].map(index => loaded.page(index).boxes().MediaBox.rect)).toStrictEqual([
      [0, 0, 10, 10],
      [0, 0, 20, 20],
      [0, 0, 30, 30],
    ]);
  });
});

const hundredths = fc.integer({ min: 0, max: 5000 });

// A MediaBox, and four optional boxes whose corners lie within 0.3 pt of its extent, so that rounding often decides whether each one fits.
const near = (from: number, to: number): fc.Arbitrary<number> => fc.integer({ min: Math.min(from, to) - 30, max: Math.max(from, to) + 30 });

const pageBoxes = fc.tuple(hundredths, hundredths, hundredths, hundredths).chain(([x1, y1, x2, y2]) => {
  const inner = fc
    .tuple(near(x1, x2), near(y1, y2), near(x1, x2), near(y1, y2))
    .map(([a, b, c, d]) => rect(pt(a / 100), pt(b / 100), pt(c / 100), pt(d / 100)));
  const optional = fc.option(inner, { nil: undefined, freq: 2 });
  return fc.tuple(fc.constant(rect(pt(x1 / 100), pt(y1 / 100), pt(x2 / 100), pt(y2 / 100))), optional, optional, optional, optional);
});

const roundedBox = (value: PdfRect, fractionDigits: number): Array<number> => value.map(length => Number(formatLength(length, fractionDigits)));

const fits = (inner: ReadonlyArray<number>, media: ReadonlyArray<number>): boolean => {
  const [left = 0, bottom = 0, right = 0, top = 0] = inner;
  const [mediaLeft = 0, mediaBottom = 0, mediaRight = 0, mediaTop = 0] = media;
  return left < right && bottom < top && left >= mediaLeft && bottom >= mediaBottom && right <= mediaRight && top <= mediaTop;
};

type CreatedBoxes = ReturnType<ReturnType<ReturnType<typeof loadDocument>['page']>['boxes']>;

// The boxes of a created page after a save and reload, or 'refused' when addPage throws ValidationError.
const createdBoxes = (options: PageOptions, fractionDigits: number): CreatedBoxes | 'refused' => {
  const document = createDocument({ fractionDigits });
  try {
    document.addPage(options);
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return 'refused';
    }
    throw error;
  }
  return loadDocument(document.save().toBytes()).page(0).boxes();
};

describe('properties', () => {
  it('writes supplied page boxes at the document precision, or refuses them when a rounded box has no area or leaves the MediaBox', () => {
    fc.assert(
      fc.property(pageBoxes, fc.integer({ min: 0, max: 4 }), ([mediaBox, cropBox, bleedBox, trimBox, artBox], fractionDigits) => {
        const options: PageOptions = { mediaBox };
        if (cropBox !== undefined) {
          options.cropBox = cropBox;
        }
        if (bleedBox !== undefined) {
          options.bleedBox = bleedBox;
        }
        if (trimBox !== undefined) {
          options.trimBox = trimBox;
        }
        if (artBox !== undefined) {
          options.artBox = artBox;
        }
        const media = roundedBox(mediaBox, fractionDigits);
        const crop = cropBox === undefined ? media : roundedBox(cropBox, fractionDigits);
        const production = (value: PdfRect | undefined): { rect: Array<number>; explicit: boolean } =>
          value === undefined ? { rect: crop, explicit: false } : { rect: roundedBox(value, fractionDigits), explicit: true };
        const boxes = { BleedBox: production(bleedBox), TrimBox: production(trimBox), ArtBox: production(artBox) };
        // ISO 32000-1:2008, 7.7.3.3, Table 30: CropBox defaults to MediaBox and the other boxes to CropBox; the writer requires every effective box to have area inside the MediaBox.
        const valid = fits(media, media) && fits(crop, media) && Object.values(boxes).every(value => fits(value.rect, media));
        const expected = {
          MediaBox: { rect: media, explicit: true },
          CropBox: { rect: crop, explicit: cropBox !== undefined },
          ...boxes,
          rotate: 0,
          userUnit: 1,
        };
        expect(createdBoxes(options, fractionDigits)).toStrictEqual(valid ? expected : 'refused');
      }),
    );
  });
});

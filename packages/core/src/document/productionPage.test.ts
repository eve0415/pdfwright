import type { PdfObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { inflateZlib } from '../flate/inflate.ts';
import { formatLength, mm } from '../length/length.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';

import { loadDocument } from './loadDocument.ts';
import { createProductionPage } from './productionPageFixture.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const subtype = (value: PdfObject): string | undefined => {
  const name = value.kind === 'stream' ? value.dictionary.get(pdfName('Subtype').bytes) : undefined;
  return name?.kind === 'name' ? ascii(name.bytes) : undefined;
};

interface MaskSharing {
  readonly spotImages: number;
  /** The distinct soft masks the Separation images name. */
  readonly spotMasks: ReadonlyArray<number>;
  /** The soft masks the other images name. */
  readonly otherMasks: ReadonlyArray<number>;
  /** The distinct soft masks every image names. */
  readonly allMasks: number;
  readonly imageMasks: number;
}

const maskSharing = (bytes: Uint8Array): MaskSharing => {
  const document = loadDocument(bytes);
  const objects = Array.from({ length: 30 }, (_, index) => document.get(pdfReference(index + 1, 0)));
  const images = objects.flatMap(value => (value.kind === 'stream' && subtype(value) === 'Image' ? [value] : []));
  const isSeparation = (image: (typeof images)[number]): boolean => {
    const space = image.dictionary.get(pdfName('ColorSpace').bytes);
    return space?.kind === 'array' && space.items[0]?.kind === 'name' && ascii(space.items[0].bytes) === 'Separation';
  };
  const maskOf = (image: (typeof images)[number]): Array<number> => {
    const mask = image.dictionary.get(pdfName('SMask').bytes);
    return mask?.kind === 'reference' ? [mask.objectNumber] : [];
  };
  const spot = images.filter(image => isSeparation(image));
  return {
    spotImages: spot.length,
    spotMasks: [...new Set(spot.flatMap(image => maskOf(image)))],
    otherMasks: images.filter(image => !isSeparation(image)).flatMap(image => maskOf(image)),
    allMasks: new Set(images.flatMap(image => maskOf(image))).size,
    imageMasks: images.filter(image => image.dictionary.get(pdfName('ImageMask').bytes) !== undefined).length,
  };
};

describe('production page structure', () => {
  it('writes exact millimetre boxes, four separations, and private data', () => {
    const pdf = ascii(createProductionPage().saved.toBytes());
    const expectedTrim = [mm(5), mm(5), mm(45), mm(35)].map(value => formatLength(value, 5)).join(' ');
    const expectedBleed = [mm(3), mm(3), mm(47), mm(37)].map(value => formatLength(value, 5)).join(' ');
    for (const fragment of [
      `/TrimBox[${expectedTrim}]`,
      `/BleedBox[${expectedBleed}]`,
      '/Separation /White',
      '/Separation /Primer',
      '/#82b#82t#82s',
      '/#82e#82n#82k#82c',
      'stream\nprint page private data\nendstream',
    ]) {
      expect(pdf).toContain(fragment);
    }
  });

  it('clips the content and uses hairline strokes and a group XObject', () => {
    const bytes = createProductionPage().saved.toBytes();
    const pdf = ascii(bytes);
    const start = pdf.indexOf('\nstream\n', pdf.indexOf('/Filter/FlateDecode')) + 8;
    const end = pdf.indexOf('\nendstream', start);
    const contents = ascii(inflateZlib(bytes.subarray(start, end)).data);
    expect(contents).toContain('W\nn\n');
    expect(contents).toContain('0 w\n');
    expect(contents).toContain('/Fm1 Do');
  });

  it('uses two Separation images with one shared soft mask', () => {
    const sharing = maskSharing(createProductionPage().saved.toBytes());
    const [shared] = sharing.spotMasks;
    // The DeviceRGB artwork has a mask of its own, with other samples, so exactly two soft masks are written.
    expect([sharing.spotImages, sharing.spotMasks.length, sharing.otherMasks.length, sharing.allMasks, sharing.imageMasks]).toStrictEqual([2, 1, 1, 2, 0]);
    expect(sharing.otherMasks).not.toContain(shared);
  });

  it('clips each painted object to the die line separately', () => {
    const bytes = createProductionPage().saved.toBytes();
    const pdf = ascii(bytes);
    const start = pdf.indexOf('\nstream\n', pdf.indexOf('/Filter/FlateDecode')) + 8;
    const end = pdf.indexOf('\nendstream', start);
    const contents = ascii(inflateZlib(bytes.subarray(start, end)).data);
    expect(contents.split('W\nn\n').length - 1).toBe(5);
  });
});

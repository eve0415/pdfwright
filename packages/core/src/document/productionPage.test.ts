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

const sharedSpotMask = (bytes: Uint8Array): readonly [number, number, boolean] => {
  const document = loadDocument(bytes);
  const objects = Array.from({ length: 30 }, (_, index) => ({ number: index + 1, value: document.get(pdfReference(index + 1, 0)) }));
  const spotImages = objects.filter(({ value }) => {
    if (value.kind !== 'stream' || subtype(value) !== 'Image') return false;
    const space = value.dictionary.get(pdfName('ColorSpace').bytes);
    return space?.kind === 'array' && space.items[0]?.kind === 'name' && ascii(space.items[0].bytes) === 'Separation';
  });
  const masks = spotImages.map(({ value }) => (value.kind === 'stream' ? value.dictionary.get(pdfName('SMask').bytes) : undefined));
  const numbers = masks.flatMap(mask => (mask?.kind === 'reference' ? [mask.objectNumber] : []));
  return [
    spotImages.length,
    new Set(numbers).size,
    !objects.some(({ value }) => value.kind === 'stream' && value.dictionary.get(pdfName('ImageMask').bytes) !== undefined),
  ];
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
    const bytes = createProductionPage().saved.toBytes();
    expect(sharedSpotMask(bytes)).toStrictEqual([2, 1, true]);
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

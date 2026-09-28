import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { inflateZlib } from '../flate/inflate.ts';
import { formatLength, mm } from '../length/length.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';

import { loadDocument } from './loadDocument.ts';
import { createProductionPage } from './productionPageFixture.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const imageReferences = (value: PdfDirectObject | undefined): number[] =>
  value?.kind === 'dictionary' ? [...value.entries.entries()].flatMap(([, item]) => (item.kind === 'reference' ? [item.objectNumber] : [])) : [];

const subtype = (value: PdfObject): string | undefined => {
  const name = value.kind === 'stream' ? value.dictionary.get(pdfName('Subtype').bytes) : undefined;
  return name?.kind === 'name' ? ascii(name.bytes) : undefined;
};

const sharedImageMask = (bytes: Uint8Array): readonly [number, boolean, boolean] => {
  const document = loadDocument(bytes);
  const objects = Array.from({ length: 30 }, (_, index) => ({ number: index + 1, value: document.get(pdfReference(index + 1, 0)) }));
  const masks = objects.filter(({ value }) => value.kind === 'stream' && value.dictionary.get(pdfName('ImageMask').bytes)?.kind === 'boolean');
  const maskNumber = masks[0]?.number;
  const xobject = pdfName('XObject').bytes;
  const pageUses = imageReferences(document.page(0).resources().get(xobject)).includes(maskNumber ?? -1);
  const form = objects.find(({ value }) => subtype(value) === 'Form')?.value;
  const formResources = form?.kind === 'stream' ? form.dictionary.get(pdfName('Resources').bytes) : undefined;
  const formUses = imageReferences(formResources?.kind === 'dictionary' ? formResources.entries.get(xobject) : undefined).includes(maskNumber ?? -1);
  return [masks.length, pageUses, formUses];
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

  it('uses one stencil image for both spot plates', () => {
    const bytes = createProductionPage().saved.toBytes();
    expect(sharedImageMask(bytes)).toStrictEqual([1, true, true]);
  });
});

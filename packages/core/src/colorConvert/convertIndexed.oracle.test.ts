import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { convertIndexedSpaces } from './convertIndexed.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const pdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 1<000000ff0000>]>>>>>>',
      },
      { number: 4, body: streamBody('', '/CS1 cs 1 sc 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const imagePdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Im Do') },
      {
        number: 5,
        body: streamBody(
          '/Type/XObject/Subtype/Image/Width 2/Height 1/BitsPerComponent 8/ColorSpace[/Indexed/DeviceRGB 1<000000ff0000>]',
          String.fromCodePoint(0, 1),
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const formPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Fm Do') },
      {
        number: 5,
        body: streamBody(
          '/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 1<000000ff0000>]>>>>',
          '/CS1 cs 1 sc 0 0 10 10 re f',
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

interface IndexedLookup {
  readonly base: string;
  readonly lookup: Uint8Array;
}

const indexed = (document: ReturnType<typeof loadDocument>): IndexedLookup => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('missing ColorSpace resources');
  const value = spaces.entries.get(pdfName('CS1').bytes);
  if (value?.kind !== 'array') throw new Error('missing Indexed space');
  const [, base, , lookup] = value.items;
  if (base?.kind !== 'name' || lookup?.kind !== 'string') throw new Error('invalid Indexed space');
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes };
};

const imageIndexed = (document: ReturnType<typeof loadDocument>): IndexedLookup & { readonly data: Uint8Array } => {
  const image = document.get(pdfReference(5, 0));
  if (image.kind !== 'stream') throw new Error('image is missing');
  const value = image.dictionary.get(pdfName('ColorSpace').bytes);
  if (value?.kind !== 'array') throw new Error('Indexed image colour space is missing');
  const [, base, , lookup] = value.items;
  if (base?.kind !== 'name' || lookup?.kind !== 'string') throw new Error('Indexed image colour space is invalid');
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes, data: image.data };
};

const formIndexed = (document: ReturnType<typeof loadDocument>): IndexedLookup => {
  const form = document.get(pdfReference(5, 0));
  if (form.kind !== 'stream') throw new Error('form is missing');
  const resources = form.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') throw new Error('form resources are missing');
  const spaces = resources.entries.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('form ColorSpace resources are missing');
  const value = spaces.entries.get(pdfName('CS1').bytes);
  if (value?.kind !== 'array') throw new Error('form Indexed space is missing');
  const [, base, , lookup] = value.items;
  if (base?.kind !== 'name' || lookup?.kind !== 'string') throw new Error('form Indexed space is invalid');
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes };
};

describe('indexed colour conversion', () => {
  it('converts the lookup once and leaves painted index operands untouched', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(Uint8Array.of(0, 0, 0, 255, 0, 0), expected, 2);
    expect(report.indexed).toBe(1);
    expect(indexed(document)).toStrictEqual({ base: 'DeviceCMYK', lookup: expected });
  });

  it('converts an image lookup without changing its index samples', () => {
    const document = loadDocument(imagePdf.bytes);
    const report = convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(Uint8Array.of(0, 0, 0, 255, 0, 0), expected, 2);
    expect(report.indexed).toBe(1);
    expect(imageIndexed(document)).toStrictEqual({ base: 'DeviceCMYK', lookup: expected, data: Uint8Array.of(0, 1) });
  });

  it('converts a form resource lookup without rewriting its tint operands', () => {
    const document = loadDocument(formPdf.bytes);
    const report = convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.indexed).toBe(1);
    expect(formIndexed(document).base).toBe('DeviceCMYK');
  });
});

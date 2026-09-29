import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertForms } from './convertForms.ts';
import { convertOtherCarriers } from './convertOtherCarriers.ts';

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
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Pattern<</P 5 0 R>>/Font<</F 6 0 R>>>>/Annots[7 0 R]>>' },
      { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 100 100 re f BT /F 12 Tf 10 10 Td (A) Tj ET') },
      {
        number: 5,
        body: streamBody('/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<<>>', '1 0 0 rg 0 0 10 10 re f'),
      },
      {
        number: 6,
        body: '<</Type/Font/Subtype/Type3/Name/F/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</A 9 0 R>>/Encoding<</Type/Encoding/Differences[65/A]>>/FirstChar 65/LastChar 65/Widths[1000]/Resources<<>>>>',
      },
      { number: 7, body: '<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/F 4/C[0 0 0]/IC[1 0 0]/AP<</N 10 0 R>>/MK<</BG[0 1 0]/BC[0 0 1]>>>>' },
      { number: 9, body: streamBody('', '1000 0 d0 0 1 0 rg 0 0 500 500 re f') },
      { number: 10, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0 0 1 rg 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const nestedCarrierPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Annots[7 0 R]/Resources<</Pattern<</P 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 100 100 re f') },
      {
        number: 5,
        body: streamBody(
          '/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<</XObject<</Fm 11 0 R>>>>',
          '/Fm Do',
        ),
      },
      { number: 7, body: '<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/F 4/AP<</N 10 0 R>>>>' },
      { number: 10, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</XObject<</Fm 11 0 R>>>>', '/Fm Do') },
      { number: 11, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '1 0 0 rg 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const content = (document: ReturnType<typeof loadDocument>, number: number): string => {
  const object = document.get(pdfReference(number, 0));
  if (object.kind !== 'stream') throw new Error('content stream is missing');
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('document internals are unavailable');
  const data = decodedData(internals, object);
  if (typeof data === 'string') throw new Error(data);
  return latin1Text(data);
};

const color = (document: ReturnType<typeof loadDocument>, key: string): readonly number[] => {
  const annotation = document.get(pdfReference(7, 0));
  if (annotation.kind !== 'dictionary') throw new Error('annotation is missing');
  const value = annotation.entries.get(pdfName(key).bytes);
  if (value?.kind !== 'array') throw new Error('annotation color is missing');
  return value.items.map(item => {
    if (item.kind === 'integer') return item.value;
    if (item.kind === 'real' && typeof item.value === 'number') return item.value;
    return -1;
  });
};

const widgetColor = (document: ReturnType<typeof loadDocument>, key: string) => {
  const annotation = document.get(pdfReference(7, 0));
  if (annotation.kind !== 'dictionary') throw new Error('annotation is missing');
  const mk = annotation.entries.get(pdfName('MK').bytes);
  if (mk?.kind !== 'dictionary') throw new Error('widget appearance characteristics are missing');
  const value = mk.entries.get(pdfName(key).bytes);
  if (value?.kind !== 'array') throw new Error('widget colour is missing');
  return value.items;
};

describe('other painted colour carriers', () => {
  it('converts forms reached only through appearances and tiling patterns', () => {
    const document = loadDocument(nestedCarrierPdf.bytes);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination });
    convertOtherCarriers(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.forms).toBe(1);
    expect(content(document, 11)).toMatch(/\bk\b/u);
  });

  it('converts annotation and widget colour arrays', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertOtherCarriers(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report).toMatchObject({ annotations: 1, appearances: 1, patterns: 1, glyphs: 1 });
    expect(color(document, 'C')).toStrictEqual([0, 0, 0, 1]);
    expect(color(document, 'IC')).toHaveLength(4);
    expect(widgetColor(document, 'BG')).toHaveLength(4);
    expect(widgetColor(document, 'BC')).toHaveLength(4);
  });

  it('converts appearances, coloured patterns, and Type 3 d0 glyphs through a full save', () => {
    const document = loadDocument(pdf.bytes);
    convertOtherCarriers(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(document.save().mode).toBe('full');
    const saved = loadDocument(document.save().toBytes());
    for (const number of [5, 9, 10]) {
      expect(content(saved, number)).toMatch(/\bk\b/u);
    }
  });
});

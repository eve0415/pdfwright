import type { PdfDirectObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertTransparencyGroups } from './convertGroups.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));

const pagePdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Group<</S/Transparency/CS/DeviceRGB/I true>>/Contents 4 0 R/Resources<</ExtGState<</GS<</ca 0.5>>>>>>>>',
      },
      { number: 4, body: streamBody('', '/GS gs 1 0 0 rg 0 0 10 10 re f') },
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
          '/Type/XObject/Subtype/Form/BBox[0 0 100 100]/Group<</S/Transparency/CS/DeviceRGB/I true>>/Resources<</ExtGState<</GS<</BM/Multiply>>>>>>',
          '/GS gs 0 1 0 rg 0 0 10 10 re f',
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const luminosityPdf = (color: string) =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R/BC[0 0 0]>>>>>>>>>>',
        },
        { number: 4, body: streamBody('', '/GS gs 0.25 0.5 0.75 rg 0 0 10 10 re f') },
        {
          number: 6,
          body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS ${color}>>/Resources<<>>`, '1 0 0 rg 0 0 10 10 re f'),
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]);

const groupSpace = (document: ReturnType<typeof loadDocument>, reference: ReturnType<typeof pdfReference>): string => {
  const owner = document.get(reference);
  let group: PdfDirectObject | undefined = undefined;
  if (owner.kind === 'stream') group = owner.dictionary.get(pdfName('Group').bytes);
  else if (owner.kind === 'dictionary') group = owner.entries.get(pdfName('Group').bytes);
  if (group?.kind !== 'dictionary') throw new Error('transparency group is missing');
  const color = group.entries.get(pdfName('CS').bytes);
  if (color?.kind !== 'name') throw new Error('group colour space is missing');
  return new TextDecoder('latin1').decode(color.bytes);
};

const luminosityContent = (document: ReturnType<typeof loadDocument>): string => {
  const form = document.get(pdfReference(6, 0));
  if (form.kind !== 'stream') throw new Error('mask group is missing');
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('document internals are missing');
  const data = decodedData(internals, form);
  if (typeof data === 'string') throw new Error(data);
  return latin1Text(data);
};

const backdrop = (document: ReturnType<typeof loadDocument>): readonly number[] => {
  const state = document.page(0).resources().get(pdfName('ExtGState').bytes);
  if (state?.kind !== 'dictionary') throw new Error('ExtGState is missing');
  const gs = state.entries.get(pdfName('GS').bytes);
  if (gs?.kind !== 'dictionary') throw new Error('graphics state is missing');
  const mask = gs.entries.get(pdfName('SMask').bytes);
  if (mask?.kind !== 'dictionary') throw new Error('soft mask is missing');
  const color = mask.entries.get(pdfName('BC').bytes);
  if (color?.kind !== 'array') throw new Error('mask backdrop is missing');
  return color.items.map(value => {
    if (value.kind === 'integer') return value.value;
    if (value.kind === 'real' && typeof value.value === 'number') return value.value;
    return -1;
  });
};

describe('transparency group conversion', () => {
  it('changes an RGB page group and reports alpha compositing', () => {
    const document = loadDocument(pagePdf.bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(groupSpace(document, pdfReference(3, 0))).toBe('DeviceCMYK');
    expect(report).toMatchObject({ groups: 1, blendingSpaceChanges: { alpha: 1, blendMode: 0, softMask: 0 } });
  });

  it('refuses an appearance-changing group when requested', () => {
    const document = loadDocument(pagePdf.bytes);
    expect(() => {
      convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination, blendingSpace: 'refuse' });
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'blend-space-change' }));
    expect(groupSpace(document, pdfReference(3, 0))).toBe('DeviceRGB');
  });

  it('changes an RGB form group and reports its blend mode', () => {
    const document = loadDocument(formPdf.bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(groupSpace(document, pdfReference(5, 0))).toBe('DeviceCMYK');
    expect(report.blendingSpaceChanges.blendMode).toBe(1);
  });

  it('keeps a DeviceRGB luminosity mask unchanged in gray', () => {
    const document = loadDocument(luminosityPdf('/DeviceRGB').bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceGray');
    expect(luminosityContent(document)).toContain('0.3 g');
    expect(backdrop(document)).toStrictEqual([0]);
    expect(report.groups).toBe(1);
  });

  it('keeps a CalRGB luminosity group and reports it', () => {
    const document = loadDocument(luminosityPdf('[/CalRGB<</WhitePoint[0.95047 1 1.08883]>>]').bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.keptLuminosityGroups).toBe(1);
    expect(report.groups).toBe(0);
    expect(luminosityContent(document)).toContain('1 0 0 rg');
  });

  it('refuses a DeviceRGB luminosity group when blending changes are refused', () => {
    const document = loadDocument(luminosityPdf('/DeviceRGB').bytes);
    expect(() => convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination, blendingSpace: 'refuse' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'blend-space-change' }),
    );
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceRGB');
  });
});

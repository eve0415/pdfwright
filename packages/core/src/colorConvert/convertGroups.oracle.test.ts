import type { PdfDirectObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readContent } from '../content/contentOperations.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
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

const appearancePdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Annots [6 0 R] /Resources << >> >>' },
      { number: 4, body: streamBody('', '') },
      {
        number: 5,
        body: streamBody(
          '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceRGB >> /Resources << /XObject << /Nested 7 0 R >> /ExtGState << /GS << /SMask << /S /Luminosity /G 8 0 R >> >> >> >>',
          '/GS gs /Nested Do 0 1 1 rg 0 0 100 100 re f',
        ),
      },
      { number: 6, body: '<< /Type /Annot /Subtype /Square /Rect [0 0 100 100] /F 4 /AP << /N 5 0 R >> >>' },
      { number: 7, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 100 100]/Group<</S/Transparency/CS/DeviceRGB>>', '1 0 0 rg 0 0 10 10 re f') },
      { number: 8, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 100 100]/Group<</S/Transparency/CS/DeviceRGB>>', '0 1 0 rg 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const patternPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Pattern<</P 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 100 100 re f') },
      {
        number: 5,
        body: streamBody(
          '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << /XObject << /Fm 7 0 R >> /ExtGState << /GS << /SMask << /S /Luminosity /G 8 0 R >> >> >> >>',
          '/GS gs /Fm Do',
        ),
      },
      { number: 7, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>', '1 0 0 rg 0 0 10 10 re f') },
      { number: 8, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>', '0 1 0 rg 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const luminosityPdf = (color: string, subtype = 'Luminosity') =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/${subtype}/G 6 0 R/BC[0 0 0]>>>>>>>>>>`,
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

const compressedMaskPdf = (filter: 'DCTDecode' | 'JPXDecode') =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>>>>>',
        },
        { number: 4, body: streamBody('', '/GS gs 1 0 0 rg 0 0 10 10 re f') },
        {
          number: 6,
          body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</XObject<</Im 9 0 R>>>>', '/Im Do'),
        },
        { number: 9, body: streamBody(`/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/${filter}`, 'image') },
      ],
      trailer: '/Root 1 0 R',
    },
  ]);

const rgbImageMaskPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>>>>>' },
      { number: 4, body: streamBody('', '/GS gs 1 0 0 rg 0 0 10 10 re f') },
      {
        number: 6,
        body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</XObject<</Im 9 0 R>>>>', '/Im Do'),
      },
      { number: 9, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB', String.fromCodePoint(255, 0, 0)) },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const nestedFormMaskPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>>>>>' },
      { number: 4, body: streamBody('', '/GS gs 1 0 0 rg 0 0 10 10 re f') },
      {
        number: 6,
        body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</XObject<</Fm 9 0 R>>>>', '/Fm Do'),
      },
      { number: 9, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '1 0 0 rg 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const inlineImageMaskPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>>>>>' },
      { number: 4, body: streamBody('', '/GS gs 1 0 0 rg 0 0 10 10 re f') },
      {
        number: 6,
        body: streamBody(
          '/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>',
          `BI /W 1 /H 1 /BPC 8 /CS /RGB ID\n${String.fromCodePoint(255, 0, 0)}\nEI`,
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const maskInline = (document: ReturnType<typeof loadDocument>): Uint8Array => {
  const form = document.get(pdfReference(6, 0));
  if (form.kind !== 'stream') throw new Error('mask form is missing');
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('internals are unavailable');
  const data = decodedData(internals, form);
  if (typeof data === 'string') throw new Error(data);
  const [operation] = readContent(data, internals.maxNesting);
  if (operation?.inlineImage === undefined) throw new Error('inline image is missing');
  const decoded = inflateZlib(operation.inlineImage.data);
  return decoded.data;
};

const maskXObject = (document: ReturnType<typeof loadDocument>, name: string) => {
  const group = document.get(pdfReference(6, 0));
  if (group.kind !== 'stream') throw new Error('mask group is missing');
  const resources = group.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') throw new Error('mask resources are missing');
  const xobjects = resources.entries.get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') throw new Error('mask XObjects are missing');
  const reference = xobjects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') throw new Error('mask XObject is missing');
  return reference;
};

const maskImage = (document: ReturnType<typeof loadDocument>) => {
  const group = document.get(pdfReference(6, 0));
  if (group.kind !== 'stream') throw new Error('mask group is missing');
  const resources = group.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') throw new Error('mask resources are missing');
  const xobjects = resources.entries.get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') throw new Error('mask XObjects are missing');
  const reference = xobjects.entries.get(pdfName('Im').bytes);
  if (reference?.kind !== 'reference') throw new Error('mask image is missing');
  const image = document.get(reference);
  if (image.kind !== 'stream') throw new Error('mask image is not a stream');
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('internals are unavailable');
  const data = decodedData(internals, image);
  if (typeof data === 'string') throw new Error(data);
  return { color: image.dictionary.get(pdfName('ColorSpace').bytes), data, reference: reference.objectNumber };
};

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

const contentAt = (document: ReturnType<typeof loadDocument>, number: number): string => {
  const form = document.get(pdfReference(number, 0));
  if (form.kind !== 'stream') throw new Error('mask group is missing');
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('document internals are missing');
  const data = decodedData(internals, form);
  if (typeof data === 'string') throw new Error(data);
  return latin1Text(data);
};

const luminosityContent = (document: ReturnType<typeof loadDocument>): string => contentAt(document, 6);

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

  it('converts appearance and nested form groups and the appearance soft mask', () => {
    const document = loadDocument(appearancePdf.bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(groupSpace(document, pdfReference(5, 0))).toBe('DeviceCMYK');
    expect(groupSpace(document, pdfReference(7, 0))).toBe('DeviceCMYK');
    expect(groupSpace(document, pdfReference(8, 0))).toBe('DeviceGray');
    expect(report.groups).toBe(3);
  });

  it('converts a pattern-reached form group and the pattern soft mask', () => {
    const document = loadDocument(patternPdf.bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(groupSpace(document, pdfReference(7, 0))).toBe('DeviceCMYK');
    expect(groupSpace(document, pdfReference(8, 0))).toBe('DeviceGray');
    expect(report.groups).toBe(2);
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

  it('converts a CalRGB luminosity group only when gray is requested', () => {
    const document = loadDocument(luminosityPdf('[/CalRGB<</WhitePoint[0.95047 1 1.08883]>>]').bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination, luminosityGroups: 'gray' });
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceGray');
    expect(backdrop(document)).toHaveLength(1);
    expect(report.groups).toBe(1);
    expect(report.approximateLuminosityGroups).toBe(1);
  });

  it('refuses a DeviceRGB luminosity group when blending changes are refused', () => {
    const document = loadDocument(luminosityPdf('/DeviceRGB').bytes);
    expect(() => convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination, blendingSpace: 'refuse' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'blend-space-change' }),
    );
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceRGB');
  });

  it('converts an alpha soft-mask group and its painted colours', () => {
    const document = loadDocument(luminosityPdf('/DeviceRGB', 'Alpha').bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceCMYK');
    expect(luminosityContent(document)).toMatch(/\bk\b/u);
    expect(report.groups).toBe(1);
  });

  it.each(['DCTDecode', 'JPXDecode'] as const)('refuses RGB %s in a luminosity mask with a typed reason', filter => {
    const document = loadDocument(compressedMaskPdf(filter).bytes);
    expect(() => convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination })).toThrow(
      expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'luminosity-compressed-rgb-image' }),
    );
  });

  it('converts an RGB image used by a luminosity group into a separate gray image', () => {
    const document = loadDocument(rgbImageMaskPdf.bytes);
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const image = maskImage(document);
    expect(image.color).toStrictEqual(pdfName('DeviceGray'));
    expect(image.data).toStrictEqual(Uint8Array.of(77));
    expect(image.reference).not.toBe(9);
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceGray');
  });

  it('converts a nested form in a luminosity group without changing the original form', () => {
    const document = loadDocument(nestedFormMaskPdf.bytes);
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = maskXObject(document, 'Fm');
    expect(converted.objectNumber).not.toBe(9);
    expect(contentAt(document, converted.objectNumber)).toContain('0.3 g');
    expect(contentAt(document, 9)).toContain('1 0 0 rg');
  });

  it('converts an inline RGB image in a luminosity group to gray', () => {
    const document = loadDocument(inlineImageMaskPdf.bytes);
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(luminosityContent(document)).toContain('/CS /G');
    expect(maskInline(document)).toStrictEqual(Uint8Array.of(77));
  });
});

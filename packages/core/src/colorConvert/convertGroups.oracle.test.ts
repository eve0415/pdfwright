import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { GroupConversionReport } from './convertGroups.ts';

import { readFile } from 'node:fs/promises';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { calibratedProfile } from '../color/calibratedSource.ts';
import { labToXyz } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';
import { readInlineImage } from '../testing/readInlineImage.ts';

import { convertTransparencyGroups } from './convertGroups.ts';
import { deviceRgbLuminosity } from './luminosityContent.ts';
import { MeshBitReader } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const displayP3Bytes = await fixture('DisplayP3-v4.icc');
const flateRgb = deflateZlib(Uint8Array.of(255, 0, 0));
const corruptFlateRgb = flateRgb.map((byte, index) => (index === flateRgb.length - 1 ? byte ^ 0xff : byte));

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

const luminosityPdf = (color: string, subtype = 'Luminosity', backdropColor = '[0 0 0]') =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/${subtype}/G 6 0 R/BC${backdropColor}>>>>>>>>>>`,
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

const axialMaskPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>>>>>' },
      { number: 4, body: streamBody('', '/GS gs 1 0 0 rg 0 0 10 10 re f') },
      {
        number: 6,
        body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</Shading<</Sh1 9 0 R>>>>', '/Sh1 sh'),
      },
      { number: 9, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function 10 0 R>>' },
      { number: 10, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const stitchedMaskPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</SMask<</S/Luminosity/G 6 0 R>>>>>>>>>>' },
      { number: 4, body: streamBody('', '/GS gs 1 0 0 rg 0 0 10 10 re f') },
      {
        number: 6,
        body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</Shading<</Sh1 9 0 R>>>>', '/Sh1 sh'),
      },
      { number: 9, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function 10 0 R>>' },
      { number: 10, body: '<</FunctionType 3/Domain[0 1]/Functions[11 0 R 12 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' },
      { number: 11, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[1 0 0]/N 1>>' },
      { number: 12, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 1]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const meshMaskPdf = (): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const vertex of [
    [0, 0, 255, 0, 0],
    [10, 0, 0, 255, 0],
    [0, 10, 0, 0, 255],
  ]) {
    writer.write(2, 0);
    for (const value of vertex) {
      writer.write(8, value);
    }
    writer.alignByte();
  }
  const meshBytes = latin1Text(writer.finish(1024));
  return buildPdf([
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
          body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceRGB>>/Resources<</Shading<</Sh1 9 0 R>>>>', '/Sh1 sh'),
        },
        {
          number: 9,
          body: streamBody('/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 10 0 10 0 1 0 1 0 1]', meshBytes),
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;
};

const maskShading = (document: ReturnType<typeof loadDocument>) => {
  const group = document.get(pdfReference(6, 0));
  if (group.kind !== 'stream') {
    throw new Error('mask group is missing');
  }
  const resources = group.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') {
    throw new Error('mask resources are missing');
  }
  const shadings = resources.entries.get(pdfName('Shading').bytes);
  if (shadings?.kind !== 'dictionary') {
    throw new Error('mask Shading resources are missing');
  }
  const reference = shadings.entries.get(pdfName('Sh1').bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('mask shading reference is missing');
  }
  return document.get(reference);
};

const meshMaskSample = (document: ReturnType<typeof loadDocument>) => {
  const shading = maskShading(document);
  if (shading.kind !== 'stream') {
    throw new Error('mesh shading is not a stream');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('internals are unavailable');
  }
  const data = decodedData(internals, shading);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  const reader = new MeshBitReader(data);
  const records: Array<ReadonlyArray<number>> = [];
  while (reader.remainingBits > 0) {
    records.push([reader.read(2), reader.read(8), reader.read(8), reader.read(8)]);
    reader.alignByte();
  }
  return { color: shading.dictionary.get(pdfName('ColorSpace').bytes), records };
};

const maskFunction = (document: ReturnType<typeof loadDocument>) => {
  const shading = maskShading(document);
  if (shading.kind !== 'dictionary') {
    throw new Error('mask shading is not a dictionary');
  }
  const reference = shading.entries.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('gray function is missing');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('internals are unavailable');
  }
  const decoded = (value: ReturnType<typeof document.get>) => {
    if (value.kind !== 'stream') {
      return value;
    }
    const data = decodedData(internals, value);
    if (typeof data === 'string') {
      throw new TypeError(data);
    }
    return { kind: 'stream' as const, dictionary: value.dictionary, data };
  };
  const root = decoded(document.get(reference));
  const evaluate = createPdfFunction(root, child => {
    const object = internals.objects.deref(child);
    if (object === undefined) {
      throw new Error('gray child function is missing');
    }
    return decoded(object);
  });
  return { root, evaluate };
};

const maskShadingValues = (document: ReturnType<typeof loadDocument>) => {
  const shading = maskShading(document);
  if (shading.kind !== 'dictionary') {
    throw new Error('mask shading is not a dictionary');
  }
  const reference = shading.entries.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('gray function is missing');
  }
  const functionObject = document.get(reference);
  if (functionObject.kind !== 'stream') {
    throw new Error('gray function is not a stream');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('internals are unavailable');
  }
  const data = decodedData(internals, functionObject);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  const evaluate = createPdfFunction({ kind: 'stream', dictionary: functionObject.dictionary, data });
  return { color: shading.entries.get(pdfName('ColorSpace').bytes), start: evaluate([0])[0], end: evaluate([1])[0] };
};

/** The inline image of mask form 6 as a reader sees it: the operators the form holds, the warnings the image's own filters raise and the samples they decode to. */
const maskInline = (document: ReturnType<typeof loadDocument>) => {
  const form = document.get(pdfReference(6, 0));
  if (form.kind !== 'stream') {
    throw new Error('mask form is missing');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('internals are unavailable');
  }
  const data = decodedData(internals, form);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return readInlineImage(data);
};

const maskXObject = (document: ReturnType<typeof loadDocument>, name: string) => {
  const group = document.get(pdfReference(6, 0));
  if (group.kind !== 'stream') {
    throw new Error('mask group is missing');
  }
  const resources = group.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') {
    throw new Error('mask resources are missing');
  }
  const xobjects = resources.entries.get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') {
    throw new Error('mask XObjects are missing');
  }
  const reference = xobjects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('mask XObject is missing');
  }
  return reference;
};

const maskImage = (document: ReturnType<typeof loadDocument>) => {
  const group = document.get(pdfReference(6, 0));
  if (group.kind !== 'stream') {
    throw new Error('mask group is missing');
  }
  const resources = group.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') {
    throw new Error('mask resources are missing');
  }
  const xobjects = resources.entries.get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') {
    throw new Error('mask XObjects are missing');
  }
  const reference = xobjects.entries.get(pdfName('Im').bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('mask image is missing');
  }
  const image = document.get(reference);
  if (image.kind !== 'stream') {
    throw new Error('mask image is not a stream');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('internals are unavailable');
  }
  const data = decodedData(internals, image);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return { color: image.dictionary.get(pdfName('ColorSpace').bytes), data, reference: reference.objectNumber };
};

const groupSpace = (document: ReturnType<typeof loadDocument>, reference: ReturnType<typeof pdfReference>): string => {
  const owner = document.get(reference);
  let group: PdfDirectObject | undefined;
  if (owner.kind === 'stream') {
    group = owner.dictionary.get(pdfName('Group').bytes);
  } else if (owner.kind === 'dictionary') {
    group = owner.entries.get(pdfName('Group').bytes);
  }
  if (group?.kind !== 'dictionary') {
    throw new Error('transparency group is missing');
  }
  const color = group.entries.get(pdfName('CS').bytes);
  if (color?.kind !== 'name') {
    throw new Error('group colour space is missing');
  }
  return new TextDecoder('latin1').decode(color.bytes);
};

const contentAt = (document: ReturnType<typeof loadDocument>, number: number): string => {
  const form = document.get(pdfReference(number, 0));
  if (form.kind !== 'stream') {
    throw new Error('mask group is missing');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('document internals are missing');
  }
  const data = decodedData(internals, form);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return latin1Text(data);
};

const luminosityContent = (document: ReturnType<typeof loadDocument>): string => contentAt(document, 6);

const backdrop = (document: ReturnType<typeof loadDocument>): ReadonlyArray<number> => {
  const state = document.page(0).resources().get(pdfName('ExtGState').bytes);
  if (state?.kind !== 'dictionary') {
    throw new Error('ExtGState is missing');
  }
  const gs = state.entries.get(pdfName('GS').bytes);
  if (gs?.kind !== 'dictionary') {
    throw new Error('graphics state is missing');
  }
  const mask = gs.entries.get(pdfName('SMask').bytes);
  if (mask?.kind !== 'dictionary') {
    throw new Error('soft mask is missing');
  }
  const color = mask.entries.get(pdfName('BC').bytes);
  if (color?.kind !== 'array') {
    throw new Error('mask backdrop is missing');
  }
  return color.items.map(value => {
    if (value.kind === 'integer') {
      return value.value;
    }
    if (value.kind === 'real' && typeof value.value === 'number') {
      return value.value;
    }
    return -1;
  });
};

interface ExtraObject {
  readonly number: number;
  readonly body: string;
}

const groupPagePdf = (config: {
  readonly group?: string;
  readonly content?: string;
  readonly resources?: string;
  readonly objects?: ReadonlyArray<ExtraObject>;
}): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]${config.group === undefined ? '' : `/Group${config.group}`}/Contents 4 0 R/Resources<<${config.resources ?? ''}>>>>`,
        },
        { number: 4, body: streamBody('', config.content ?? '/GS gs 1 0 0 rg 0 0 10 10 re f') },
        ...(config.objects ?? []),
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

/** A page whose graphics state GS applies a soft mask, by default a luminosity mask drawn by the DeviceRGB group form 6. */
const maskPdf = (config: {
  readonly content: string;
  readonly subtype?: 'Luminosity' | 'Alpha';
  readonly mask?: string;
  readonly group?: string;
  readonly resources?: string;
  readonly objects?: ReadonlyArray<ExtraObject>;
}): Uint8Array =>
  groupPagePdf({
    resources: `/ExtGState<</GS<</SMask<</S/${config.subtype ?? 'Luminosity'}${config.mask ?? '/G 6 0 R'}>>>>>>`,
    objects: [
      {
        number: 6,
        body: streamBody(
          `/Type/XObject/Subtype/Form/BBox[0 0 10 10]${config.group ?? '/Group<</S/Transparency/CS/DeviceRGB>>'}${config.resources === undefined ? '' : `/Resources${config.resources}`}`,
          config.content,
        ),
      },
      ...(config.objects ?? []),
    ],
  });

const grayMaskGroup: ExtraObject = {
  number: 6,
  body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Group<</S/Transparency/CS/DeviceGray>>', '0.5 g 0 0 10 10 re f'),
};

/** Converts the document and names the result, so a table can hold both converted and refused rows. */
const outcome = (document: ReturnType<typeof loadDocument>, blendingSpace: 'cmyk' | 'refuse' = 'cmyk'): string => {
  try {
    return `converted ${String(convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination, blendingSpace }).groups)}`;
  } catch (error) {
    if (error instanceof ValidationError) {
      return `ValidationError ${error.reason ?? ''}`;
    }
    if (error instanceof UnsupportedFeatureError) {
      return 'UnsupportedFeatureError';
    }
    if (error instanceof ResourceLimitError) {
      return 'ResourceLimitError';
    }
    throw error;
  }
};

const maskEntry = (document: ReturnType<typeof loadDocument>, key: string): PdfDirectObject | undefined => {
  const state = document.page(0).resources().get(pdfName('ExtGState').bytes);
  const gs = state?.kind === 'dictionary' ? state.entries.get(pdfName('GS').bytes) : undefined;
  const mask = gs?.kind === 'dictionary' ? gs.entries.get(pdfName('SMask').bytes) : undefined;
  if (mask?.kind !== 'dictionary') {
    throw new Error('soft mask is missing');
  }
  return mask.entries.get(pdfName(key).bytes);
};

const imageEntry = (document: ReturnType<typeof loadDocument>, objectNumber: number, key: string): PdfDirectObject | undefined => {
  const image = document.get(pdfReference(objectNumber, 0));
  return image.kind === 'stream' ? image.dictionary.get(pdfName(key).bytes) : undefined;
};

/** Reads the gray colour of every record in a converted mesh, skipping the flag and coordinate fields. */
const meshGrays = (data: Uint8Array, layout: { readonly flagBits: number; readonly points: number; readonly colors: number }): ReadonlyArray<number> => {
  const reader = new MeshBitReader(data);
  const grays: Array<number> = [];
  while (reader.remainingBits > 0) {
    if (layout.flagBits > 0) {
      reader.read(layout.flagBits);
    }
    for (let coordinate = 0; coordinate < layout.points * 2; coordinate++) {
      reader.read(8);
    }
    for (let color = 0; color < layout.colors; color++) {
      grays.push(reader.read(8));
    }
    reader.alignByte();
  }
  return grays;
};

const meshShadingData = (document: ReturnType<typeof loadDocument>): Uint8Array => {
  const shading = maskShading(document);
  const internals = internalsOf(document);
  if (shading.kind !== 'stream' || internals === undefined) {
    throw new Error('mesh shading is missing');
  }
  const data = decodedData(internals, shading);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return data;
};

/** The CIE Y of a colour in a profile's PCS, the luminosity ISO 32000-1:2008, 11.5.3 asks for from a CIE-based group. */
const luminance = (profile: ReturnType<typeof parseIccProfile>, values: ReadonlyArray<number>): number => {
  const pcs = sourceEvaluator(profile, 'relativeColorimetric', 'icc')(values);
  return (pcs.space === 'XYZ' ? pcs.values[1] : labToXyz(pcs.values)[1]) ?? Number.NaN;
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
    const document = loadDocument(luminosityPdf('/DeviceRGB', 'Luminosity', '[1 0 0]').bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceGray');
    expect(luminosityContent(document)).toContain('0.3 g');
    // ISO 32000-1:2008, 10.3.2: DeviceRGB maps to gray as 0.3 R + 0.59 G + 0.11 B, for the backdrop as for the paint.
    expect(backdrop(document)).toStrictEqual([0.3]);
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
    const document = loadDocument(luminosityPdf('[/CalRGB<</WhitePoint[0.95047 1 1.08883]>>]', 'Luminosity', '[0 1 0]').bytes);
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination, luminosityGroups: 'gray' });
    expect(groupSpace(document, pdfReference(6, 0))).toBe('DeviceGray');
    // The paint is DeviceRGB, so its gray is the CIE Y of sRGB red; the backdrop is in the group's CalRGB space, whose identity Matrix puts all of G into Y.
    const calRgb = calibratedProfile({ kind: 'calRGB', whitePoint: { x: 0.95047, y: 1, z: 1.08883 }, gamma: [1, 1, 1], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
    const paint = /(?<gray>[\d.]+) g\b/u.exec(luminosityContent(document))?.groups?.['gray'];
    expect(Number(paint)).toBeCloseTo(luminance(source, [1, 0, 0]), 4);
    expect(luminance(source, [1, 0, 0])).not.toBeCloseTo(0.3, 2);
    expect(backdrop(document).map(value => value.toFixed(4))).toStrictEqual([luminance(calRgb, [0, 1, 0]).toFixed(4)]);
    expect(luminance(calRgb, [0, 1, 0])).not.toBeCloseTo(0.59, 2);
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

  it('refuses calibrated gray paint in a luminosity mask before editing when no caller takes the refusal', () => {
    const { bytes } = buildPdf([
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
          {
            number: 9,
            body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace[/CalGray<</WhitePoint[0.9505 1 1.089]>>]', 'A'),
          },
        ],
        trailer: '/Root 1 0 R',
      },
    ]);
    const document = loadDocument(bytes);
    const convert = (): GroupConversionReport => convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(convert).toThrow(UnsupportedFeatureError);
    expect(convert).toThrow(/calibrated gray/u);
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
    expect(maskInline(document).samples).toStrictEqual(Uint8Array.of(77));
  });

  it('converts an axial RGB shading in a luminosity group to a gray function', () => {
    const document = loadDocument(axialMaskPdf.bytes);
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const values = maskShadingValues(document);
    expect(values.color).toStrictEqual(pdfName('DeviceGray'));
    expect(values.start).toBeCloseTo(0.3, 3);
    expect(values.end).toBeCloseTo(0.11, 3);
  });

  it('preserves a hard colour stop in a luminosity shading', () => {
    const document = loadDocument(stitchedMaskPdf.bytes);
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const result = maskFunction(document);
    expect(result.root.kind).toBe('dictionary');
    expect(result.evaluate([0.499])[0]).toBeCloseTo(0.3, 3);
    expect(result.evaluate([0.501])[0]).toBeCloseTo(0.11, 3);
  });

  it('converts a mesh shading in a luminosity group to gray vertices', () => {
    const document = loadDocument(meshMaskPdf());
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const result = meshMaskSample(document);
    expect(result.color).toStrictEqual(pdfName('DeviceGray'));
    // ISO 32000-1:2008, 8.7.4.5.5 Table 84: each vertex keeps its flag and coordinates, and red, green and blue become 0.3, 0.59 and 0.11 of 255.
    expect(result.records).toStrictEqual([
      [0, 0, 0, 77],
      [0, 10, 0, 150],
      [0, 0, 10, 28],
    ]);
  });

  it.each([
    {
      name: 'refuses a group whose only compositing is a soft mask',
      state: '<</SMask<</S/Luminosity/G 6 0 R>>>>',
      result: 'ValidationError blend-space-change',
    },
    { name: 'refuses a group whose only compositing is stroke alpha', state: '<</CA 0.5>>', result: 'ValidationError blend-space-change' },
    { name: 'converts a group with no compositing', state: '<</LW 2>>', result: 'converted 1' },
  ])('$name when blending changes are refused', ({ state, result }) => {
    const document = loadDocument(
      groupPagePdf({ group: '<</S/Transparency/CS/DeviceRGB>>', resources: `/ExtGState<</GS${state}>>`, objects: [grayMaskGroup] }),
    );
    expect(outcome(document, 'refuse')).toBe(result);
  });

  it.each([
    { name: 'a blend-mode array that names a separable mode', state: '<</BM[/Normal/Multiply]>>', changes: { blendMode: 1, alpha: 0, softMask: 0 } },
    { name: 'the Compatible blend mode', state: '<</BM/Compatible>>', changes: { blendMode: 0, alpha: 0, softMask: 0 } },
    { name: 'an opaque fill alpha', state: '<</ca 1>>', changes: { blendMode: 0, alpha: 0, softMask: 0 } },
    { name: 'a fill alpha just below 1', state: '<</ca 0.999>>', changes: { blendMode: 0, alpha: 1, softMask: 0 } },
    { name: 'a stroke alpha', state: '<</CA 0.5>>', changes: { blendMode: 0, alpha: 1, softMask: 0 } },
    { name: 'a soft mask of None', state: '<</SMask/None>>', changes: { blendMode: 0, alpha: 0, softMask: 0 } },
    { name: 'a soft mask dictionary', state: '<</SMask<</S/Luminosity/G 6 0 R>>>>', changes: { blendMode: 0, alpha: 0, softMask: 1 } },
  ])('counts $name among the blending-space changes', ({ state, changes }) => {
    const document = loadDocument(
      groupPagePdf({ group: '<</S/Transparency/CS/DeviceRGB>>', resources: `/ExtGState<</GS${state}>>`, objects: [grayMaskGroup] }),
    );
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    // ISO 32000-1:2008, 11.3.5 and 11.6.4.4: Normal and Compatible blend like no blend mode, and an alpha of 1 or a soft mask of None composites nothing.
    expect([report.groups, report.blendingSpaceChanges]).toStrictEqual([1, changes]);
  });

  it.each([
    { name: 'converts an ICCBased RGB page group', group: '<</S/Transparency/CS[/ICCBased 7 0 R]>>', groups: 1, space: 'DeviceCMYK' },
    { name: 'leaves a DeviceGray page group', group: '<</S/Transparency/CS/DeviceGray>>', groups: 0, space: 'DeviceGray' },
    { name: 'leaves a DeviceCMYK page group', group: '<</S/Transparency/CS/DeviceCMYK>>', groups: 0, space: 'DeviceCMYK' },
    { name: 'ignores a page group whose subtype is not Transparency', group: '<</S/Other/CS/DeviceRGB>>', groups: 0, space: 'DeviceRGB' },
  ])('$name', ({ group, groups, space }) => {
    const document = loadDocument(
      groupPagePdf({ group, content: '1 0 0 rg 0 0 10 10 re f', objects: [{ number: 7, body: streamBody('/N 3', latin1Text(displayP3Bytes)) }] }),
    );
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect([report.groups, groupSpace(document, pdfReference(3, 0))]).toStrictEqual([groups, space]);
  });

  it('rewrites an indirect Group dictionary in place and keeps its I and K entries', () => {
    const bytes = groupPagePdf({
      group: ' 7 0 R',
      content: '1 0 0 rg 0 0 10 10 re f',
      objects: [{ number: 7, body: '<</S/Transparency/CS/DeviceRGB/I true/K true>>' }],
    });
    const original = loadDocument(bytes).get(pdfReference(7, 0));
    const document = loadDocument(bytes);
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const page = document.get(pdfReference(3, 0));
    const group = document.get(pdfReference(7, 0));
    if (page.kind !== 'dictionary' || group.kind !== 'dictionary' || original.kind !== 'dictionary') {
      throw new Error('page or group is missing');
    }
    expect(page.entries.get(pdfName('Group').bytes)).toStrictEqual(pdfReference(7, 0));
    expect(group.entries.get(pdfName('CS').bytes)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(['I', 'K'].map(key => group.entries.get(pdfName(key).bytes))).toStrictEqual(['I', 'K'].map(key => original.entries.get(pdfName(key).bytes)));
  });

  it.each([
    { name: 'converts the group of a coloured d0 glyph', glyph: '1 0 d0 1 0 0 rg 0 0 1 1 re f', groups: 1, space: 'DeviceCMYK' },
    { name: 'leaves the group of an uncoloured d1 glyph', glyph: '1 0 0 0 1 1 d1 0 0 1 1 re f', groups: 0, space: 'DeviceRGB' },
  ])('$name in a Type 3 font', ({ glyph, groups, space }) => {
    const document = loadDocument(
      groupPagePdf({
        content: 'BT /F1 1 Tf (a) Tj ET',
        resources: '/Font<</F1 7 0 R>>',
        objects: [
          {
            number: 7,
            body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 8 0 R>>/Encoding<</Type/Encoding/Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]>>',
          },
          { number: 8, body: streamBody('/Group<</S/Transparency/CS/DeviceRGB>>', glyph) },
        ],
      }),
    );
    const report = convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect([report.groups, groupSpace(document, pdfReference(8, 0))]).toStrictEqual([groups, space]);
  });

  it.each([
    { name: 'a mask group given as a direct dictionary', config: { content: '1 0 0 rg', mask: '/G<</Subtype/Form>>' } },
    { name: 'a mask form without a Group', config: { content: '1 0 0 rg', group: '' } },
    { name: 'a two-component backdrop', config: { content: '1 0 0 rg', mask: '/G 6 0 R/BC[0 0]' } },
  ])('refuses a luminosity mask with $name', ({ config }) => {
    expect(outcome(loadDocument(maskPdf(config)))).toBe('ValidationError color-space');
  });

  it('leaves an absent luminosity backdrop absent', () => {
    const document = loadDocument(maskPdf({ content: '1 0 0 rg 0 0 10 10 re f' }));
    expect(outcome(document)).toBe('converted 1');
    expect([groupSpace(document, pdfReference(6, 0)), maskEntry(document, 'BC')]).toStrictEqual(['DeviceGray', undefined]);
  });

  it.each([
    {
      name: 'refuses an RGB alpha mask that draws a nested form',
      content: '/Fm Do',
      blendingSpace: 'cmyk',
      result: 'UnsupportedFeatureError',
    },
    {
      name: 'refuses an RGB alpha mask when blending changes are refused',
      content: '1 0 0 rg 0 0 10 10 re f',
      blendingSpace: 'refuse',
      result: 'ValidationError blend-space-change',
    },
    { name: 'converts an RGB alpha mask', content: '1 0 0 rg 0 0 10 10 re f', blendingSpace: 'cmyk', result: 'converted 1' },
  ] as const)('$name', ({ content, blendingSpace, result }) => {
    const document = loadDocument(
      maskPdf({
        content,
        subtype: 'Alpha',
        resources: '<</XObject<</Fm 7 0 R>>>>',
        objects: [{ number: 7, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '0 1 0 rg 0 0 10 10 re f') }],
      }),
    );
    expect(outcome(document, blendingSpace)).toBe(result);
  });

  it.each([
    { name: 'CMYK paint', content: '0 0 0 1 k 0 0 10 10 re f', result: 'UnsupportedFeatureError' },
    { name: 'a CMYK colour space', content: '/DeviceCMYK cs 0 0 0 1 sc 0 0 10 10 re f', result: 'UnsupportedFeatureError' },
    { name: 'an unbalanced Q', content: 'q 1 0 0 rg Q Q 0 0 10 10 re f', result: 'ValidationError color-operator' },
    { name: 'balanced q and Q', content: 'q 1 0 0 rg Q 0 0 10 10 re f', result: 'converted 1' },
  ])('converts a DeviceRGB luminosity group with $name only when it can be gray', ({ content, result }) => {
    expect(outcome(loadDocument(maskPdf({ content })))).toBe(result);
  });

  it.each([
    { name: 'an inverting Decode array', entries: '/BitsPerComponent 8/Decode[1 0 1 0 1 0]', data: [255, 255, 0], gray: [28], bits: 8 },
    { name: 'no Decode array', entries: '/BitsPerComponent 8', data: [255, 255, 0], gray: [227], bits: 8 },
    { name: '1-bit samples', entries: '/BitsPerComponent 1', data: [0b1010_0000], gray: [105], bits: 8 },
    { name: '16-bit samples', entries: '/BitsPerComponent 16', data: [0, 0, 255, 255, 0, 0], gray: [151, 10], bits: 16 },
  ])('converts a luminosity image with $name to gray', ({ entries, data, gray, bits }) => {
    const document = loadDocument(
      maskPdf({
        content: '/Im Do',
        resources: '<</XObject<</Im 9 0 R>>>>',
        objects: [
          { number: 9, body: streamBody(`/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB${entries}`, String.fromCodePoint(...data)) },
        ],
      }),
    );
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const image = maskImage(document);
    // ISO 32000-1:2008, 8.9.5.2: Decode maps each sample before the 0.3 R + 0.59 G + 0.11 B luminosity of 10.3.2.
    expect([image.color, [...image.data], imageEntry(document, image.reference, 'BitsPerComponent')]).toStrictEqual([
      pdfName('DeviceGray'),
      gray,
      { kind: 'integer', value: bits },
    ]);
  });

  it('refuses a luminosity image whose Decode array has the wrong length', () => {
    const document = loadDocument(
      maskPdf({
        content: '/Im Do',
        resources: '<</XObject<</Im 9 0 R>>>>',
        objects: [
          {
            number: 9,
            body: streamBody(
              '/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB/BitsPerComponent 8/Decode[0 1 0 1]',
              String.fromCodePoint(1, 2, 3),
            ),
          },
        ],
      }),
    );
    expect(outcome(document)).toBe('ValidationError color-space');
  });

  it.each([
    { name: 'converts a chain of seven nested forms under a nesting limit of 8', depth: 7, selfReference: false, result: 'converted 1' },
    { name: 'refuses a chain of eight nested forms under a nesting limit of 8', depth: 8, selfReference: false, result: 'ResourceLimitError' },
    { name: 'refuses a form that draws itself', depth: 1, selfReference: true, result: 'ResourceLimitError' },
  ])('$name', ({ depth, selfReference, result }) => {
    const forms = Array.from({ length: depth }, (_, index) => {
      const number = 10 + index;
      const next = selfReference ? number : number + 1;
      const last = index === depth - 1 && !selfReference;
      return {
        number,
        body: streamBody(
          `/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</XObject<</Fm ${String(next)} 0 R>>>>`,
          last ? '1 0 0 rg 0 0 1 1 re f' : '/Fm Do',
        ),
      };
    });
    const document = loadDocument(maskPdf({ content: '/Fm Do', resources: '<</XObject<</Fm 10 0 R>>>>', objects: forms }), { maxNesting: 8 });
    expect(outcome(document)).toBe(result);
  });

  it.each([
    {
      name: 'a PostScript XObject',
      content: '/Ps Do',
      objects: [{ number: 9, body: streamBody('/Type/XObject/Subtype/PS', '') }],
      result: 'UnsupportedFeatureError',
    },
    { name: 'a missing XObject', content: '/Missing Do', objects: [], result: 'ValidationError color-space' },
  ])('refuses a luminosity group that draws $name', ({ content, objects, result }) => {
    expect(outcome(loadDocument(maskPdf({ content, resources: '<</XObject<</Ps 9 0 R>>>>', objects })))).toBe(result);
  });

  it('leaves a DeviceGray inline image in a luminosity group unchanged', () => {
    const inline = `BI /W 1 /H 1 /BPC 8 /CS /G ID\n${String.fromCodePoint(128)}\nEI`;
    const document = loadDocument(maskPdf({ content: `1 0 0 rg ${inline}` }));
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(luminosityContent(document)).toBe(`0.3 g ${inline}`);
  });

  it.each([
    { name: 'converts an RGB inline image with a valid Flate checksum', data: latin1Text(flateRgb), filter: '/F /Fl ', result: 'converted 1' },
    {
      name: 'refuses an RGB inline image whose Flate checksum is wrong',
      data: latin1Text(corruptFlateRgb),
      filter: '/F /Fl ',
      result: 'ValidationError color-space',
    },
    { name: 'refuses an RGB inline image with too few samples', data: String.fromCodePoint(255, 0), filter: '', result: 'ValidationError color-space' },
  ])('$name in a luminosity group', ({ data, filter, result }) => {
    const document = loadDocument(maskPdf({ content: `BI /W 1 /H 1 /BPC 8 /CS /RGB ${filter}ID\n${data}\nEI` }));
    expect(outcome(document)).toBe(result);
  });

  it('refuses a CMYK inline image in a luminosity group', () => {
    const document = loadDocument(maskPdf({ content: `BI /W 1 /H 1 /BPC 8 /CS /CMYK ID\n${String.fromCodePoint(1, 2, 3, 4)}\nEI` }));
    expect(outcome(document)).toBe('UnsupportedFeatureError');
  });

  it.each([
    {
      name: 'converts an axial shading with one Function per RGB component',
      functions: '[10 0 R 11 0 R 12 0 R]',
      result: 'converted 1',
      ends: ['0.300', '0.110'],
    },
    { name: 'refuses an axial shading whose Function array has two entries', functions: '[10 0 R 12 0 R]', result: 'ValidationError color-space', ends: [] },
  ])('$name in a luminosity group', ({ functions, result, ends }) => {
    const document = loadDocument(
      maskPdf({
        content: '/Sh1 sh',
        resources: '<</Shading<</Sh1 9 0 R>>>>',
        objects: [
          { number: 9, body: `<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Function${functions}>>` },
          { number: 10, body: '<</FunctionType 2/Domain[0 1]/C0[1]/C1[0]/N 1>>' },
          { number: 11, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[0]/N 1>>' },
          { number: 12, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' },
        ],
      }),
    );
    const converted = outcome(document);
    const values = converted === 'converted 1' ? maskShadingValues(document) : undefined;
    const written = values === undefined ? [] : [values.start?.toFixed(3), values.end?.toFixed(3)];
    expect([converted, written]).toStrictEqual([result, ends]);
  });

  it('samples a function-based shading in a luminosity group on a 65 by 65 grid', () => {
    const document = loadDocument(
      maskPdf({
        content: '/Sh1 sh',
        resources: '<</Shading<</Sh1 9 0 R>>>>',
        objects: [
          { number: 9, body: '<</ShadingType 1/ColorSpace/DeviceRGB/Domain[0 1 0 1]/Function 10 0 R>>' },
          {
            number: 10,
            body: streamBody(
              '/FunctionType 0/Domain[0 1 0 1]/Range[0 1 0 1 0 1]/Size[2 2]/BitsPerSample 8',
              String.fromCodePoint(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255),
            ),
          },
        ],
      }),
    );
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const { root, evaluate } = maskFunction(document);
    const size = root.kind === 'stream' ? root.dictionary.get(pdfName('Size').bytes) : undefined;
    expect(size).toStrictEqual({ kind: 'array', items: [pdfInteger(65), pdfInteger(65)] });
    // ISO 32000-1:2008, 7.10.2: the first input varies fastest, so (1, 0) is red and (0, 1) green.
    expect(
      [
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(input => evaluate(input)[0]?.toFixed(3)),
    ).toStrictEqual(['0.300', '0.590', '0.110']);
  });

  it('converts the Background of a shading in a luminosity group to gray', () => {
    const document = loadDocument(
      maskPdf({
        content: '/Sh1 sh',
        resources: '<</Shading<</Sh1 9 0 R>>>>',
        objects: [
          { number: 9, body: '<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 10 0]/Background[0 1 0]/Function 10 0 R>>' },
          { number: 10, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
        ],
      }),
    );
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    const shading = maskShading(document);
    const background = shading.kind === 'dictionary' ? shading.entries.get(pdfName('Background').bytes) : undefined;
    expect(
      background?.kind === 'array' ? background.items.map(item => (item.kind === 'real' && typeof item.value === 'number' ? item.value.toFixed(3) : '')) : [],
    ).toStrictEqual(['0.590']);
  });

  it.each([
    { type: 5, entries: '/VerticesPerRow 2', layout: { flagBits: 0, points: 1, colors: 1 } },
    { type: 6, entries: '/BitsPerFlag 2', layout: { flagBits: 2, points: 12, colors: 4 } },
    { type: 7, entries: '/BitsPerFlag 2', layout: { flagBits: 2, points: 16, colors: 4 } },
  ] as const)('converts the colours of a Type $type mesh in a luminosity group to gray', ({ type, entries, layout }) => {
    const writer = new MeshBitWriter();
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ];
    if (type === 5) {
      for (const [index, color] of colors.entries()) {
        writer.write(8, (index % 2) * 10);
        writer.write(8, Math.floor(index / 2) * 10);
        for (const value of color) {
          writer.write(8, value);
        }
      }
    } else {
      writer.write(2, 0);
      for (let point = 0; point < layout.points * 2; point++) {
        writer.write(8, point);
      }
      for (const value of colors.flat()) {
        writer.write(8, value);
      }
      writer.alignByte();
    }
    const document = loadDocument(
      maskPdf({
        content: '/Sh1 sh',
        resources: '<</Shading<</Sh1 9 0 R>>>>',
        objects: [
          {
            number: 9,
            body: streamBody(
              `/ShadingType ${String(type)}/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8${entries}/Decode[0 10 0 10 0 1 0 1 0 1]`,
              latin1Text(writer.finish(1024)),
            ),
          },
        ],
      }),
    );
    convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(meshGrays(meshShadingData(document), layout)).toStrictEqual([77, 150, 28, 255]);
  });
});

describe('properties', () => {
  const rgb = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 });

  // ISO 32000-1:2008, 10.3.2: the DeviceRGB to DeviceGray weights are fixed and sum to 1, so gray stays gray and the mapping is linear.
  it('maps a neutral RGB colour to the same gray', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), value => {
        expect(deviceRgbLuminosity([value, value, value])).toBeCloseTo(value, 12);
      }),
    );
  });

  it('maps the mean of two RGB colours to the mean of their grays', () => {
    fc.assert(
      fc.property(rgb, rgb, (first, second) => {
        const mean = first.map((value, index) => (value + (second[index] ?? 0)) / 2);
        expect(deviceRgbLuminosity(mean)).toBeCloseTo((deviceRgbLuminosity(first) + deviceRgbLuminosity(second)) / 2, 12);
      }),
    );
  });
});

import type { PdfObject } from '../object/pdfObject.ts';
import type { SavedPdf, StreamedSavedPdf } from '../write/savedPdf.ts';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runTool } from '../../../../scripts/readerOracle.ts';
import { createColorTransform } from '../color/createColorTransform.ts';
import { compareDocuments } from '../compare/compareDocuments.ts';
import { pdfDate } from '../date/pdfDate.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { decodeJpeg } from '../jpeg/decodeJpeg.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertImages } from './convertImages.ts';
import { convertToCmyk } from './convertToCmyk.ts';
import { jpxHasRgbColor } from './jpxColor.ts';
import { rewritePageColors } from './rewritePage.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const displayP3 = parseIccProfile(await fixture('DisplayP3-v4.icc'));
const pixels = Uint8Array.of(0, 0, 0, 255, 128, 64);

const jpegFixture = async (): Promise<Uint8Array> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-jpeg-'));
  try {
    const input = path.join(directory, 'input.ppm');
    const output = path.join(directory, 'output.jpg');
    await writeFile(input, Uint8Array.of(...new TextEncoder().encode('P6\n2 1\n255\n'), ...pixels));
    const generated = await runTool('magick', [input, '-sampling-factor', '1x1,1x1,1x1', '-quality', '90', output]);
    if (generated.code !== 0) throw new Error(generated.output);
    return Uint8Array.from(await readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const jpegSegment = (marker: number, payload: readonly number[]): number[] => [
  255,
  marker,
  Math.floor((payload.length + 2) / 256),
  (payload.length + 2) % 256,
  ...payload,
];

const largeZeroJpeg = (): Uint8Array => {
  const huffman = (selector: number): number[] => jpegSegment(0xc4, [selector, 1, ...Array.from({ length: 15 }, () => 0), 0]);
  const entropy = new Uint8Array(49_152);
  return Uint8Array.from([
    255,
    0xd8,
    ...jpegSegment(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...huffman(0),
    ...huffman(0x10),
    ...jpegSegment(0xc0, [8, 4, 0, 32, 0, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...jpegSegment(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]),
    ...entropy,
    255,
    0xd9,
  ]);
};

const streamed = (saved: SavedPdf): StreamedSavedPdf => {
  if (saved.kind !== 'streamed') throw new Error('expected a streamed save');
  return saved;
};

const qpdfCheck = async (chunks: readonly Uint8Array[]): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-image-'));
  try {
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const file = path.join(directory, 'converted.pdf');
    await writeFile(file, bytes);
    const check = await runTool('qpdf', ['--check', file]);
    expect(check.code).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

interface ImagePdfOptions {
  readonly width?: number;
  readonly height?: number;
  readonly bits?: number;
  readonly colorSpace?: string;
  readonly decode?: string;
  readonly mask?: string;
  readonly decodeParms?: string;
  readonly intent?: string;
  readonly pageContent?: string;
}

const twoImages = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Im Do') },
      { number: 5, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/DCTDecode', 'jpeg') },
      { number: 6, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 7 0 R/Resources<</XObject<</Im 8 0 R>>>>>>' },
      { number: 7, body: streamBody('', '/Im Do') },
      { number: 8, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/DCTDecode', 'jpeg') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const imageDictionary = (filter: string, options?: ImagePdfOptions): string => {
  const colorSpace = options?.colorSpace === '' ? '' : `/ColorSpace${options?.colorSpace ?? '/DeviceRGB'}`;
  return `/Type/XObject/Subtype/Image/Width ${String(options?.width ?? 2)}/Height ${String(options?.height ?? 1)}/BitsPerComponent ${String(options?.bits ?? 8)}${colorSpace}/Filter/${filter}${options?.decode ?? ''}${options?.mask ?? ''}${options?.decodeParms ?? ''}${options?.intent ?? ''}`;
};

const imagePdf = (filter: string, data: Uint8Array, options?: ImagePdfOptions): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
        { number: 4, body: streamBody('', options?.pageContent ?? '/Im Do') },
        {
          number: 5,
          body: streamBody(imageDictionary(filter, options), latin1Text(data)),
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

const jp2Color = (enumeration: number): Uint8Array =>
  Uint8Array.of(
    0,
    0,
    0,
    12,
    0x6a,
    0x50,
    0x20,
    0x20,
    0x0d,
    0x0a,
    0x87,
    0x0a,
    0,
    0,
    0,
    23,
    0x6a,
    0x70,
    0x32,
    0x68,
    0,
    0,
    0,
    15,
    0x63,
    0x6f,
    0x6c,
    0x72,
    1,
    0,
    0,
    0,
    0,
    0,
    enumeration,
  );

const be32 = (value: number): number[] => [Math.floor(value / 16777216) % 256, Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
const joined = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};
const jp2Box = (name: string, payload: Uint8Array): Uint8Array => {
  const nameBytes = Array.from({ length: name.length }, (_, index) => name.codePointAt(index) ?? 0);
  return joined([Uint8Array.of(...be32(payload.length + 8), ...nameBytes), payload]);
};
const jp2Icc = (profile: Uint8Array): Uint8Array => {
  const signature = jp2Color(16).subarray(0, 12);
  const colr = jp2Box('colr', joined([Uint8Array.of(2, 0, 0), profile]));
  const header = jp2Box('jp2h', colr);
  return joined([signature, header]);
};

const imageStream = (value: PdfObject): Extract<PdfObject, { kind: 'stream' }> => {
  if (value.kind !== 'stream') throw new Error('image is missing');
  return value;
};

const dictionaryValue = (value: PdfObject): Extract<PdfObject, { kind: 'dictionary' }> => {
  if (value.kind !== 'dictionary') throw new Error('expected dictionary');
  return value;
};

const imageColorFamily = (document: ReturnType<typeof loadDocument>, number: number): string => {
  const image = imageStream(document.get(pdfReference(number, 0)));
  const colorSpace = image.dictionary.get(pdfName('ColorSpace').bytes);
  if (colorSpace?.kind !== 'array' || colorSpace.items[0]?.kind !== 'name') throw new Error('image has no array colour space');
  return new TextDecoder('latin1').decode(colorSpace.items[0].bytes);
};

const embeddedProfile = (document: ReturnType<typeof loadDocument>, imageNumber: number): Uint8Array => {
  const image = imageStream(document.get(pdfReference(imageNumber, 0)));
  const space = image.dictionary.get(pdfName('ColorSpace').bytes);
  if (space?.kind !== 'array') throw new Error('image is not ICCBased');
  const [, reference] = space.items;
  if (reference?.kind !== 'reference') throw new Error('ICC profile is missing');
  return imageStream(document.get(reference)).data;
};

const imageData = (document: ReturnType<typeof loadDocument>): Uint8Array => {
  const image = imageStream(document.get(pdfReference(5, 0)));
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('image is missing');
  const data = decodedData(internals, image);
  if (typeof data === 'string') throw new Error(data);
  return data;
};

const namedImage = (document: ReturnType<typeof loadDocument>, name: string): Extract<PdfObject, { kind: 'stream' }> => {
  const xobjects = document.page(0).resources().get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') throw new Error('page XObjects are missing');
  const reference = xobjects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') throw new Error('inline image XObject is missing');
  return imageStream(document.get(reference));
};

const stencilData = (document: ReturnType<typeof loadDocument>): Uint8Array => {
  const image = imageStream(document.get(pdfReference(5, 0)));
  const mask = image.dictionary.get(pdfName('Mask').bytes);
  if (mask?.kind !== 'reference') throw new Error('missing explicit mask');
  const stencil = imageStream(document.get(mask));
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('missing document internals');
  const data = decodedData(internals, stencil);
  if (typeof data === 'string') throw new Error(data);
  return data;
};

describe('image colour conversion', () => {
  it('converts Flate RGB samples by row and writes CMYK samples', () => {
    const document = loadDocument(imagePdf('FlateDecode', deflateZlib(pixels)));
    const report = convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(pixels, expected, 2);
    const image = imageStream(document.get(pdfReference(5, 0)));
    expect(report.converted).toBe(1);
    expect(image.dictionary.get(pdfName('ColorSpace').bytes)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(imageData(document)).toStrictEqual(expected);
  });

  it('rejects an image whose decoded data is shorter than its dimensions', () => {
    const compressed = deflateZlib(new Uint8Array());
    const document = loadDocument(imagePdf('FlateDecode', compressed, { width: 10_000, height: 10_000 }));
    expect(() => {
      convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    }).toThrow(ValidationError);
    expect(document.save().mode).toBe('incremental');
  });

  it('streams converted image data above the former in-memory ceiling', async () => {
    const compressed = deflateZlib(new Uint8Array(1024 * 1024 * 3));
    const document = loadDocument(imagePdf('FlateDecode', compressed, { width: 1024, height: 1024 }));
    expect(convertImages(document, { sourceRgbProfile: source, outputProfile: destination }).converted).toBe(1);
    const saved = streamed(document.save());
    const chunks: Uint8Array[] = [];
    for await (const chunk of saved.toStream()) chunks.push(chunk);
    expect(saved.measureByteLength()).toBe(chunks.reduce((total, chunk) => total + chunk.length, 0));
    const reloaded = loadDocument(chunks);
    await qpdfCheck(chunks);
    expect(imageData(reloaded)).toHaveLength(1024 * 1024 * 4);
    expect(compareDocuments(document, reloaded, { include: ['resources'] }).differences).toStrictEqual([]);
    const image = imageStream(reloaded.get(pdfReference(5, 0)));
    expect(image.dictionary.get(pdfName('Length').bytes)?.kind).toBe('reference');
  });

  it('uses image Intent unless the caller fixes the conversion intent', () => {
    const compressed = deflateZlib(pixels);
    const relative = loadDocument(imagePdf('FlateDecode', compressed));
    const perceptual = loadDocument(imagePdf('FlateDecode', compressed, { intent: '/Intent/Perceptual' }));
    const overridden = loadDocument(imagePdf('FlateDecode', compressed, { intent: '/Intent/Perceptual' }));
    convertImages(relative, { sourceRgbProfile: source, outputProfile: destination });
    convertImages(perceptual, { sourceRgbProfile: source, outputProfile: destination });
    convertImages(overridden, { sourceRgbProfile: source, outputProfile: destination, intent: 'relativeColorimetric' });
    expect(imageData(perceptual)).not.toStrictEqual(imageData(relative));
    expect(imageData(overridden)).toStrictEqual(imageData(relative));
  });

  it('uses the current page rendering intent when an image has no Intent', () => {
    const compressed = deflateZlib(pixels);
    const fromPage = loadDocument(imagePdf('FlateDecode', compressed, { pageContent: '/Perceptual ri /Im Do' }));
    const fromImage = loadDocument(imagePdf('FlateDecode', compressed, { intent: '/Intent/Perceptual' }));
    convertImages(fromPage, { sourceRgbProfile: source, outputProfile: destination });
    convertImages(fromImage, { sourceRgbProfile: source, outputProfile: destination });
    expect(imageData(fromPage)).toStrictEqual(imageData(fromImage));
  });

  it('keeps a DCT image encoded and tags DeviceRGB with the caller profile', () => {
    const encoded = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    const document = loadDocument(imagePdf('DCTDecode', encoded));
    const report = convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const image = imageStream(document.get(pdfReference(5, 0)));
    expect(report.keptRgbImages).toHaveLength(1);
    expect(report.keptRgbImages[0]?.tagged).toBe('added');
    expect(image.data).toStrictEqual(encoded);
    expect(image.dictionary.get(pdfName('ColorSpace').bytes)?.kind).toBe('array');
  });

  it('embeds each distinct RGB source profile for kept DCT images', () => {
    const document = loadDocument(twoImages.bytes);
    const profile = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('N').bytes, pdfInteger(3)]]), data: displayP3.bytes });
    const page = dictionaryValue(document.get(document.page(1).reference));
    const resources = document.page(1).resources();
    const colors = new PdfDictionaryEntries([[pdfName('DefaultRGB').bytes, pdfArray([pdfName('ICCBased'), profile])]]);
    resources.set(pdfName('ColorSpace').bytes, pdfDictionary(colors));
    page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
    document.set(document.page(1).reference, page);
    const report = convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const identities = [embeddedProfile(document, 5), embeddedProfile(document, 8)].map(bytes => parseIccProfile(bytes).identity);
    expect(report.keptRgbImages).toHaveLength(2);
    expect(identities).toStrictEqual([source.identity, displayP3.identity]);
  });

  it('makes a CalRGB DefaultRGB explicit on a kept DCT image', () => {
    const document = loadDocument(imagePdf('DCTDecode', Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)));
    const page = dictionaryValue(document.get(document.page(0).reference));
    const white = pdfArray([pdfReal(0.9505), pdfInteger(1), pdfReal(1.089)]);
    const parameters = new PdfDictionaryEntries([[pdfName('WhitePoint').bytes, white]]);
    const calibrated = pdfArray([pdfName('CalRGB'), pdfDictionary(parameters)]);
    const colors = new PdfDictionaryEntries([[pdfName('DefaultRGB').bytes, calibrated]]);
    const resources = document.page(0).resources();
    resources.set(pdfName('ColorSpace').bytes, pdfDictionary(colors));
    page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
    document.set(document.page(0).reference, page);
    convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(imageColorFamily(document, 5)).toBe('CalRGB');
  });

  it.each([
    { bits: 1, packed: Uint8Array.of(0xa0), rgb: [1, 0, 1] },
    { bits: 2, packed: Uint8Array.of(0x2c), rgb: [0, 2 / 3, 1] },
    { bits: 4, packed: Uint8Array.of(0x08, 0xf0), rgb: [0, 8 / 15, 1] },
  ])('unpacks $bits-bit RGB samples into one CMYK pixel', ({ bits, packed, rgb }) => {
    const document = loadDocument(imagePdf('FlateDecode', deflateZlib(packed), { width: 1, bits }));
    convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Float64Array(4);
    transform.convert(Float64Array.from(rgb), expected);
    expect(imageData(document)).toStrictEqual(Uint8Array.from(expected, value => Math.round(value * 255)));
  });

  it('applies an image Decode array before converting samples', () => {
    const raw = Uint8Array.of(0, 128, 255);
    const document = loadDocument(imagePdf('FlateDecode', deflateZlib(raw), { width: 1, decode: '/Decode[1 0 0 1 0 1]' }));
    convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Float64Array(4);
    transform.convert(Float64Array.of(1, 128 / 255, 1), expected);
    expect(imageData(document)).toStrictEqual(Uint8Array.from(expected, value => Math.round(value * 255)));
  });

  it('keeps 16-bit output samples in network byte order', () => {
    const raw = Uint8Array.of(0x80, 0x00, 0x40, 0x00, 0xff, 0xff);
    const document = loadDocument(imagePdf('FlateDecode', deflateZlib(raw), { width: 1, bits: 16 }));
    convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint16Array(4);
    transform.convertRow16(Uint16Array.of(0x8000, 0x4000, 0xffff), expected, 1);
    const bytes = Uint8Array.from([...expected].flatMap(value => [Math.floor(value / 256), value % 256]));
    expect(imageData(document)).toStrictEqual(bytes);
  });

  it('replaces an RGB colour-key mask with an explicit stencil', () => {
    const document = loadDocument(imagePdf('FlateDecode', deflateZlib(pixels), { mask: '/Mask[0 0 0 0 0 0]' }));
    convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(stencilData(document)).toStrictEqual(Uint8Array.of(0b10000000));
  });

  it('uses the parser predictor before converting a Flate image', () => {
    const predicted = Uint8Array.of(0, ...pixels);
    const parameters = '/DecodeParms<</Predictor 15/Colors 3/BitsPerComponent 8/Columns 2>>';
    const document = loadDocument(imagePdf('FlateDecode', deflateZlib(predicted), { decodeParms: parameters }));
    convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(pixels, expected, 2);
    expect(imageData(document)).toStrictEqual(expected);
  });

  it('converts CalGray image samples without applying K-only substitution', () => {
    const colorSpace = '[/CalGray<</WhitePoint[0.9505 1 1.089]/Gamma 2.2>>]';
    const compressed = deflateZlib(Uint8Array.of(0));
    const document = loadDocument(imagePdf('FlateDecode', compressed, { width: 1, colorSpace }));
    const report = convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.converted).toBe(1);
    expect(imageData(document)).not.toStrictEqual(Uint8Array.of(0, 0, 0, 255));
  });

  it('refuses compressed RGB images when requested', () => {
    const document = loadDocument(imagePdf('DCTDecode', Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)));
    expect(() => {
      convertImages(document, { sourceRgbProfile: source, outputProfile: destination, compressedRgbImages: 'refuse' });
    }).toThrow(expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'compressed-rgb-image' }));
  });

  it('transcodes a generated DCT RGB image to streamed Flate CMYK with PDF/X metadata', async () => {
    const jpeg = await jpegFixture();
    const document = loadDocument(imagePdf('DCTDecode', jpeg));
    const report = convertToCmyk(document, {
      sourceRgbProfile: source.bytes,
      outputProfile: destination.bytes,
      outputIntent: { outputConditionIdentifier: 'FOGRA28' },
      pdfx: {
        trapped: 'False',
        documentId: 'uuid:6a769151-c839-4e89-9252-371ad5926a53',
        metadataDate: pdfDate({ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }),
      },
      compressedRgbImages: 'transcode',
    });
    expect([report.images.converted, report.images.keptRgbImages.length]).toStrictEqual([1, 0]);
    const saved = streamed(document.save());
    const chunks: Uint8Array[] = [];
    for await (const chunk of saved.toStream()) chunks.push(chunk);
    await qpdfCheck(chunks);
    const reloaded = loadDocument(chunks);
    const image = imageStream(reloaded.get(pdfReference(5, 0)));
    expect(image.dictionary.get(pdfName('Filter').bytes)).toStrictEqual(pdfName('FlateDecode'));
    expect(image.dictionary.get(pdfName('ColorSpace').bytes)).toStrictEqual(pdfName('DeviceCMYK'));
    const rgb = joined([...decodeJpeg(jpeg).rows()]);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(rgb, expected, 2);
    expect(imageData(reloaded)).toStrictEqual(expected);
  });

  it('moves a transcoded inline JPEG into a streamed Flate image XObject', async () => {
    const jpeg = await jpegFixture();
    const document = loadDocument(imagePdf('FlateDecode', deflateZlib(pixels)));
    const content = joined([new TextEncoder().encode('BI /W 2 /H 1 /BPC 8 /CS /RGB /F /DCT ID\n'), jpeg, new TextEncoder().encode('\nEI')]);
    document.replaceStreamData(pdfReference(4, 0), content, { filter: 'FlateDecode' });
    expect(rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination, compressedRgbImages: 'transcode' }).inlineImages).toBe(1);
    const saved = streamed(document.save());
    const chunks: Uint8Array[] = [];
    for await (const chunk of saved.toStream()) chunks.push(chunk);
    await qpdfCheck(chunks);
    const image = namedImage(loadDocument(chunks), 'PWIM0');
    expect(image.dictionary.get(pdfName('ColorSpace').bytes)).toStrictEqual(pdfName('DeviceCMYK'));
    expect(image.dictionary.get(pdfName('Filter').bytes)).toStrictEqual(pdfName('FlateDecode'));
  });

  it('limits total decoded JPEG bytes in XObject and inline transcode', () => {
    const jpeg = largeZeroJpeg();
    expect(jpeg).toHaveLength(49_302);
    expect(() => decodeJpeg(jpeg, { maxDecodedBytes: 1_048_576 })).toThrow(ResourceLimitError);
    const xobject = loadDocument(imagePdf('DCTDecode', jpeg, { width: 8192, height: 1024 }), { maxDecodedBytes: 1_048_576 });
    expect(() => convertImages(xobject, { sourceRgbProfile: source, outputProfile: destination, compressedRgbImages: 'transcode' })).toThrow(
      ResourceLimitError,
    );

    const inline = loadDocument(imagePdf('FlateDecode', deflateZlib(pixels)), { maxDecodedBytes: 1_048_576 });
    const content = joined([new TextEncoder().encode('BI /W 8192 /H 1024 /BPC 8 /CS /RGB /F /DCT ID\n'), jpeg, new TextEncoder().encode('\nEI')]);
    inline.replaceStreamData(pdfReference(4, 0), content, { filter: 'FlateDecode' });
    expect(() => rewritePageColors(inline, { sourceRgbProfile: source, outputProfile: destination, compressedRgbImages: 'transcode' })).toThrow(
      ResourceLimitError,
    );
  });

  it('honours DCT DecodeParms ColorTransform without Adobe APP14', async () => {
    const jpeg = await jpegFixture();
    const document = loadDocument(imagePdf('DCTDecode', jpeg, { decodeParms: '/DecodeParms<</ColorTransform 0>>' }));
    expect(decodeJpeg(jpeg).adobeColorTransform).toBeUndefined();
    convertImages(document, { sourceRgbProfile: source, outputProfile: destination, compressedRgbImages: 'transcode' });
    const rows = joined([...decodeJpeg(jpeg, { colorTransform: 0 }).rows()]);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(rows, expected, 2);
    expect(imageData(document)).toStrictEqual(expected);
  });

  it('refuses JPEG 2000 under the transcode policy', () => {
    const document = loadDocument(imagePdf('JPXDecode', jp2Color(16), { colorSpace: '' }));
    expect(() => {
      convertImages(document, { sourceRgbProfile: source, outputProfile: destination, compressedRgbImages: 'transcode' });
    }).toThrow(expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'compressed-rgb-image' }));
  });

  it('keeps a JPX image whose JP2 colr box names sRGB', () => {
    const encoded = jp2Color(16);
    const document = loadDocument(imagePdf('JPXDecode', encoded, { colorSpace: '' }));
    const report = convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    const image = imageStream(document.get(pdfReference(5, 0)));
    expect(report.keptRgbImages).toHaveLength(1);
    expect(report.keptRgbImages[0]?.tagged).toBe('jpx-colr');
    expect(image.data).toStrictEqual(encoded);
    expect(image.dictionary.get(pdfName('ColorSpace').bytes)).toBeUndefined();
  });

  it('refuses an untagged JPX image with a gray colr box', () => {
    const document = loadDocument(imagePdf('JPXDecode', jp2Color(17), { colorSpace: '' }));
    expect(() => {
      convertImages(document, { sourceRgbProfile: source, outputProfile: destination });
    }).toThrow(expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'jpx-color-space' }));
  });

  it('classifies only RGB ICC profiles in a JP2 colr box', () => {
    expect([jpxHasRgbColor(jp2Icc(source.bytes), 16 * 1024 * 1024), jpxHasRgbColor(jp2Icc(destination.bytes), 16 * 1024 * 1024)]).toStrictEqual([true, false]);
  });

  it('treats an unsupported embedded ICC profile as unclassifiable', () => {
    const unsupported = Uint8Array.from(source.bytes);
    unsupported[8] = 5;
    expect([jpxHasRgbColor(jp2Icc(unsupported), 16 * 1024 * 1024)]).toStrictEqual([false]);
  });
});

import type { ColorSource } from '../color/createColorTransform.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';

import { readFile } from 'node:fs/promises';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { magick } from '../../../../scripts/readerOracle.ts';
import { createColorTransform } from '../color/createColorTransform.ts';
import { readContent } from '../content/contentOperations.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { DEFAULT_FRACTION_DIGITS, formatNumber } from '../number/formatNumber.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { gammaCurveTag, iccProfileBytes } from '../testing/iccProfileBytes.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { rewriteContentColors } from './rewriteContent.ts';
import { rewritePageColors } from './rewritePage.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const content =
  '% preserve this comment\n0 0 0 rg 0 0 10 10 re f\n0.2 0.3 0.4 rg 20 0 10 10 re f\n0.7 g 40 0 10 10 re f\n/CS1 cs 0.5 sc 60 0 10 10 re f\n/CS2 cs 0.5 sc 80 0 10 10 re f\n';
const calGray: ColorSource = { kind: 'calGray', whitePoint: { x: 0.9505, y: 1, z: 1.089 }, gamma: 2.2 };
const srgb: ColorSource = { kind: 'icc', profile: source };
const grayIcc = parseIccProfile(iccProfileBytes({ profileClass: 'mntr', colorSpace: 'GRAY', pcs: 'XYZ ', tags: [['kTRC', gammaCurveTag(1.8)]] }));

// The converted operands as the rewriter writes them: the transform's output at the default five fraction digits.
const operands = (
  from: ColorSource,
  values: ReadonlyArray<number>,
  transform: { readonly intent?: RenderingIntent; readonly blackPointCompensation?: boolean } = {},
): string => {
  const output = new Float64Array(4);
  createColorTransform(from, destination, {
    intent: transform.intent ?? 'relativeColorimetric',
    blackPointCompensation: transform.blackPointCompensation ?? true,
  }).convert(Float64Array.from(values), output);
  return [...output].map(value => formatNumber(value, DEFAULT_FRACTION_DIGITS)).join(' ');
};

const rgbRow = (rgb: ReadonlyArray<number>): Uint8Array => {
  const output = new Uint8Array((rgb.length / 3) * 4);
  createColorTransform(srgb, destination, { intent: 'relativeColorimetric', blackPointCompensation: true }).convertRow8(
    Uint8Array.from(rgb),
    output,
    rgb.length / 3,
  );
  return output;
};

const pdf = (pieceInfo = false): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1[/CalGray<</WhitePoint[0.9505 1 1.089]/Gamma 2.2>>]/CS2[/Separation /#82b#82t#82s /DeviceCMYK<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 0 0 1]/N 1>>]>>>>${pieceInfo ? '/PieceInfo<</App<<>>>>' : ''}>>`,
        },
        { number: 4, body: streamBody('', content) },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

const overprintPdf = (): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources 8 0 R>>' },
        { number: 4, body: streamBody('', '/GS gs 0 0 0 RG 0 0 m 10 10 l S') },
        { number: 8, body: '<</ExtGState<</GS<</OP true/OPM 1>>>>>>' },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

const sharedOverprintPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources 8 0 R>>' },
      { number: 4, body: streamBody('', '/GS gs 0 0 0 RG 0 0 m 10 10 l S') },
      { number: 5, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 6 0 R/Resources 8 0 R>>' },
      { number: 6, body: streamBody('', '/GS gs 0 0 0 RG 0 0 m 10 10 l S') },
      { number: 8, body: '<</ExtGState<</GS<</OP true/OPM 1>>>>>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const pageText = (document: ReturnType<typeof loadDocument>): string => {
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('missing internals');
  }
  const page = document.get(document.page(0).reference);
  if (page.kind !== 'dictionary') {
    throw new Error('missing page');
  }
  const stream = internals.objects.deref(page.entries.get(pdfName('Contents').bytes));
  if (stream?.kind !== 'stream') {
    throw new Error('missing content stream');
  }
  const data = decodedData(internals, stream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return latin1Text(data);
};

const namedImage = (document: ReturnType<typeof loadDocument>, name: string): Extract<PdfObject, { kind: 'stream' }> => {
  const xobjects = document.page(0).resources().get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') {
    throw new Error('missing XObjects');
  }
  const reference = xobjects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('missing image');
  }
  const image = document.get(reference);
  if (image.kind !== 'stream') {
    throw new Error('missing image stream');
  }
  return image;
};

const spotName = (document: ReturnType<typeof loadDocument>): Uint8Array => {
  const resources = document.page(0).resources();
  const spaces = resources.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('missing ColorSpace');
  }
  const separation = spaces.entries.get(pdfName('CS2').bytes);
  if (separation?.kind !== 'array') {
    throw new Error('missing Separation');
  }
  const [, name] = separation.items;
  if (name?.kind !== 'name') {
    throw new Error('missing colorant name');
  }
  return name.bytes;
};

const addedOverprintStates = (document: ReturnType<typeof loadDocument>): ReadonlyArray<boolean> => {
  const resources = document.page(0).resources();
  const states = resources.get(pdfName('ExtGState').bytes);
  if (states?.kind !== 'dictionary') {
    throw new Error('missing ExtGState');
  }
  return [states.entries.has(pdfName('PWOPM0').bytes), states.entries.has(pdfName('PWOPM1').bytes)];
};

const inlineData = (bytes: Uint8Array): Uint8Array => {
  const [operation] = readContent(bytes, 32);
  const data = operation?.inlineImage?.data;
  if (data === undefined) {
    throw new Error('converted inline image is missing');
  }
  return data;
};

/** The converted inline image as a reader sees it: the operators the content holds, the warnings its own filters raise and the samples they decode to. */
const readInline = (bytes: Uint8Array) => {
  const operations = [...readContent(bytes, 32)];
  const image = operations[0]?.inlineImage;
  if (image === undefined) {
    throw new Error('converted inline image is missing');
  }
  const dictionary = new PdfDictionaryEntries();
  for (let index = 0; index + 1 < image.parameters.length; index += 2) {
    const key = image.parameters[index];
    const value = image.parameters[index + 1];
    if (key?.kind === 'name' && value !== undefined && value.kind !== 'stray-delimiter') {
      const name = latin1Text(key.bytes);
      if (name === 'F' || name === 'DP') {
        dictionary.set(pdfName(name === 'F' ? 'Filter' : 'DecodeParms').bytes, value);
      }
    }
  }
  const warnings: Array<string> = [];
  const samples = decodeStream({ kind: 'stream', dictionary, data: image.data }, { maxDecodedBytes: 1_048_576, warn: warning => warnings.push(warning.code) });
  return { operators: operations.map(operation => operation.operator), warnings, samples };
};

const inlineIndexedLookup = (bytes: Uint8Array): Uint8Array => {
  const [operation] = readContent(bytes, 32);
  const parameters = operation?.inlineImage?.parameters;
  if (parameters === undefined) {
    throw new Error('inline image is missing');
  }
  const index = parameters.findIndex(value => value.kind === 'name' && new TextDecoder('latin1').decode(value.bytes) === 'CS');
  const color = parameters[index + 1];
  if (color?.kind !== 'array') {
    throw new Error('Indexed inline colour space is missing');
  }
  const lookup = color.items.at(3);
  if (lookup?.kind !== 'string') {
    throw new Error('Indexed inline lookup is missing');
  }
  return lookup.bytes;
};

const xObjectData = (document: ReturnType<typeof loadDocument>, name: string): Uint8Array => {
  const resources = document.page(0).resources();
  const objects = resources.get(pdfName('XObject').bytes);
  if (objects?.kind !== 'dictionary') {
    throw new Error('XObject resources are missing');
  }
  const reference = objects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('image reference is missing');
  }
  const stream = document.get(reference);
  const internals = internalsOf(document);
  if (stream.kind !== 'stream' || internals === undefined) {
    throw new Error('image stream is missing');
  }
  const data = decodedData(internals, stream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return data;
};

const dictionaryValue = (value: PdfObject): Extract<PdfObject, { kind: 'dictionary' }> => {
  if (value.kind !== 'dictionary') {
    throw new Error('page is missing');
  }
  return value;
};

const entriesOf = (value: PdfObject | undefined): PdfDictionaryEntries => {
  if (value?.kind === 'dictionary') {
    return value.entries;
  }
  if (value?.kind === 'stream') {
    return value.dictionary;
  }
  throw new Error('expected a dictionary');
};

const named = (entries: PdfDictionaryEntries): ReadonlyArray<readonly [string, PdfObject]> =>
  [...entries.entries()].map(([key, value]) => [latin1Text(key), value] as const);

const opm = (value: number): PdfDirectObject => pdfDictionary(new PdfDictionaryEntries([[pdfName('OPM').bytes, pdfInteger(value)]]));
const overprintState = (entries: ReadonlyArray<readonly [string, PdfDirectObject]>): PdfDirectObject =>
  pdfDictionary(new PdfDictionaryEntries(entries.map(([key, value]) => [pdfName(key).bytes, value] as const)));

// Rewrites `text` against page 3 of `pdf()`, with `resources` written in PDF syntax merged over the page's own.
const rewrite = (text: string | Uint8Array, options: Partial<RewriteColorOptions> = {}, resources?: string, maxDecodedBytes?: number) => {
  const document = loadDocument(
    resources === undefined
      ? pdf()
      : buildPdf([
          {
            xref: 'classic',
            objects: [
              { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
              { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
              { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources${resources}>>` },
              { number: 4, body: streamBody('', '') },
              { number: 9, body: streamBody('/N 1', latin1Text(grayIcc.bytes)) },
            ],
            trailer: '/Root 1 0 R',
          },
        ]).bytes,
    maxDecodedBytes === undefined ? {} : { maxDecodedBytes },
  );
  return rewriteContentColors(document, typeof text === 'string' ? latin1Bytes(text) : text, {
    resources: document.page(0).resources(),
    options: { sourceRgbProfile: source, outputProfile: destination, ...options },
    overprintNames: { off: 'PW0', on: 'PW1' },
  });
};

const inlineParameters = (bytes: Uint8Array): string => {
  const text = latin1Text(bytes);
  return text.slice(0, text.indexOf(' ID\n'));
};

const tenWide = (rows: number): string => `BI /W 10 /H ${String(rows)} /BPC 8 /CS /RGB ID\n${'\0'.repeat(30 * rows)}\nEI`;
const kibiWide = (rows: number): Uint8Array =>
  Uint8Array.from([...latin1Bytes(`BI /W 1024 /H ${String(rows)} /BPC 8 /CS /RGB ID\n`), ...new Uint8Array(3072 * rows), ...latin1Bytes('\nEI')]);

const OVERPRINT = '<</ExtGState<</GS<</OP true/OPM 1>>>>>>';

const jpegFixture = async (): Promise<Uint8Array> =>
  magick(
    ['ppm:-', '-sampling-factor', '1x1,1x1,1x1', '-quality', '90', 'jpeg:-'],
    Uint8Array.of(...new TextEncoder().encode('P6\n2 1\n255\n'), 0, 0, 0, 255, 128, 64),
  );

const inlineJpeg = (jpeg: Uint8Array, parameters: string): Uint8Array =>
  Uint8Array.from([...latin1Bytes(`BI ${parameters} ID\n`), ...jpeg, ...latin1Bytes('\nEI')]);

describe('page colour conversion', () => {
  it('rewrites RGB and calibrated gray paint while preserving untouched bytes', () => {
    const document = loadDocument(pdf());
    const report = rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    const text = pageText(document);
    expect(report).toStrictEqual({ operators: 4, kOnly: 1, overprintAdjustments: 0, inlineImages: 0 });
    expect(operands(calGray, [0.5])).not.toBe(operands({ ...calGray, gamma: 1 }, [0.5]));
    expect(text).toBe(
      `% preserve this comment\n0 0 0 1 k 0 0 10 10 re f\n${operands(srgb, [0.2, 0.3, 0.4])} k 20 0 10 10 re f\n0.7 g 40 0 10 10 re f\n/DeviceCMYK cs ${operands(calGray, [0.5])} sc 60 0 10 10 re f\n/CS2 cs 0.5 sc 80 0 10 10 re f\n`,
    );
  });

  it('keeps Shift_JIS Separation name bytes through conversion and save', () => {
    const document = loadDocument(pdf());
    const original = spotName(document);
    rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    const saved = loadDocument(document.save().toBytes());
    expect(document.save().mode).toBe('full');
    expect(spotName(saved)).toStrictEqual(original);
    expect(spotName(saved)).toStrictEqual(Uint8Array.of(0x82, 0x62, 0x82, 0x74, 0x82, 0x73));
  });

  it('respects intent state and exact-zero black for strokes', () => {
    const document = loadDocument(pdf());
    const raw = latin1Bytes('q /Perceptual ri 0.2 0.3 0.4 rg Q 0.2 0.3 0.4 rg 0 0 0 RG 0.004 0.004 0.004 rg');
    const result = rewriteContentColors(document, raw, {
      resources: document.page(0).resources(),
      options: { sourceRgbProfile: source, outputProfile: destination },
    });
    const text = latin1Text(result.bytes);
    const converted = [...text.matchAll(/([\d.]+ [\d.]+ [\d.]+ [\d.]+) k/gu)].map(match => match[1]);
    expect(converted).toHaveLength(3);
    expect(converted[0]).not.toBe(converted[1]);
    expect(text).toContain('0 0 0 1 K');
    expect(text).not.toContain('0 0 0 1 k');
    expect(result.kOnly).toBe(1);
  });

  it('sets the converted initial colour when black preservation is disabled', () => {
    const document = loadDocument(pdf());
    const result = rewriteContentColors(document, latin1Bytes('/CS1 cs 0 0 10 10 re f'), {
      resources: document.page(0).resources(),
      options: { sourceRgbProfile: source, outputProfile: destination, pureBlack: 'convert' },
    });
    // ISO 32000-1:2008, 8.6.8 Table 74: the initial colour of a CIE-based gray space is 0.
    expect(latin1Text(result.bytes)).toBe(`/DeviceCMYK cs\n${operands(calGray, [0])} sc 0 0 10 10 re f`);
    expect(operands(calGray, [0])).not.toBe(operands(calGray, [1]));
  });

  it('promotes DeviceGray only when selected', () => {
    const document = loadDocument(pdf());
    const raw = latin1Bytes('0.25 g /DeviceGray cs 0.5 sc');
    const kept = rewriteContentColors(document, raw, {
      resources: document.page(0).resources(),
      options: { sourceRgbProfile: source, outputProfile: destination },
    });
    const promoted = rewriteContentColors(document, raw, {
      resources: document.page(0).resources(),
      options: { sourceRgbProfile: source, outputProfile: destination, deviceGray: 'promote-to-cmyk' },
    });
    expect(latin1Text(kept.bytes)).toBe(latin1Text(raw));
    expect(latin1Text(promoted.bytes)).toBe('0 0 0 0.75 k /DeviceCMYK cs 0 0 0 0.5 sc');
  });

  it('converts a small inline RGB image without applying K-only black', () => {
    const document = loadDocument(pdf());
    const input = latin1Bytes(`BI /W 1 /H 1 /BPC 8 /CS /RGB ID\n${String.fromCodePoint(0, 0, 0)}\nEI`);
    const result = rewriteContentColors(document, input, {
      resources: document.page(0).resources(),
      options: { sourceRgbProfile: source, outputProfile: destination },
    });
    expect(result.inlineImages).toBe(1);
    expect(readInline(result.bytes).samples).toStrictEqual(rgbRow([0, 0, 0]));
    expect(rgbRow([0, 0, 0])).not.toStrictEqual(Uint8Array.of(0, 0, 0, 255));
    expect(inlineParameters(result.bytes)).toBe('BI /W 1 /H 1 /BPC 8 /CS /CMYK /F /Fl');
  });

  it('decodes a Flate inline RGB image before conversion', () => {
    const document = loadDocument(pdf());
    const compressed = latin1Text(deflateZlib(Uint8Array.of(255, 0, 0)));
    const input = latin1Bytes(`BI /W 1 /H 1 /BPC 8 /CS /RGB /F /Fl ID\n${compressed}\nEI`);
    const result = rewriteContentColors(document, input, {
      resources: document.page(0).resources(),
      options: { sourceRgbProfile: source, outputProfile: destination },
    });
    expect(result.inlineImages).toBe(1);
    expect(readInline(result.bytes).samples).toHaveLength(4);
  });

  it('keeps a DCT inline RGB image as an ICC-tagged image XObject', () => {
    const document = loadDocument(pdf());
    const input = latin1Bytes('BI /W 1 /H 1 /BPC 8 /CS /RGB /F /DCT ID\nJPEG\nEI');
    document.replaceStreamData(pdfReference(4, 0), input, { filter: 'FlateDecode' });
    const report = rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.inlineImages).toBe(1);
    expect(pageText(document)).toContain('/PWIM0 Do');
    const image = namedImage(document, 'PWIM0');
    expect(image.data).toStrictEqual(latin1Bytes('JPEG'));
    expect(image.dictionary.get(pdfName('Filter').bytes)).toStrictEqual(pdfName('DCTDecode'));
    const space = image.dictionary.get(pdfName('ColorSpace').bytes);
    if (space?.kind !== 'array' || space.items[1]?.kind !== 'reference') {
      throw new Error('the kept image is not ICCBased');
    }
    expect(space.items[0]).toStrictEqual(pdfName('ICCBased'));
    const profile = document.get(space.items[1]);
    expect(profile.kind === 'stream' ? [profile.data, profile.dictionary.get(pdfName('N').bytes)] : undefined).toStrictEqual([source.bytes, pdfInteger(3)]);
  });

  it('keeps a compressed inline image filter chain and decode parameters', () => {
    const document = loadDocument(pdf());
    const input = latin1Bytes('BI /W 1 /H 1 /BPC 8 /CS /RGB /F [/A85 /DCT] /DP [null <</ColorTransform 0>>] ID\nJPEG\nEI');
    document.replaceStreamData(pdfReference(4, 0), input, { filter: 'FlateDecode' });
    rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    const image = namedImage(document, 'PWIM0');
    expect(image.dictionary.get(pdfName('Filter').bytes)).toStrictEqual(pdfArray([pdfName('ASCII85Decode'), pdfName('DCTDecode')]));
    expect(image.dictionary.get(pdfName('DecodeParms').bytes)).toStrictEqual(
      pdfArray([{ kind: 'null' }, pdfDictionary(new PdfDictionaryEntries([[pdfName('ColorTransform').bytes, pdfInteger(0)]]))]),
    );
  });

  it('converts an inline Indexed lookup and preserves the index bytes', () => {
    const document = loadDocument(pdf());
    const input = latin1Bytes(`BI /W 2 /H 1 /BPC 8 /CS [/I /RGB 1 <000000ff0000>] ID\n${String.fromCodePoint(0, 1)}\nEI`);
    const result = rewriteContentColors(document, input, {
      resources: document.page(0).resources(),
      options: { sourceRgbProfile: source, outputProfile: destination },
    });
    const expected = new Uint8Array(8);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    transform.convertRow8(Uint8Array.of(0, 0, 0, 255, 0, 0), expected, 2);
    expect(result.inlineImages).toBe(1);
    expect(inlineData(result.bytes)).toStrictEqual(Uint8Array.of(0, 1));
    expect(inlineIndexedLookup(result.bytes)).toStrictEqual(expected);
  });

  it('moves a converted inline image above 4 KB into an XObject', () => {
    const document = loadDocument(pdf());
    const input = latin1Bytes(`BI /W 50 /H 25 /BPC 8 /CS /RGB ID\n${'\0'.repeat(3750)}\nEI`);
    document.replaceStreamData(pdfReference(4, 0), input, { filter: 'FlateDecode' });
    const report = rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.inlineImages).toBe(1);
    expect(pageText(document)).toContain('/PWIM0 Do');
    const image = namedImage(document, 'PWIM0');
    expect(
      ['Type', 'Subtype', 'Width', 'Height', 'BitsPerComponent', 'ColorSpace', 'Filter'].map(key => image.dictionary.get(pdfName(key).bytes)),
    ).toStrictEqual([pdfName('XObject'), pdfName('Image'), pdfInteger(50), pdfInteger(25), pdfInteger(8), pdfName('DeviceCMYK'), pdfName('FlateDecode')]);
    expect(xObjectData(document, 'PWIM0')).toStrictEqual(rgbRow(Array.from({ length: 3750 }, () => 0)));
  });

  it.each([
    { width: 32, height: 32, bytes: 4096, inline: true },
    { width: 1025, height: 1, bytes: 4100, inline: false },
  ])('keeps $bytes converted bytes inline: $inline', ({ width, height, inline }) => {
    const result = rewrite(`BI /W ${String(width)} /H ${String(height)} /BPC 8 /CS /RGB ID\n${'\0'.repeat(width * height * 3)}\nEI`);
    expect(result.newInlineImages.map(image => [image.name, image.width, image.height])).toStrictEqual(inline ? [] : [['PWIM0', width, height]]);
    expect(latin1Text(result.bytes).startsWith(inline ? 'BI /W' : '/PWIM0 Do')).toBe(true);
  });

  it('chooses a free resource name for a moved inline image', () => {
    const document = loadDocument(pdf());
    const input = latin1Bytes(`BI /W 50 /H 25 /BPC 8 /CS /RGB ID\n${'\0'.repeat(3750)}\nEI`);
    document.replaceStreamData(pdfReference(4, 0), input, { filter: 'FlateDecode' });
    const page = dictionaryValue(document.get(document.page(0).reference));
    const resources = document.page(0).resources();
    const existing = new PdfDictionaryEntries([[pdfName('PWIM0').bytes, pdfReference(4, 0)]]);
    resources.set(pdfName('XObject').bytes, pdfDictionary(existing));
    page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
    document.set(document.page(0).reference, page);
    rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(pageText(document)).toContain('/PWIM1 Do');
    expect(xObjectData(document, 'PWIM1')).toHaveLength(5000);
  });

  it('neutralises overprint mode around a converted path', () => {
    const document = loadDocument(pdf());
    const resources = document.page(0).resources();
    const state = pdfDictionary(
      new PdfDictionaryEntries([
        [pdfName('OP').bytes, { kind: 'boolean', value: true }],
        [pdfName('OPM').bytes, pdfInteger(1)],
      ]),
    );
    const states = new PdfDictionaryEntries([[pdfName('GS').bytes, state]]);
    resources.set(pdfName('ExtGState').bytes, pdfDictionary(states));
    const raw = latin1Bytes('/GS gs 0 0 0 RG 0 0 m 10 10 l S');
    const config = { resources, options: { sourceRgbProfile: source, outputProfile: destination }, overprintNames: { off: 'PW0', on: 'PW1' } };
    const result = rewriteContentColors(document, raw, config);
    const text = latin1Text(result.bytes);
    expect(text).toContain('0 0 0 1 K');
    expect(text).toMatch(/\/PW0 gs\s+0 0 m 10 10 l S\s+\/PW1 gs/u);
    expect(result.overprintAdjustments).toBe(1);
    expect(() => {
      rewriteContentColors(document, raw, { ...config, options: { ...config.options, overprintMode: 'refuse' } });
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'overprint-mode-change' }));
  });

  it('adds only the overprint states that rewritten page content uses', () => {
    const document = loadDocument(overprintPdf());
    const report = rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    const text = pageText(document);
    expect(report.overprintAdjustments).toBe(1);
    expect(text).toMatch(/\/PWOPM0 gs\s+0 0 m 10 10 l S\s+\/PWOPM1 gs/u);
    expect(addedOverprintStates(document)).toStrictEqual([true, true]);
    const states = internalsOf(document)?.objects.deref(document.page(0).resources().get(pdfName('ExtGState').bytes));
    expect(named(entriesOf(states))).toStrictEqual([
      [
        'GS',
        overprintState([
          ['OP', { kind: 'boolean', value: true }],
          ['OPM', pdfInteger(1)],
        ]),
      ],
      ['PWOPM0', opm(0)],
      ['PWOPM1', opm(1)],
    ]);
    expect(document.get(pdfReference(8, 0)).kind).toBe('null');
  });

  it.each([
    { taken: 'PWOPM0', state: '/PWOPM0<</LW 2>>' },
    { taken: 'PWOPM1', state: '/PWOPM1<</LW 2>>' },
  ])('skips to PWOPM2 and PWOPM3 when $taken is taken', ({ state }) => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
            { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ExtGState<</GS<</OP true/OPM 1>>${state}>>>>>>` },
            { number: 4, body: streamBody('', '/GS gs 0 0 0 RG 0 0 m 10 10 l S') },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(pageText(document)).toBe('/GS gs 0 0 0 1 K /PWOPM2 gs\n0 0 m 10 10 l S\n/PWOPM3 gs');
    const states = named(entriesOf(internalsOf(document)?.objects.deref(document.page(0).resources().get(pdfName('ExtGState').bytes))));
    expect(states.slice(2)).toStrictEqual([
      ['PWOPM2', opm(0)],
      ['PWOPM3', opm(1)],
    ]);
  });

  it('removes one shared resource object after both pages replace it', () => {
    const document = loadDocument(sharedOverprintPdf.bytes);
    const report = rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.overprintAdjustments).toBe(2);
    expect(document.get(pdfReference(8, 0)).kind).toBe('null');
  });

  it('sets OPM 0 around text showing inside BT and ET', () => {
    const document = loadDocument(pdf());
    const resources = document.page(0).resources();
    const state = pdfDictionary(
      new PdfDictionaryEntries([
        [pdfName('OP').bytes, { kind: 'boolean', value: true }],
        [pdfName('OPM').bytes, pdfInteger(1)],
      ]),
    );
    const states = new PdfDictionaryEntries([[pdfName('GS').bytes, state]]);
    resources.set(pdfName('ExtGState').bytes, pdfDictionary(states));
    const raw = latin1Bytes('/GS gs 0 0 0 rg BT (x) Tj ET');
    const result = rewriteContentColors(document, raw, {
      resources,
      options: { sourceRgbProfile: source, outputProfile: destination },
      overprintNames: { off: 'PW0', on: 'PW1' },
    });
    expect(latin1Text(result.bytes)).toMatch(/BT\s+\/PW0 gs\s+\(x\) Tj\s+\/PW1 gs\s+ET/u);
    expect(result.overprintAdjustments).toBe(1);
  });

  it('refuses PieceInfo before writing a replacement stream', () => {
    const document = loadDocument(pdf(true));
    const original = pageText(document);
    expect(() => {
      rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'application-data' }));
    expect(pageText(document)).toBe(original);
  });

  it('converts an operation that a page Contents array splits across two streams', () => {
    // ISO 32000-1:2008, 7.8.2 Table 30: the division between streams may fall between any two lexical tokens.
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents[4 0 R 5 0 R]/Resources<<>>>>' },
            { number: 4, body: streamBody('', '0.2 0.4') },
            { number: 5, body: streamBody('', '0.6 rg 0 0 10 10 re f') },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect(rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination }).operators).toBe(1);
    expect(pageText(document)).toBe(`${operands(srgb, [0.2, 0.4, 0.6])} k 0 0 10 10 re f`);
  });

  it.each([
    { content: '0.2 0.3 rg', what: 'too few rg operands' },
    { content: '0.2 0.3 0.4 0.5 rg', what: 'too many rg operands' },
    { content: '(x) 0 0 rg', what: 'a string rg operand' },
    { content: '1 cs', what: 'a cs operand that is not a name' },
    { content: 'q Q Q', what: 'an unbalanced Q' },
  ])('refuses $what', ({ content: text }) => {
    expect(() => rewrite(text)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-operator' }));
  });

  it('takes the rendering intent from an ExtGState RI and lets a fixed intent override ri', () => {
    const fromState = rewrite('/RI0 gs 0.2 0.3 0.4 rg', {}, '<</ExtGState<</RI0<</RI/Perceptual>>>>>>');
    expect(latin1Text(fromState.bytes)).toBe(`/RI0 gs ${operands(srgb, [0.2, 0.3, 0.4], { intent: 'perceptual' })} k`);
    const fixed = rewrite('/Perceptual ri 0.2 0.3 0.4 rg', { intent: 'relativeColorimetric' });
    expect(latin1Text(fixed.bytes)).toBe(`/Perceptual ri ${operands(srgb, [0.2, 0.3, 0.4])} k`);
    expect(operands(srgb, [0.2, 0.3, 0.4], { intent: 'perceptual' })).not.toBe(operands(srgb, [0.2, 0.3, 0.4]));
  });

  it.each([
    { state: '<</OP true/OPM 1>>', neutralised: true },
    { state: '<</OP true/op false/OPM 1>>', neutralised: false },
    { state: '<</OP false/op true/OPM 1>>', neutralised: true },
    { state: '<</OP true/OPM 0>>', neutralised: false },
    { state: '<</OP false/OPM 1>>', neutralised: false },
  ])('neutralises a converted zero fill under $state: $neutralised', ({ state, neutralised }) => {
    // ISO 32000-1:2008, 8.4.5 Table 58: op defaults to OP, and OPM 1 matters only while overprint is on.
    const result = rewrite('/GS gs 0 0 0 rg 0 0 10 10 re f', {}, `<</ExtGState<</GS${state}>>>>`);
    expect(latin1Text(result.bytes)).toBe(neutralised ? '/GS gs 0 0 0 1 k /PW0 gs\n0 0 10 10 re f\n/PW1 gs' : '/GS gs 0 0 0 1 k 0 0 10 10 re f');
  });

  it.each([
    { content: '0 0 0 rg 0 0 m 5 5 l n 0 0 10 10 re f', expected: '0 0 0 1 k 0 0 m 5 5 l n /PW0 gs\n0 0 10 10 re f\n/PW1 gs' },
    { content: '0 0 0 rg 0 0 10 10 re S', expected: '0 0 0 1 k 0 0 10 10 re S' },
    { content: '0 0 0 rg 0 0 10 10 re B', expected: '0 0 0 1 k /PW0 gs\n0 0 10 10 re B\n/PW1 gs' },
    { content: '0 0 0 RG 0 0 10 10 re b', expected: '0 0 0 1 K /PW0 gs\n0 0 10 10 re b\n/PW1 gs' },
    { content: '0 0 0 RG 0 0 10 10 re f', expected: '0 0 0 1 K 0 0 10 10 re f' },
    { content: '0 0 0 rg 3 Tr BT (x) Tj ET', expected: '0 0 0 1 k 3 Tr BT (x) Tj ET' },
    { content: '0 0 0 rg 1 Tr BT (x) Tj ET', expected: '0 0 0 1 k 1 Tr BT (x) Tj ET' },
    { content: '0 0 0 RG 1 Tr BT (x) Tj ET', expected: '0 0 0 1 K 1 Tr BT /PW0 gs\n(x) Tj\n/PW1 gs ET' },
  ])('neutralises only the painting that uses the zero component: $content', ({ content: text, expected }) => {
    // ISO 32000-1:2008, 8.5.3 Table 60 and 9.3.6 Table 106: n paints nothing, B and b fill and stroke, Tr 3 paints nothing and Tr 1 only strokes.
    const result = rewrite(`/GS gs ${text}`, {}, OVERPRINT);
    expect(latin1Text(result.bytes)).toBe(`/GS gs ${expected}`);
  });

  it('leaves sc after k unconverted, because k selects DeviceCMYK', () => {
    expect(latin1Text(rewrite('0.2 0.3 0.4 rg 0.1 0.2 0.3 0.4 k 0.1 0.2 0.3 0.4 sc').bytes)).toBe(
      `${operands(srgb, [0.2, 0.3, 0.4])} k 0.1 0.2 0.3 0.4 k 0.1 0.2 0.3 0.4 sc`,
    );
  });

  it('leaves ICCBased gray paint alone when ICC gray is kept and converts it otherwise', () => {
    const resources = '<</ColorSpace<</G1[/ICCBased 9 0 R]>>>>';
    expect(latin1Text(rewrite('/G1 cs 0.5 sc', { iccGray: 'keep' }, resources).bytes)).toBe('/G1 cs 0.5 sc');
    expect(latin1Text(rewrite('/G1 cs 0.5 sc', {}, resources).bytes)).toBe(`/DeviceCMYK cs ${operands({ kind: 'icc', profile: grayIcc }, [0.5])} sc`);
  });

  it('refuses an inline image whose BI has no ID', () => {
    expect(() => rewrite('BI /W 1 /H 1 /BPC 8 /CS /RGB EI')).toThrow(UnsupportedFeatureError);
  });

  it('leaves Indexed and DeviceN component operands unchanged', () => {
    // ISO 32000-1:2008, 8.6.6.3 and 8.6.6.5: these operands are an index and colorant tints, not RGB components.
    const resources =
      '<</ColorSpace<</CSI[/Indexed/DeviceRGB 1<000000ff0000>]/CSN[/DeviceN[/A/B]/DeviceRGB<</FunctionType 2/Domain[0 1 0 1]/C0[0 0 0]/C1[1 1 1]/N 1>>]>>>>';
    const text = '/CSI cs 1 sc /CSN CS 0.2 0.7 SCN';
    const result = rewrite(text, {}, resources);
    expect([latin1Text(result.bytes), result.operators]).toStrictEqual([text, 0]);
  });

  it.each([
    { bits: 1, packed: [0xa0], rgb: [1, 0, 1] },
    { bits: 2, packed: [0x2c], rgb: [0, 2 / 3, 1] },
    { bits: 4, packed: [0x08, 0xf0], rgb: [0, 8 / 15, 1] },
  ])('unpacks a $bits-bit inline RGB pixel', ({ bits, packed, rgb }) => {
    const result = rewrite(`BI /W 1 /H 1 /BPC ${String(bits)} /CS /RGB ID\n${latin1Text(Uint8Array.from(packed))}\nEI`);
    const output = new Float64Array(4);
    createColorTransform(srgb, destination, { intent: 'relativeColorimetric', blackPointCompensation: true }).convert(Float64Array.from(rgb), output);
    expect(readInline(result.bytes).samples).toStrictEqual(Uint8Array.from(output, value => Math.round(value * 255)));
    expect(inlineParameters(result.bytes)).toBe('BI /W 1 /H 1 /BPC 8 /CS /CMYK /F /Fl');
  });

  it('writes a 16-bit inline RGB pixel as 16-bit big-endian CMYK', () => {
    const result = rewrite(`BI /W 1 /H 1 /BPC 16 /CS /RGB ID\n${latin1Text(Uint8Array.of(0x80, 0x00, 0x40, 0x00, 0xff, 0xff))}\nEI`);
    const expected = new Uint16Array(4);
    createColorTransform(srgb, destination, { intent: 'relativeColorimetric', blackPointCompensation: true }).convertRow16(
      Uint16Array.of(0x80_00, 0x40_00, 0xff_ff),
      expected,
      1,
    );
    expect(readInline(result.bytes).samples).toStrictEqual(Uint8Array.from([...expected].flatMap(value => [Math.floor(value / 256), value % 256])));
    expect(inlineParameters(result.bytes)).toBe('BI /W 1 /H 1 /BPC 16 /CS /CMYK /F /Fl');
  });

  it.each([
    { image: 'BI /W 1 /H 1 /BPC 8 ID\n\0\0\0\nEI', what: 'no ColorSpace' },
    { image: 'BI /W 1 /H 1 /BPC 8 /CS /RGB /D ID\n\0\0\0\nEI', what: 'unpaired parameters' },
    { image: 'BI /W 1 /H 1 /BPC 8 /CS /RGB (X) 1 ID\n\0\0\0\nEI', what: 'a key that is not a name' },
    { image: 'BI /W 2 /H 1 /BPC 8 /CS /RGB ID\n\0\0\0\nEI', what: 'data shorter than its dimensions' },
    { image: 'BI /W 1 /H 1 /BPC 8 /CS /RGB /D [0 1 0 1] ID\n\0\0\0\nEI', what: 'a four-number Decode' },
    { image: 'BI /W 1 /H 1 /BPC 3 /CS /RGB ID\n\0\0\nEI', what: 'a bit depth of 3' },
  ])('refuses an inline image with $what', ({ image }) => {
    expect(() => rewrite(image)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
  });

  it('converts an inline image whose working bytes equal the in-memory ceiling and refuses it under a ceiling one byte lower', () => {
    // Each row holds 30 input and 40 output bytes, so 14 rows use 980 bytes.
    expect(rewrite(tenWide(14), {}, undefined, 980).inlineImages).toBe(1);
    expect(() => rewrite(tenWide(14), {}, undefined, 979)).toThrow(ResourceLimitError);
  });

  it('caps the in-memory ceiling at 4 MiB under a larger maxDecodedBytes', () => {
    // 1024 pixels a row take 7168 bytes: 585 rows fit in 4 MiB and 586 rows do not.
    expect(rewrite(kibiWide(585)).newInlineImages).toHaveLength(1);
    expect(() => rewrite(kibiWide(586))).toThrow(ResourceLimitError);
  });

  it('refuses to transcode an inline JPEG that is not a single 8-bit DCT image of its stated size', async () => {
    const jpeg = await jpegFixture();
    expect(rewrite(inlineJpeg(jpeg, '/W 2 /H 1 /BPC 8 /CS /RGB /F /DCT'), { compressedRgbImages: 'transcode' }).newInlineImages).toHaveLength(1);
    expect(() => rewrite(inlineJpeg(jpeg, '/W 2 /H 1 /BPC 16 /CS /RGB /F /DCT'), { compressedRgbImages: 'transcode' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
    expect(() => rewrite(inlineJpeg(jpeg, '/W 3 /H 1 /BPC 8 /CS /RGB /F /DCT'), { compressedRgbImages: 'transcode' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
    for (const filter of ['[/A85 /DCT]', '/JPXDecode']) {
      expect(() => rewrite(inlineJpeg(jpeg, `/W 2 /H 1 /BPC 8 /CS /RGB /F ${filter}`), { compressedRgbImages: 'transcode' })).toThrow(
        expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'compressed-rgb-image' }),
      );
    }
  });

  it('refuses a kept compressed inline image without an ICC source, and every one under refuse', () => {
    const image = 'BI /W 1 /H 1 /BPC 8 /CS /RGB /F /DCT ID\nJPEG\nEI';
    const calibrated = '<</ColorSpace<</DefaultRGB[/CalRGB<</WhitePoint[0.9505 1 1.089]>>]>>>>';
    expect(() => rewrite(image, {}, calibrated)).toThrow(expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'compressed-rgb-image' }));
    expect(() => rewrite(image, { compressedRgbImages: 'refuse' })).toThrow(
      expect.objectContaining({ constructor: UnsupportedFeatureError, reason: 'compressed-rgb-image' }),
    );
    expect(rewrite(image).newInlineImages).toHaveLength(1);
  });
});

const PAINT_ONLY = ['m', 'l', 're', 'f', 'S', 'B', 'n', 'h', 'q Q', 'cm', 'w', 'J', 'BT ET', 'Td', 'Tf'] as const;
const COLOUR = ['rg', 'RG', 'k', 'K', 'g', 'G'] as const;

const operation = (operator: string, numbers: ReadonlyArray<number>): string => {
  if (operator === 'q Q' || operator === 'BT ET') {
    return operator;
  }
  const arity = new Map([
    ['m', 2],
    ['l', 2],
    ['re', 4],
    ['cm', 6],
    ['w', 1],
    ['J', 1],
    ['Td', 2],
    ['rg', 3],
    ['RG', 3],
    ['k', 4],
    ['K', 4],
    ['g', 1],
    ['G', 1],
  ]).get(operator);
  if (operator === 'Tf') {
    return `/F1 ${formatNumber(numbers[0] ?? 1, 2)} Tf`;
  }
  return [...numbers.slice(0, arity ?? 0).map(value => formatNumber(value, 3)), operator].join(' ');
};

const operations = (operators: ReadonlyArray<string>) =>
  fc
    .array(
      fc.record({ operator: fc.constantFrom(...operators), numbers: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 6, maxLength: 6 }) }),
      { maxLength: 20 },
    )
    .map(items => items.map(item => operation(item.operator, item.numbers)).join('\n'));

describe('properties', () => {
  it('copies content without colour operators byte for byte', () => {
    fc.assert(
      fc.property(operations(PAINT_ONLY), text => {
        const result = rewrite(text);
        expect([latin1Text(result.bytes), result.operators]).toStrictEqual([text, 0]);
      }),
    );
  });

  it('converts nothing more when run on its own output', () => {
    fc.assert(
      fc.property(operations([...PAINT_ONLY, ...COLOUR]), text => {
        const once = rewrite(text);
        const twice = rewrite(once.bytes);
        expect([latin1Text(twice.bytes), twice.operators]).toStrictEqual([latin1Text(once.bytes), 0]);
      }),
    );
  });
});

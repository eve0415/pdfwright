import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { readContent } from '../content/contentOperations.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { rewriteContentColors } from './rewriteContent.ts';
import { rewritePageColors } from './rewritePage.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const content =
  '% preserve this comment\n0 0 0 rg 0 0 10 10 re f\n0.2 0.3 0.4 rg 20 0 10 10 re f\n0.7 g 40 0 10 10 re f\n/CS1 cs 0 sc 60 0 10 10 re f\n/CS2 cs 0.5 sc 80 0 10 10 re f\n';

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
  if (internals === undefined) throw new Error('missing internals');
  const page = document.get(document.page(0).reference);
  if (page.kind !== 'dictionary') throw new Error('missing page');
  const stream = internals.objects.deref(page.entries.get(pdfName('Contents').bytes));
  if (stream?.kind !== 'stream') throw new Error('missing content stream');
  const data = decodedData(internals, stream);
  if (typeof data === 'string') throw new Error(data);
  return latin1Text(data);
};

const namedImage = (document: ReturnType<typeof loadDocument>, name: string): Extract<PdfObject, { kind: 'stream' }> => {
  const xobjects = document.page(0).resources().get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') throw new Error('missing XObjects');
  const reference = xobjects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') throw new Error('missing image');
  const image = document.get(reference);
  if (image.kind !== 'stream') throw new Error('missing image stream');
  return image;
};

const spotName = (document: ReturnType<typeof loadDocument>): Uint8Array => {
  const resources = document.page(0).resources();
  const spaces = resources.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') throw new Error('missing ColorSpace');
  const separation = spaces.entries.get(pdfName('CS2').bytes);
  if (separation?.kind !== 'array') throw new Error('missing Separation');
  const [, name] = separation.items;
  if (name?.kind !== 'name') throw new Error('missing colorant name');
  return name.bytes;
};

const addedOverprintStates = (document: ReturnType<typeof loadDocument>): readonly boolean[] => {
  const resources = document.page(0).resources();
  const states = resources.get(pdfName('ExtGState').bytes);
  if (states?.kind !== 'dictionary') throw new Error('missing ExtGState');
  return [states.entries.has(pdfName('PWOPM0').bytes), states.entries.has(pdfName('PWOPM1').bytes)];
};

const inlineData = (bytes: Uint8Array): Uint8Array => {
  const [operation] = readContent(bytes, 32);
  const data = operation?.inlineImage?.data;
  if (data === undefined) throw new Error('converted inline image is missing');
  return data;
};

const inlineIndexedLookup = (bytes: Uint8Array): Uint8Array => {
  const [operation] = readContent(bytes, 32);
  const parameters = operation?.inlineImage?.parameters;
  if (parameters === undefined) throw new Error('inline image is missing');
  const index = parameters.findIndex(value => value.kind === 'name' && new TextDecoder('latin1').decode(value.bytes) === 'CS');
  const color = parameters[index + 1];
  if (color?.kind !== 'array') throw new Error('Indexed inline colour space is missing');
  const lookup = color.items.at(3);
  if (lookup?.kind !== 'string') throw new Error('Indexed inline lookup is missing');
  return lookup.bytes;
};

const xObjectData = (document: ReturnType<typeof loadDocument>, name: string): Uint8Array => {
  const resources = document.page(0).resources();
  const objects = resources.get(pdfName('XObject').bytes);
  if (objects?.kind !== 'dictionary') throw new Error('XObject resources are missing');
  const reference = objects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') throw new Error('image reference is missing');
  const stream = document.get(reference);
  const internals = internalsOf(document);
  if (stream.kind !== 'stream' || internals === undefined) throw new Error('image stream is missing');
  const data = decodedData(internals, stream);
  if (typeof data === 'string') throw new Error(data);
  return data;
};

const dictionaryValue = (value: PdfObject): Extract<PdfObject, { kind: 'dictionary' }> => {
  if (value.kind !== 'dictionary') throw new Error('page is missing');
  return value;
};

describe('page colour conversion', () => {
  it('rewrites RGB and calibrated gray paint while preserving untouched bytes', () => {
    const document = loadDocument(pdf());
    const report = rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    const text = pageText(document);
    expect(report).toMatchObject({ operators: 4, kOnly: 2 });
    expect(text).toContain('% preserve this comment\n0 0 0 1 k 0 0 10 10 re f');
    expect(text).toContain('0.7 g 40 0 10 10 re f');
    expect(text).toContain('/DeviceCMYK cs 0 0 0 1 sc');
    expect(text).toContain('/CS2 cs 0.5 sc 80 0 10 10 re f');
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
    const text = latin1Text(result.bytes);
    expect(text).toContain('/DeviceCMYK cs');
    expect(text).toMatch(/\/DeviceCMYK cs\s+[\d.]+ [\d.]+ [\d.]+ [\d.]+ sc/u);
    expect(text).not.toContain('0 0 0 1 sc');
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
    const data = inlineData(result.bytes);
    expect(result.inlineImages).toBe(1);
    expect(inflateZlib(data).data).not.toStrictEqual(Uint8Array.of(0, 0, 0, 255));
    expect(inflateZlib(data).data).toHaveLength(4);
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
    expect(inflateZlib(inlineData(result.bytes)).data).toHaveLength(4);
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
    expect(image.dictionary.get(pdfName('ColorSpace').bytes)?.kind).toBe('array');
  });

  it('keeps a compressed inline image filter chain and decode parameters', () => {
    const document = loadDocument(pdf());
    const input = latin1Bytes('BI /W 1 /H 1 /BPC 8 /CS /RGB /F [/A85 /DCT] /DP [null <</ColorTransform 0>>] ID\nJPEG\nEI');
    document.replaceStreamData(pdfReference(4, 0), input, { filter: 'FlateDecode' });
    rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
    const image = namedImage(document, 'PWIM0');
    expect(image.dictionary.get(pdfName('Filter').bytes)).toStrictEqual(pdfArray([pdfName('ASCII85Decode'), pdfName('DCTDecode')]));
    expect(image.dictionary.get(pdfName('DecodeParms').bytes)?.kind).toBe('array');
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
    expect(xObjectData(document, 'PWIM0')).toHaveLength(5000);
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
    expect(document.get(pdfReference(8, 0)).kind).toBe('null');
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
});

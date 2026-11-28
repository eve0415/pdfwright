import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

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

const content = (document: ReturnType<typeof loadDocument>, number: number): string => {
  const object = document.get(pdfReference(number, 0));
  if (object.kind !== 'stream') {
    throw new Error('content stream is missing');
  }
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('document internals are unavailable');
  }
  const data = decodedData(internals, object);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return latin1Text(data);
};

const numbers = (value: PdfObject | undefined): ReadonlyArray<number> => {
  if (value?.kind !== 'array') {
    throw new Error('colour array is missing');
  }
  return value.items.map(item => {
    if (item.kind === 'integer') {
      return item.value;
    }
    if (item.kind === 'real' && typeof item.value === 'number') {
      return item.value;
    }
    return Number.NaN;
  });
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

const color = (document: ReturnType<typeof loadDocument>, key: string): ReadonlyArray<number> =>
  numbers(entriesOf(document.get(pdfReference(7, 0))).get(pdfName(key).bytes));

const widgetColor = (document: ReturnType<typeof loadDocument>, key: string): ReadonlyArray<number> => {
  const internals = internalsOf(document);
  const mk = internals?.objects.deref(entriesOf(document.get(pdfReference(7, 0))).get(pdfName('MK').bytes));
  return numbers(entriesOf(mk).get(pdfName(key).bytes));
};

// ISO 32000-1:2008, Table 164: a three-number annotation colour is DeviceRGB, so it converts through the caller's RGB profile.
const cmyk = (rgb: readonly [number, number, number], options: { readonly intent?: 'perceptual' } = {}): ReadonlyArray<number> => {
  const output = new Float64Array(4);
  createColorTransform({ kind: 'icc', profile: source }, destination, {
    intent: options.intent ?? 'relativeColorimetric',
    blackPointCompensation: true,
  }).convert(Float64Array.from(rgb), output);
  return [...output];
};

interface TestObject {
  readonly number: number;
  readonly body: string;
}

// Page 3 carries annotation 7; the content stream paints nothing.
const annotated = (
  annotation: string,
  objects: ReadonlyArray<TestObject>,
  options: { readonly maxDecodedBytes?: number; readonly page?: string } = {},
): ReturnType<typeof loadDocument> =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Annots[7 0 R]${options.page ?? '/Resources<<>>'}>>` },
          { number: 4, body: streamBody('', '') },
          { number: 7, body: `<</Type/Annot/Subtype/Square/Rect[0 0 10 10]/F 4${annotation}>>` },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
    options.maxDecodedBytes === undefined ? {} : { maxDecodedBytes: options.maxDecodedBytes },
  );

const options = { sourceRgbProfile: source, outputProfile: destination };
const opm = (value: number): PdfObject => pdfDictionary(new PdfDictionaryEntries([[pdfName('OPM').bytes, pdfInteger(value)]]));
const form = (data: string, extra = ''): string => streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 10 10]${extra}`, data);

describe('other painted colour carriers', () => {
  it('converts annotation and widget colour arrays', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertOtherCarriers(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report).toStrictEqual({ annotations: 1, appearances: 1, patterns: 1, glyphs: 1 });
    expect(color(document, 'C')).toStrictEqual([0, 0, 0, 1]);
    expect(color(document, 'IC')).toStrictEqual(cmyk([1, 0, 0]));
    expect(widgetColor(document, 'BG')).toStrictEqual(cmyk([0, 1, 0]));
    expect(widgetColor(document, 'BC')).toStrictEqual(cmyk([0, 0, 1]));
  });

  it('sends exact black through the transform when black preservation is off', () => {
    const document = annotated('/C[0 0 0]', []);
    convertOtherCarriers(document, { ...options, pureBlack: 'convert' });
    const converted = cmyk([0, 0, 0]);
    expect(converted).not.toStrictEqual([0, 0, 0, 1]);
    expect(color(document, 'C')).toStrictEqual(converted);
  });

  it('uses a fixed conversion intent for annotation colours', () => {
    const document = annotated('/IC[0.2 0.5 0.9]', []);
    convertOtherCarriers(document, { ...options, intent: 'perceptual' });
    expect(cmyk([0.2, 0.5, 0.9], { intent: 'perceptual' })).not.toStrictEqual(cmyk([0.2, 0.5, 0.9]));
    expect(color(document, 'IC')).toStrictEqual(cmyk([0.2, 0.5, 0.9], { intent: 'perceptual' }));
  });

  it.each([
    { components: 0, value: '[]' },
    { components: 1, value: '[0.5]' },
    { components: 4, value: '[0.1 0.2 0.3 0.4]' },
  ])('leaves a $components-component annotation colour unchanged', ({ value }) => {
    // ISO 32000-1:2008, Table 164: 0 components mean transparent, 1 DeviceGray and 4 DeviceCMYK, none of which is RGB.
    const document = annotated(`/C${value}`, []);
    const before = color(document, 'C');
    expect(convertOtherCarriers(document, options)).toStrictEqual({ annotations: 0, appearances: 0, patterns: 0, glyphs: 0 });
    expect(color(document, 'C')).toStrictEqual(before);
  });

  it('refuses an RGB annotation colour with a non-numeric component', () => {
    expect(() => convertOtherCarriers(annotated('/C[1 /Red 0]', []), options)).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
  });

  it('leaves an uncoloured tiling pattern and a Type 3 d1 glyph unrewritten', () => {
    // ISO 32000-1:2008, 8.7.3.3: a PaintType 2 pattern takes its colour from the caller; 9.6.5: a d1 glyph ignores its colour operators.
    const page = '/Resources<</Pattern<</P 5 0 R>>/Font<</F 6 0 R>>>>';
    const document = annotated(
      '',
      [
        {
          number: 5,
          body: streamBody('/Type/Pattern/PatternType 1/PaintType 2/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<<>>', '1 0 0 rg 0 0 10 10 re f'),
        },
        {
          number: 6,
          body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</A 9 0 R>>/Encoding<</Type/Encoding/Differences[65/A]>>/FirstChar 65/LastChar 65/Widths[1000]/Resources<<>>>>',
        },
        { number: 9, body: streamBody('', '1000 0 0 0 500 500 d1 0 1 0 rg 0 0 500 500 re f') },
      ],
      { page },
    );
    expect(convertOtherCarriers(document, options)).toStrictEqual({ annotations: 0, appearances: 0, patterns: 0, glyphs: 0 });
    expect([content(document, 5), content(document, 9)]).toStrictEqual(['1 0 0 rg 0 0 10 10 re f', '1000 0 0 0 500 500 d1 0 1 0 rg 0 0 500 500 re f']);
  });

  it('converts every appearance state and every sub-dictionary variant', () => {
    // ISO 32000-1:2008, 12.5.5 Table 168: N, R and D each hold a stream or a dictionary of streams by appearance state.
    const document = annotated('/AP<</N<</On 10 0 R/Off 11 0 R>>/R 12 0 R/D<</On 13 0 R>>>>', [
      { number: 10, body: form('1 0 0 rg') },
      { number: 11, body: form('0 1 0 rg') },
      { number: 12, body: form('0 0 1 rg') },
      { number: 13, body: form('1 1 0 rg') },
    ]);
    expect(convertOtherCarriers(document, options).appearances).toBe(4);
    expect([10, 11, 12, 13].map(number => /^[\d.]+ [\d.]+ [\d.]+ [\d.]+ k$/u.test(content(document, number)))).toStrictEqual([true, true, true, true]);
  });

  it('replaces an indirect MK dictionary and deletes the old object', () => {
    const document = annotated('/MK 8 0 R', [{ number: 8, body: '<</BG[0 1 0]>>' }]);
    expect(convertOtherCarriers(document, options).annotations).toBe(1);
    expect(widgetColor(document, 'BG')).toStrictEqual(cmyk([0, 1, 0]));
    expect(entriesOf(document.get(pdfReference(7, 0))).get(pdfName('MK').bytes)?.kind).toBe('dictionary');
    expect(document.get(pdfReference(8, 0))).toStrictEqual({ kind: 'null' });
  });

  it('refuses an appearance variant that is not a stream', () => {
    const document = annotated('/AP<</N<</On 10 0 R>>>>', [{ number: 10, body: '<</Type/XObject>>' }]);
    expect(() => convertOtherCarriers(document, options)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
  });

  it('accepts a rewritten appearance of exactly maxDecodedBytes and refuses one byte more', () => {
    const objects = [{ number: 10, body: form('1 0 0 rg') }];
    const measured = annotated('/AP<</N 10 0 R>>', objects);
    convertOtherCarriers(measured, options);
    const limit = content(measured, 10).length;
    expect(limit).toBeGreaterThan(8);
    const atLimit = annotated('/AP<</N 10 0 R>>', objects, { maxDecodedBytes: limit });
    expect(convertOtherCarriers(atLimit, options).appearances).toBe(1);
    expect(() => convertOtherCarriers(annotated('/AP<</N 10 0 R>>', objects, { maxDecodedBytes: limit - 1 }), options)).toThrow(ResourceLimitError);
  });

  it('adds the OPM states an appearance needs to its own Resources', () => {
    const document = annotated('/AP<</N 10 0 R>>', [
      { number: 10, body: form('/GS gs 0 0 0 RG 0 0 m 10 10 l S', '/Resources<</ExtGState<</GS<</OP true/OPM 1>>>>>>') },
    ]);
    expect(convertOtherCarriers(document, options).appearances).toBe(1);
    expect(content(document, 10)).toMatch(/\/PWOPM0 gs\s+0 0 m 10 10 l S\s+\/PWOPM1 gs/u);
    const internals = internalsOf(document);
    const resources = internals?.objects.deref(entriesOf(document.get(pdfReference(10, 0))).get(pdfName('Resources').bytes));
    const states = internals?.objects.deref(entriesOf(resources).get(pdfName('ExtGState').bytes));
    expect([...entriesOf(states).entries()].map(([key, value]) => [latin1Text(key), value])).toStrictEqual([
      [
        'GS',
        pdfDictionary(
          new PdfDictionaryEntries([
            [pdfName('OP').bytes, { kind: 'boolean', value: true }],
            [pdfName('OPM').bytes, pdfInteger(1)],
          ]),
        ),
      ],
      ['PWOPM0', opm(0)],
      ['PWOPM1', opm(1)],
    ]);
  });

  it('moves a converted inline image above 4 KB in an appearance into an XObject', () => {
    const document = annotated('/AP<</N 10 0 R>>', [
      { number: 10, body: form(`BI /W 50 /H 25 /BPC 8 /CS /RGB ID\n${'\0'.repeat(3750)}\nEI`, '/Resources<<>>') },
    ]);
    convertOtherCarriers(document, options);
    expect(content(document, 10)).toContain('/PWIM0 Do');
    const internals = internalsOf(document);
    const resources = internals?.objects.deref(entriesOf(document.get(pdfReference(10, 0))).get(pdfName('Resources').bytes));
    const xobjects = internals?.objects.deref(entriesOf(resources).get(pdfName('XObject').bytes));
    const image = internals?.objects.deref(entriesOf(xobjects).get(pdfName('PWIM0').bytes));
    expect(entriesOf(image).get(pdfName('ColorSpace').bytes)).toStrictEqual(pdfName('DeviceCMYK'));
    expect([entriesOf(image).get(pdfName('Width').bytes), entriesOf(image).get(pdfName('Height').bytes)]).toStrictEqual([pdfInteger(50), pdfInteger(25)]);
  });

  it('converts a stream reached both as an appearance and as a pattern once', () => {
    const page = '/Resources<</Pattern<</P 10 0 R>>>>';
    const shared = {
      number: 10,
      body: streamBody('/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<<>>', '1 0 0 rg'),
    };
    const document = annotated('/AP<</N 10 0 R>>', [shared], { page });
    const report = convertOtherCarriers(document, options);
    expect(report.appearances + report.patterns).toBe(1);
    expect(content(document, 10)).toMatch(/^[\d.]+ [\d.]+ [\d.]+ [\d.]+ k$/u);
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

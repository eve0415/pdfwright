import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { SourceSpace, SourceSpaceOptions } from './sourceSpace.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfNameFromBytes, pdfReal, pdfReference, pdfString } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { resolveSourceSpace } from './sourceSpace.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const fallback = parseIccProfile(await fixture('sRGB.icm'));
const alternate = parseIccProfile(await fixture('DisplayP3-v4.icc'));
const grayProfile = (): Uint8Array => {
  const bytes = new Uint8Array(160);
  const view = new DataView(bytes.buffer);
  const signature = (offset: number, name: string): void => {
    for (let index = 0; index < name.length; index++) {
      bytes[offset + index] = name.codePointAt(index) ?? 0;
    }
  };
  view.setUint32(0, bytes.length);
  bytes[8] = 4;
  signature(12, 'scnr');
  signature(16, 'GRAY');
  signature(20, 'XYZ ');
  signature(36, 'acsp');
  view.setUint32(64, 1);
  view.setInt32(68, Math.round(0.9642 * 65_536));
  view.setInt32(72, 65_536);
  view.setInt32(76, Math.round(0.8249 * 65_536));
  view.setUint32(128, 1);
  signature(132, 'kTRC');
  view.setUint32(136, 144);
  view.setUint32(140, 16);
  signature(144, 'curv');
  view.setUint32(152, 1);
  view.setUint16(156, 0x02_33);
  return bytes;
};
const gray = parseIccProfile(grayProfile());
const pdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const context = () => ({
  document: loadDocument(pdf.bytes),
  resources: new PdfDictionaryEntries(),
});

const resolveIn = (test: ReturnType<typeof context>, value: PdfDirectObject, options?: SourceSpaceOptions): SourceSpace =>
  resolveSourceSpace(test.document, value, { resources: test.resources, sourceRgbProfile: fallback, options });

const rgbSource = (space: SourceSpace): Extract<SourceSpace, { kind: 'rgb' }> => {
  if (space.kind !== 'rgb') {
    throw new Error('expected RGB');
  }
  return space;
};

const specialSpace = (space: SourceSpace): Extract<SourceSpace, { kind: 'separation' | 'deviceN' }> => {
  if (space.kind !== 'separation' && space.kind !== 'deviceN') {
    throw new Error('expected Separation or DeviceN');
  }
  return space;
};

const iccSpace = (document: ReturnType<typeof loadDocument>, bytes: Uint8Array, channels: number): ReturnType<typeof pdfArray> => {
  const reference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('N').bytes, pdfInteger(channels)]]), data: bytes });
  return pdfArray([pdfName('ICCBased'), reference]);
};

const D65 = { x: 0.9505, y: 1, z: 1.089 };
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

interface ExtraObject {
  readonly number: number;
  readonly body: string;
}

// Object 10 is the colour space and object 11 the resource dictionary it resolves against, both written in PDF syntax.
const parsed = (resources: string, extra: ReadonlyArray<ExtraObject>, space: string): ReturnType<typeof context> => {
  const document = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
          { number: 10, body: space },
          { number: 11, body: resources },
          ...extra,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );
  const dictionary = document.get(pdfReference(11, 0));
  if (dictionary.kind !== 'dictionary') {
    throw new Error('resources are not a dictionary');
  }
  return { document, resources: dictionary.entries };
};

interface TextSpace {
  readonly resources?: string;
  readonly extra?: ReadonlyArray<ExtraObject>;
  readonly options?: SourceSpaceOptions;
}

const resolveText = (space: string, config: TextSpace = {}): SourceSpace =>
  resolveIn(parsed(config.resources ?? '<<>>', config.extra ?? [], space), pdfReference(10, 0), config.options);

// Each name refers to the next; the last one names DeviceGray, which ends the chain.
const chain = (levels: number): string => {
  const names = Array.from({ length: levels }, (_, index) => `/C${String(index)} /${index + 1 < levels ? `C${String(index + 1)}` : 'DeviceGray'}`);
  return `<</ColorSpace<<${names.join('')}>>>>`;
};

describe('source colour space resolution', () => {
  it('uses DefaultRGB when present and the caller profile otherwise', () => {
    const { document, resources } = context();
    const test = { document, resources };
    const direct = rgbSource(resolveIn(test, pdfName('DeviceRGB')));
    expect(direct.source).toStrictEqual({ kind: 'icc', profile: fallback });
    const colors = new PdfDictionaryEntries([[pdfName('DefaultRGB').bytes, iccSpace(document, alternate.bytes, 3)]]);
    resources.set(pdfName('ColorSpace').bytes, pdfDictionary(colors));
    const mapped = rgbSource(resolveIn(test, pdfName('DeviceRGB')));
    expect(mapped.source).toStrictEqual({ kind: 'icc', profile: alternate });
  });

  it('resolves calibrated RGB and gray sources with their unit defaults', () => {
    // ISO 32000-1:2008, 8.6.5.2–8.6.5.3: Gamma defaults to 1 and Matrix to the identity.
    const { document, resources } = context();
    const white = pdfArray([pdfReal(0.9505), pdfInteger(1), pdfReal(1.089)]);
    const parameters = pdfDictionary(new PdfDictionaryEntries([[pdfName('WhitePoint').bytes, white]]));
    const rgb = resolveIn({ document, resources }, pdfArray([pdfName('CalRGB'), parameters]));
    const graySpace = resolveIn({ document, resources }, pdfArray([pdfName('CalGray'), parameters]));
    expect(rgb).toStrictEqual({ kind: 'rgb', source: { kind: 'calRGB', whitePoint: D65, gamma: [1, 1, 1], matrix: IDENTITY } });
    expect(graySpace).toStrictEqual({ kind: 'gray', source: { kind: 'calGray', whitePoint: D65, gamma: 1 } });
  });

  it('reads a supplied WhitePoint, Gamma and Matrix', () => {
    const matrix = [0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505];
    const rgb = resolveText(`[/CalRGB<</WhitePoint[0.9642 1 0.8249]/Gamma[2.2 1.8 1]/Matrix[${matrix.join(' ')}]>>]`);
    expect(rgb).toStrictEqual({ kind: 'rgb', source: { kind: 'calRGB', whitePoint: { x: 0.9642, y: 1, z: 0.8249 }, gamma: [2.2, 1.8, 1], matrix } });
    expect(resolveText('[/CalGray<</WhitePoint[0.9642 1 0.8249]/Gamma 2.2>>]')).toStrictEqual({
      kind: 'gray',
      source: { kind: 'calGray', whitePoint: { x: 0.9642, y: 1, z: 0.8249 }, gamma: 2.2 },
    });
  });

  it('keeps CalGray untouched when gray sources are kept', () => {
    expect(resolveText('[/CalGray<</WhitePoint[0.9505 1 1.089]/Gamma 2.2>>]', { options: { iccGray: 'keep' } })).toStrictEqual({ kind: 'untouched' });
  });

  it('converts ICCBased gray by default and can keep it', () => {
    const { document, resources } = context();
    const value = iccSpace(document, gray.bytes, 1);
    expect(resolveIn({ document, resources }, value)).toStrictEqual({ kind: 'gray', source: { kind: 'icc', profile: gray } });
    expect(resolveIn({ document, resources }, value, { iccGray: 'keep' })).toStrictEqual({ kind: 'untouched' });
  });

  it('resolves Indexed RGB lookup bytes without changing its indices', () => {
    const test = context();
    const lookup = Uint8Array.of(0, 0, 0, 255, 128, 64);
    const indexed = pdfArray([pdfName('Indexed'), pdfName('DeviceRGB'), pdfInteger(1), pdfString(lookup)]);
    expect(resolveIn(test, indexed)).toMatchObject({ kind: 'indexed', hival: 1, lookup, base: { kind: 'rgb' } });
  });

  it('keeps Separation colorant bytes opaque', () => {
    const { document, resources } = context();
    const name = pdfNameFromBytes(Uint8Array.of(0x82, 0x62, 0x82, 0x74, 0x82, 0x73));
    const separation = pdfArray([pdfName('Separation'), name, pdfName('DeviceRGB'), pdfDictionary()]);
    const resolved = specialSpace(resolveIn({ document, resources }, separation));
    expect(resolved.kind).toBe('separation');
    expect(resolved.names[0]).toStrictEqual(name.bytes);
    const deviceN = pdfArray([pdfName('DeviceN'), pdfArray([name, pdfName('Black')]), pdfName('DeviceRGB'), pdfDictionary()]);
    expect(specialSpace(resolveIn({ document, resources }, deviceN)).names).toStrictEqual([name.bytes, pdfName('Black').bytes]);
  });

  it('resolves 32 levels of named colour-space resources and refuses a 33rd', () => {
    expect(resolveText('/C0', { resources: chain(32) })).toStrictEqual({ kind: 'deviceGray' });
    expect(() => resolveText('/C0', { resources: chain(33) })).toThrow(ResourceLimitError);
  });

  it.each([
    { hival: 0, lookup: '<000000>' },
    { hival: 255, lookup: `<${'00'.repeat(768)}>` },
  ])('accepts Indexed hival $hival', ({ hival, lookup }) => {
    expect(resolveText(`[/Indexed/DeviceGray ${String(hival)} ${lookup}]`)).toMatchObject({ kind: 'indexed', hival, base: { kind: 'deviceGray' } });
  });

  it.each(['-1', '256', '1.5', '(1)'])('refuses Indexed hival %s', hival => {
    // ISO 32000-1:2008, 8.6.6.3: hival is an integer from 0 to 255.
    expect(() => resolveText(`[/Indexed/DeviceGray ${hival} <0000>]`)).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
  });

  it('reads an Indexed lookup stream through its filter and refuses a lookup of another type', () => {
    const lookup = Uint8Array.of(0, 0, 0, 255, 128, 64);
    const stream = { number: 12, body: streamBody('/Filter/FlateDecode', latin1Text(deflateZlib(lookup))) };
    expect(resolveText('[/Indexed/DeviceRGB 1 12 0 R]', { extra: [stream] })).toStrictEqual({
      kind: 'indexed',
      base: { kind: 'rgb', source: { kind: 'icc', profile: fallback } },
      hival: 1,
      lookup,
    });
    expect(() => resolveText('[/Indexed/DeviceRGB 1 7]')).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
  });

  it.each([
    { space: '/Missing', what: 'a missing named resource' },
    { space: '[/DeviceXYZ]', what: 'an unknown family' },
    { space: '7', what: 'a number' },
    { space: '[(CalRGB)]', what: 'a family that is not a name' },
  ])('refuses $what', ({ space }) => {
    expect(() => resolveText(space)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
  });

  it.each([
    { full: '/DeviceRGB', short: '/RGB', expected: { kind: 'rgb', source: { kind: 'icc', profile: fallback } } },
    { full: '/DeviceGray', short: '/G', expected: { kind: 'deviceGray' } },
    { full: '/DeviceCMYK', short: '/CMYK', expected: { kind: 'untouched' } },
    {
      full: '[/Indexed/DeviceRGB 0 <ff0000>]',
      short: '[/I/RGB 0 <ff0000>]',
      expected: { kind: 'indexed', base: { kind: 'rgb', source: { kind: 'icc', profile: fallback } }, hival: 0, lookup: Uint8Array.of(255, 0, 0) },
    },
  ])('resolves the abbreviation $short like $full', ({ full, short, expected }) => {
    // ISO 32000-1:2008, 8.9.7 Table 93: inline images abbreviate these names.
    expect([resolveText(short), resolveText(full)]).toStrictEqual([expected, expected]);
  });

  it.each(['/Lab', '[/Lab<</WhitePoint[0.9505 1 1.089]>>]'])('leaves %s untouched', space => {
    expect(resolveText(space)).toStrictEqual({ kind: 'untouched' });
  });

  it('refuses an ICCBased N that disagrees with the profile and a profile that is not a stream', () => {
    const disagreeing = { number: 12, body: streamBody('/N 3', latin1Text(gray.bytes)) };
    const agreeing = { number: 12, body: streamBody('/N 1', latin1Text(gray.bytes)) };
    expect(() => resolveText('[/ICCBased 12 0 R]', { extra: [disagreeing] })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
    expect(() => resolveText('[/ICCBased 12 0 R]', { extra: [{ number: 12, body: '<</N 1>>' }] })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
    expect(resolveText('[/ICCBased 12 0 R]', { extra: [agreeing] })).toStrictEqual({ kind: 'gray', source: { kind: 'icc', profile: gray } });
  });

  it('leaves an ICCBased CMYK profile untouched', async () => {
    const cmyk = { number: 12, body: streamBody('/N 4', latin1Text(await fixture('fogra28l.icc'))) };
    expect(resolveText('[/ICCBased 12 0 R]', { extra: [cmyk] })).toStrictEqual({ kind: 'untouched' });
  });

  it('falls back to the caller profile when DefaultRGB is DeviceRGB itself', () => {
    expect(resolveText('/DeviceRGB', { resources: '<</ColorSpace<</DefaultRGB/DeviceRGB>>>>' })).toStrictEqual({
      kind: 'rgb',
      source: { kind: 'icc', profile: fallback },
    });
  });

  it('resolves the underlying space of an uncoloured Pattern space', () => {
    // ISO 32000-1:2008, 8.6.6.2: the second element of a Pattern array is the underlying colour space.
    expect(resolveText('[/Pattern/DeviceRGB]')).toStrictEqual({ kind: 'pattern', underlying: { kind: 'rgb', source: { kind: 'icc', profile: fallback } } });
    expect(resolveText('/Pattern')).toStrictEqual({ kind: 'pattern' });
  });

  it.each([
    { space: '[/Separation (Spot) /DeviceRGB<<>>]', what: 'a Separation colorant that is not a name' },
    { space: '[/DeviceN /Spot /DeviceRGB<<>>]', what: 'DeviceN names that are not an array' },
    { space: '[/DeviceN [/Spot 1] /DeviceRGB<<>>]', what: 'a DeviceN entry that is not a name' },
    { space: '[/Separation /Spot /DeviceRGB]', what: 'a missing tint transform' },
  ])('refuses $what', ({ space }) => {
    expect(() => resolveText(space)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
  });

  it.each([
    { space: '[/CalRGB[0.9505 1 1.089]]', what: 'parameters that are not a dictionary' },
    { space: '[/CalGray<<>>]', what: 'no WhitePoint' },
    { space: '[/CalGray<</WhitePoint[0.9505 1]>>]', what: 'a two-number WhitePoint' },
    { space: '[/CalRGB<</WhitePoint[0.9505 1 1.089 1]>>]', what: 'a four-number WhitePoint' },
    { space: '[/CalRGB<</WhitePoint[0.9505 /One 1.089]>>]', what: 'a WhitePoint with a name in it' },
  ])('refuses a calibrated space with $what', ({ space }) => {
    // ISO 32000-1:2008, 8.6.5.2 Table 63: WhitePoint is a required array of three numbers.
    expect(() => resolveText(space)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
  });
});

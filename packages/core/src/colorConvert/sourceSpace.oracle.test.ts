import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { SourceSpace, SourceSpaceOptions } from './sourceSpace.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfNameFromBytes, pdfReal, pdfString } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { resolveSourceSpace } from './sourceSpace.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const fallback = parseIccProfile(await fixture('sRGB.icm'));
const alternate = parseIccProfile(await fixture('DisplayP3-v4.icc'));
const grayProfile = (): Uint8Array => {
  const bytes = new Uint8Array(160);
  const view = new DataView(bytes.buffer);
  const signature = (offset: number, name: string): void => {
    for (let index = 0; index < name.length; index++) bytes[offset + index] = name.codePointAt(index) ?? 0;
  };
  view.setUint32(0, bytes.length);
  bytes[8] = 4;
  signature(12, 'scnr');
  signature(16, 'GRAY');
  signature(20, 'XYZ ');
  signature(36, 'acsp');
  view.setUint32(64, 1);
  view.setInt32(68, Math.round(0.9642 * 65536));
  view.setInt32(72, 65536);
  view.setInt32(76, Math.round(0.8249 * 65536));
  view.setUint32(128, 1);
  signature(132, 'kTRC');
  view.setUint32(136, 144);
  view.setUint32(140, 16);
  signature(144, 'curv');
  view.setUint32(152, 1);
  view.setUint16(156, 0x0233);
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
  if (space.kind !== 'rgb') throw new Error('expected RGB');
  return space;
};

const specialSpace = (space: SourceSpace): Extract<SourceSpace, { kind: 'separation' | 'deviceN' }> => {
  if (space.kind !== 'separation' && space.kind !== 'deviceN') throw new Error('expected Separation or DeviceN');
  return space;
};

const iccSpace = (document: ReturnType<typeof loadDocument>, bytes: Uint8Array, channels: number): ReturnType<typeof pdfArray> => {
  const reference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('N').bytes, pdfInteger(channels)]]), data: bytes });
  return pdfArray([pdfName('ICCBased'), reference]);
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

  it('resolves calibrated RGB and gray sources', () => {
    const { document, resources } = context();
    const white = pdfArray([pdfReal(0.9505), pdfInteger(1), pdfReal(1.089)]);
    const parameters = pdfDictionary(new PdfDictionaryEntries([[pdfName('WhitePoint').bytes, white]]));
    const rgb = resolveIn({ document, resources }, pdfArray([pdfName('CalRGB'), parameters]));
    const graySpace = resolveIn({ document, resources }, pdfArray([pdfName('CalGray'), parameters]));
    expect(rgb).toMatchObject({ kind: 'rgb', source: { kind: 'calRGB', gamma: [1, 1, 1] } });
    expect(graySpace).toMatchObject({ kind: 'gray', source: { kind: 'calGray', gamma: 1 } });
  });

  it('converts ICCBased gray by default and can keep it', () => {
    const { document, resources } = context();
    const value = iccSpace(document, gray.bytes, 1);
    expect(resolveIn({ document, resources }, value).kind).toBe('gray');
    expect(resolveIn({ document, resources }, value, { iccGray: 'keep' }).kind).toBe('untouched');
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
});

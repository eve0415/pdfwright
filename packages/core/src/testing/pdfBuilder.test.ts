import { describe, expect, it } from 'vitest';

import { buildPdf, latin1Bytes, latin1Text, streamBody } from './pdfBuilder.ts';

const CATALOG = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const PAGES = { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' };

describe('Latin-1 text and bytes', () => {
  it('maps every byte to the character of the same code and back', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => 255 - index);
    const text = latin1Text(bytes);
    expect([text.length, text.codePointAt(0), text.codePointAt(255)]).toStrictEqual([256, 0xff, 0]);
    expect(latin1Bytes(text)).toStrictEqual(bytes);
  });

  it.each([
    ['the first character above Latin-1', 'Ā'],
    ['an en dash', 'a–b'],
    ['an astral character', 'x\u{1F600}'],
  ])('refuses %s', (_, text) => {
    expect(() => latin1Bytes(text)).toThrow(RangeError);
  });

  it('writes a Latin-1 stream body with a Length that counts its bytes, and refuses a body it cannot write', () => {
    const pdf = buildPdf([{ xref: 'classic', objects: [CATALOG, PAGES, { number: 3, body: streamBody('', 'été') }], trailer: '/Root 1 0 R' }]);
    expect([pdf.bytes.length, pdf.text.includes('/Length 3>>\nstream\nété\nendstream')]).toStrictEqual([pdf.text.length, true]);
    expect(() => buildPdf([{ xref: 'classic', objects: [CATALOG, PAGES, { number: 3, body: streamBody('', '–') }] }])).toThrow(RangeError);
  });
});

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

describe('sections the builder refuses', () => {
  const member = { number: 4, body: '(member)' };
  it.each([
    ['object streams under a classic table', { xref: 'classic', objects: [CATALOG], objectStreams: [{ number: 3, members: [member] }] }],
    ['object number 0', { xref: 'classic', objects: [{ number: 0, body: 'null' }] }],
    ['a fractional object number', { xref: 'classic', objects: [{ number: 1.5, body: 'null' }] }],
    ['a generation above 65535', { xref: 'classic', objects: [{ number: 1, generation: 65_536, body: 'null' }] }],
    ['a negative generation', { xref: 'stream', objects: [{ number: 1, generation: -1, body: 'null' }] }],
    ['an object-stream member numbered 0', { xref: 'stream', objects: [CATALOG], objectStreams: [{ number: 3, members: [{ number: 0, body: 'null' }] }] }],
    ['a cross-reference stream numbered like an object', { xref: 'stream', objects: [CATALOG, PAGES], xrefStreamNumber: 2 }],
    [
      'a cross-reference stream numbered like an object-stream member',
      { xref: 'stream', objects: [CATALOG], objectStreams: [{ number: 3, members: [member] }], xrefStreamNumber: 4 },
    ],
    ['a cross-reference stream number on a classic section', { xref: 'classic', objects: [CATALOG], xrefStreamNumber: 9 }],
    ['a cross-reference stream numbered 0', { xref: 'stream', objects: [CATALOG], xrefStreamNumber: 0 }],
  ] as const)('refuses %s', (_, section) => {
    expect(() => buildPdf([section])).toThrow(RangeError);
  });

  it('accepts generation 65535, a number repeated within a section, and a later section reusing the stream number', () => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [CATALOG, { number: 9, generation: 65_535, body: '(free soon)' }],
        objectStreams: [{ number: 3, members: [{ number: 9, body: '(member)' }] }],
        xrefStreamNumber: 10,
      },
      { xref: 'stream', objects: [{ number: 10, body: '(reused)' }], xrefStreamNumber: 11 },
    ]);
    expect(pdf.text.includes('9 65535 obj\n(free soon)\nendobj')).toBe(true);
    expect(pdf.offsets.get(10)).toBe(pdf.text.lastIndexOf('10 0 obj\n(reused)'));
  });
});

import type { TestSection } from './pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { pdfReference } from '../object/pdfObject.ts';

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

// An original classic section, a stream update with an object stream, and a hybrid update whose stream indexes a member the classic table omits.
const ORIGINAL = { xref: 'classic', objects: [CATALOG, PAGES, { number: 3, body: '(three)' }], trailer: '/Root 1 0 R' } as const satisfies TestSection;
const STREAM_UPDATE = {
  xref: 'stream',
  objects: [{ number: 3, generation: 1, body: '(three again)' }],
  objectStreams: [
    {
      number: 5,
      members: [
        { number: 4, body: '(four)' },
        { number: 6, body: '[6]' },
      ],
    },
  ],
  trailer: '/Root 1 0 R',
} as const satisfies TestSection;
const HYBRID_UPDATE = {
  xref: 'hybrid',
  objects: [{ number: 7, body: '(seven)' }],
  objectStreams: [{ number: 8, members: [{ number: 9, body: '(nine)' }] }],
  trailer: '/Root 1 0 R',
} as const satisfies TestSection;
const CHAIN = [ORIGINAL, STREAM_UPDATE, HYBRID_UPDATE];

describe('built files', () => {
  const pdf = buildPdf(CHAIN, { prefix: 'JUNK', header: '%PDF-1.5' });

  it('records the offset of the newest copy of each top-level object', () => {
    expect([...pdf.offsets.keys()].toSorted((left, right) => left - right)).toStrictEqual([1, 2, 3, 5, 7, 8]);
    const headers = [...pdf.offsets].map(([number, offset]) => [number, pdf.text.slice(offset, pdf.text.indexOf('\n', offset))]);
    expect(headers.toSorted(([left], [right]) => Number(left) - Number(right))).toStrictEqual([
      [1, '1 0 obj'],
      [2, '2 0 obj'],
      [3, '3 1 obj'],
      [5, '5 0 obj'],
      [7, '7 0 obj'],
      [8, '8 0 obj'],
    ]);
  });

  it('records each section offset, links each to the one before and ends with a startxref to the newest', () => {
    const [classic, stream, hybrid] = pdf.sections;
    expect(pdf.sections).toHaveLength(3);
    expect([
      pdf.text.startsWith('xref\n', classic),
      /^\d+ 0 obj\n<<\/Type\/XRef\//u.test(pdf.text.slice(stream)),
      pdf.text.startsWith('xref\n', hybrid),
    ]).toStrictEqual([true, true, true]);
    const trailers = [...pdf.text.matchAll(/\/Prev (\d+)/gu)].map(match => Number(match[1]));
    expect(trailers).toStrictEqual([classic, stream]);
    const startxrefs = [...pdf.text.matchAll(/startxref\n(\d+)\n%%EOF\n/gu)].map(match => Number(match[1]));
    expect(startxrefs).toStrictEqual([classic, stream, hybrid]);
    expect(pdf.text.endsWith(`startxref\n${String(hybrid)}\n%%EOF\n`)).toBe(true);
  });

  // The library tolerates a Prev chain that switches between classic and stream sections only with a warning, so each chain stays on one side.
  it.each([
    [
      'a classic section and a hybrid update',
      [ORIGINAL, HYBRID_UPDATE],
      ['classic', 'classic'],
      [
        [3, 0, 'string'],
        [7, 0, 'string'],
        [9, 0, 'string'],
      ],
      11,
    ],
    [
      'a stream section and a stream update with an object stream',
      [{ ...ORIGINAL, xref: 'stream' }, STREAM_UPDATE],
      ['stream', 'stream'],
      [
        [3, 1, 'string'],
        [4, 0, 'string'],
        [6, 0, 'array'],
      ],
      9,
    ],
  ] as const)('loads %s intact, members included, with Size one above the highest number, its streams included', (_, sections, kinds, references, size) => {
    const built = buildPdf(sections);
    const document = loadDocument(built.bytes);
    expect([document.structure.status, document.warnings, document.structure.sections.map(section => section.kind), built.size]).toStrictEqual([
      'intact',
      [],
      kinds,
      size,
    ]);
    expect(references.map(([number, generation]) => [number, generation, document.get(pdfReference(number, generation)).kind])).toStrictEqual(references);
  });
});

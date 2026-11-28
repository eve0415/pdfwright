import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { Descriptor } from './fontDescriptor.ts';
import type { FontSource } from './fontValues.ts';

import { describe, expect, it } from 'vitest';

import { pdfName } from '../object/pdfObject.ts';

import { readDescriptor, verticalExtent } from './fontDescriptor.ts';
import { objectIn } from './testing/fontDocument.ts';

const FONT_BBOX = pdfName('FontBBox').bytes;

// The entries of a dictionary written as object 10, with the document that holds it.
const entriesIn = (body: string): { readonly document: FontSource; readonly entries: PdfDictionaryEntries } => {
  const { document, object } = objectIn(body);
  if (object.kind !== 'dictionary') {
    throw new Error('object 10 is not a dictionary');
  }
  return { document, entries: object.entries };
};

const descriptorOf = (font: string): Omit<Descriptor, 'dictionary'> => {
  const { document, entries } = entriesIn(font);
  const { symbolic, nonsymbolic, missingWidth } = readDescriptor(document, entries);
  return { symbolic, nonsymbolic, missingWidth };
};

describe('font descriptors', () => {
  it.each([
    { flags: 4, symbolic: true, nonsymbolic: false },
    { flags: 32, symbolic: false, nonsymbolic: true },
    { flags: 36, symbolic: true, nonsymbolic: true },
    // Bits 2, 4, 5 and 7: Serif, Script, a reserved bit and Italic.
    { flags: 90, symbolic: false, nonsymbolic: false },
  ])('reads Flags $flags as symbolic $symbolic and nonsymbolic $nonsymbolic', ({ flags, symbolic, nonsymbolic }) => {
    // ISO 32000-1:2008, Table 123: bit 3 is Symbolic and bit 6 Nonsymbolic, bit 1 being the low-order bit.
    expect(descriptorOf(`<</FontDescriptor<</Flags ${String(flags)}/MissingWidth 250>>>>`)).toStrictEqual({ symbolic, nonsymbolic, missingWidth: 250 });
  });

  it('gives a font without a descriptor no flags and a MissingWidth of 0', () => {
    // Table 122, MissingWidth: "Default value: 0."
    expect(descriptorOf('<</Type/Font>>')).toStrictEqual({ symbolic: false, nonsymbolic: false, missingWidth: 0 });
  });

  it.each([
    {
      label: 'Ascent above Descent',
      descriptor: '/Ascent 700/Descent -200/FontBBox[0 -300 1000 900]',
      fontBBox: undefined,
      extent: { descent: -200, ascent: 700, estimated: false },
    },
    {
      label: 'Ascent below Descent',
      descriptor: '/Ascent -10/Descent 0/FontBBox[0 -300 1000 900]',
      fontBBox: undefined,
      extent: { descent: -300, ascent: 900, estimated: false },
    },
    {
      label: 'Ascent equal to Descent',
      descriptor: '/Ascent 0/Descent 0/FontBBox[0 900 1000 -300]',
      fontBBox: undefined,
      extent: { descent: -300, ascent: 900, estimated: false },
    },
    { label: 'Ascent without Descent', descriptor: '/Ascent 700', fontBBox: undefined, extent: { descent: -200, ascent: 800, estimated: true } },
    { label: 'an all-zero FontBBox', descriptor: '/FontBBox[0 0 0 0]', fontBBox: undefined, extent: { descent: -200, ascent: 800, estimated: true } },
    {
      label: 'a FontBBox with no height',
      descriptor: '/FontBBox[0 100 1000 100]',
      fontBBox: undefined,
      extent: { descent: -200, ascent: 800, estimated: true },
    },
    {
      label: 'a FontBBox of three numbers',
      descriptor: '/FontBBox[0 -300 1000]',
      fontBBox: undefined,
      extent: { descent: -200, ascent: 800, estimated: true },
    },
    {
      label: "a degenerate FontBBox and the font's own",
      descriptor: '/FontBBox[0 0 0 0]',
      fontBBox: '[0 -100 500 600]',
      extent: { descent: -100, ascent: 600, estimated: false },
    },
  ])('takes the vertical extent of a descriptor with $label', ({ descriptor, fontBBox, extent }) => {
    // Table 122, Ascent and Descent; 7.9.5: a rectangle gives "a pair of diagonally opposite corners".
    const { document, entries } = entriesIn(`<<${descriptor}>>`);
    const ownBBox = fontBBox === undefined ? undefined : entriesIn(`<</FontBBox${fontBBox}>>`).entries.get(FONT_BBOX);
    expect(verticalExtent(document, entries, ownBBox)).toStrictEqual(extent);
  });
});

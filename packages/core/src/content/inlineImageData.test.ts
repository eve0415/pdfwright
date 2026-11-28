import type { PdfDirectObject } from '../object/pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { pdfName } from '../object/pdfObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

import { inlineImageData } from './inlineImageData.ts';

const integer = (value: number): PdfDirectObject => ({ kind: 'integer', value });

const quiet = (): void => {
  // Lexer warnings do not matter to these tests.
};

// Reads the data after the first ID in the text and returns it with the text that follows EI.
const read = (text: string, parameters: ReadonlyArray<PdfDirectObject>): readonly [string, string] => {
  const bytes = latin1Bytes(text);
  const lexer = new Lexer({ bytes, base: 0, final: true }, 0, { warn: quiet, names: new Map() });
  lexer.seek(text.indexOf('ID') + 2);
  const data = inlineImageData(lexer, parameters);
  return [latin1Text(data), latin1Text(bytes.subarray(lexer.position))];
};

const image = (width: number, height: number, bits: number, space = 'G'): Array<PdfDirectObject> => [
  pdfName('W'),
  integer(width),
  pdfName('H'),
  integer(height),
  pdfName('BPC'),
  integer(bits),
  pdfName('CS'),
  pdfName(space),
];

const gray = (width: number, height: number, bits: number): Array<PdfDirectObject> => image(width, height, bits);

describe('inline image data', () => {
  it('measures unfiltered data from width, height, components and bits, so EI inside the samples does not end it', () => {
    expect(read('ID\nA EI B EI Q', gray(6, 1, 8))).toStrictEqual(['A EI B', ' Q']);
  });

  it('pads each sample row to a whole byte', () => {
    expect(read('ID\n EI \nEI Q', gray(3, 4, 1))).toStrictEqual([' EI ', ' Q']);
  });

  it('scans for EI between white space when the data is filtered or its length does not end at EI', () => {
    const filtered = [pdfName('F'), pdfName('AHx'), ...gray(6, 1, 8)];
    expect([read('ID\nA EI B EI Q', filtered), read('ID\nA EI B EI Q', gray(2, 1, 8))]).toStrictEqual([
      ['A', ' B EI Q'],
      ['A', ' B EI Q'],
    ]);
  });

  it('keeps the first data byte when no white space follows ID', () => {
    expect(read('ID<~9j~> EI', [pdfName('F'), pdfName('A85')])).toStrictEqual(['<~9j~>', '']);
  });

  it('takes the rest of the content as data when no EI follows', () => {
    expect(read('ID\nABC', gray(6, 1, 8))).toStrictEqual(['ABC', '']);
  });

  // ISO 32000-1:2008, 8.9.7, Table 93 gives each key in full and abbreviated, and Table 94 the colour space abbreviations.
  it.each([
    [
      'full key names',
      'ID\nA EI B EI Q',
      [pdfName('Width'), integer(6), pdfName('Height'), integer(1), pdfName('BitsPerComponent'), integer(8), pdfName('ColorSpace'), pdfName('DeviceGray')],
      ['A EI B', ' Q'],
    ],
    ['three RGB components', 'ID\nA EI B EI Q', image(2, 1, 8, 'RGB'), ['A EI B', ' Q']],
    ['four CMYK components', 'ID\nAB EI CD EI Q', image(2, 1, 8, 'CMYK'), ['AB EI CD', ' Q']],
    // Table 93, BitsPerComponent: "If ImageMask is true, this entry is optional, but if specified, its value shall be 1".
    [
      'an image mask without BPC, one bit per sample',
      'ID\n EI EI Q',
      [pdfName('W'), integer(24), pdfName('H'), integer(1), pdfName('IM'), { kind: 'boolean', value: true }],
      [' EI', ' Q'],
    ],
  ] as const)('measures the data from %s', (_, text, parameters, expected) => {
    expect(read(text, parameters)).toStrictEqual(expected);
  });

  // Each set of parameters, if it were measured, would end the data exactly at an EI that the scan for EI passes over.
  it.each([
    ['an odd number of parameters', 'ID\nA EI B EI Q', [...gray(6, 1, 8), pdfName('D')], ['A', ' B EI Q']],
    ['3 bits per component', 'ID\nA EI B EI Q', gray(16, 1, 3), ['A', ' B EI Q']],
    ['a colour space resource name', 'ID\nA EI B EI Q', image(6, 1, 8, 'R0'), ['A', ' B EI Q']],
    ['a width of 0', 'ID\n \nEI Q', gray(0, 1, 8), [' ', ' Q']],
    ['a height of 0', 'ID\n \nEI Q', gray(6, 0, 8), [' ', ' Q']],
    ['negative width and height', 'ID\nA EI B EI Q', gray(-6, -1, 8), ['A', ' B EI Q']],
  ] as const)('scans for EI when the parameters have %s', (_, text, parameters, expected) => {
    expect(read(text, parameters)).toStrictEqual(expected);
  });

  it('scans for EI when the measured data is not followed by white space and EI', () => {
    expect(read('ID\nA EI BEI Q', gray(6, 1, 8))).toStrictEqual(['A', ' BEI Q']);
  });
});

const COMPONENTS = { G: 1, RGB: 3, CMYK: 4 } as const;

describe('properties', () => {
  it('returns the samples of an unfiltered image whatever bytes they hold, and stops after its EI', () => {
    const shape = fc.record({
      width: fc.integer({ min: 1, max: 16 }),
      height: fc.integer({ min: 1, max: 16 }),
      bits: fc.constantFrom(1, 2, 4, 8, 16),
      space: fc.constantFrom('G', 'RGB', 'CMYK'),
    });
    const sampled = shape.chain(({ width, height, bits, space }) =>
      fc
        .array(fc.constantFrom('E', 'I', ' ', '\n', 'A', '\u0000', '\u00FF'), {
          minLength: Math.ceil((width * COMPONENTS[space] * bits) / 8) * height,
          maxLength: Math.ceil((width * COMPONENTS[space] * bits) / 8) * height,
        })
        .map(samples => ({ parameters: image(width, height, bits, space), samples: samples.join('') })),
    );
    fc.assert(
      fc.property(sampled, ({ parameters, samples }) => {
        expect(read(`ID\n${samples}\nEI Q`, parameters)).toStrictEqual([samples, ' Q']);
      }),
    );
  });
});

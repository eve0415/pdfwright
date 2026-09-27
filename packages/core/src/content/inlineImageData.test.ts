import type { PdfDirectObject } from '../object/pdfObject.ts';

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
const read = (text: string, parameters: readonly PdfDirectObject[]): readonly [string, string] => {
  const bytes = latin1Bytes(text);
  const lexer = new Lexer({ bytes, base: 0, final: true }, 0, { warn: quiet, names: new Map() });
  lexer.seek(text.indexOf('ID') + 2);
  const data = inlineImageData(lexer, parameters);
  return [latin1Text(data), latin1Text(bytes.subarray(lexer.position))];
};

const gray = (width: number, height: number, bits: number): PdfDirectObject[] => [
  pdfName('W'),
  integer(width),
  pdfName('H'),
  integer(height),
  pdfName('BPC'),
  integer(bits),
  pdfName('CS'),
  pdfName('G'),
];

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
});

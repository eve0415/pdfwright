import { describe, expect, it } from 'vitest';

import { mm } from '../length/length.ts';
import { pdfInteger, pdfName, pdfReal } from '../object/pdfObject.ts';

import { numberOf, withoutSubsetTag } from './fontValues.ts';

describe('font values', () => {
  it.each([
    ['ABCDEF+Name', 'Name'],
    ['ABCDEf+Name', 'ABCDEf+Name'],
    ['ABCDE+Name', 'ABCDE+Name'],
    ['ABCDEFG+Name', 'ABCDEFG+Name'],
    ['ABCDEF-Name', 'ABCDEF-Name'],
    ['xABCDEF+Name', 'xABCDEF+Name'],
  ])('reads the font name %s without its subset tag as %s', (name, expected) => {
    // ISO 32000-1:2008, 9.6.4: "The tag shall consist of exactly six uppercase letters", followed by a plus sign.
    expect(withoutSubsetTag(name)).toBe(expected);
  });

  it('reads integers and reals as numbers, dividing out the exact rational a created document holds', () => {
    expect([numberOf(pdfInteger(3)), numberOf(pdfReal(0.5)), numberOf(pdfReal(mm(1))), numberOf(pdfName('A')), numberOf(undefined)]).toStrictEqual([
      3,
      0.5,
      360 / 127,
      undefined,
      undefined,
    ]);
  });
});

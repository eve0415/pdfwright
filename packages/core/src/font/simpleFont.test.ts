import type { FontSubtype } from './fontModel.ts';
import type { SimpleWidths } from './simpleFont.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readDescriptor } from './fontDescriptor.ts';
import { simpleWidths } from './simpleFont.ts';
import { objectIn } from './testing/fontDocument.ts';

// The widths of a simple font dictionary written as object 10.
const widthsOf = (body: string, subtype: FontSubtype): SimpleWidths => {
  const { document, object } = objectIn(body);
  if (object.kind !== 'dictionary') {
    throw new Error('object 10 is not a dictionary');
  }
  return simpleWidths({ source: document, font: object.entries, subtype, descriptor: readDescriptor(document, object.entries) });
};

describe('properties', () => {
  const layout = fc.record({
    first: fc.integer({ min: 0, max: 255 }),
    widths: fc.array(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 40 }),
    lastChar: fc.boolean(),
    subtype: fc.constantFrom<FontSubtype>('Type1', 'TrueType', 'Type3'),
  });

  it('takes each code from FirstChar to LastChar from Widths, and the rest from MissingWidth, or 0 in a Type 3 font', () => {
    fc.assert(
      fc.property(layout, ({ first, widths, lastChar, subtype }) => {
        // Table 111, Widths: "The first element in the array shall be the width of the glyph for the character code that equals FirstChar"; outside FirstChar to LastChar, MissingWidth; Table 112 gives a Type 3 font 0 there.
        const last = first + widths.length - 1;
        const entries = `/FirstChar ${String(first)}${lastChar ? `/LastChar ${String(last)}` : ''}/Widths[${widths.join(' ')}]/FontDescriptor<</MissingWidth 250>>`;
        const read = widthsOf(`<<${entries}>>`, subtype);
        const outside = subtype === 'Type3' ? 0 : 250;
        const codes = Array.from({ length: 256 }, (_, code) => code);
        expect(codes.map(code => read?.(code))).toStrictEqual(codes.map(code => (code >= first && code <= last ? widths[code - first] : outside)));
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';

import { annotationFlags } from './annotationFlags.ts';

describe('annotation flags', () => {
  it('reads Hidden from bit 2 and Print from bit 3', () => {
    const flags = [0, 2, 4, 6, 1, 5, 0xff_ff_ff_fb].map(value => annotationFlags({ kind: 'integer', value }));
    expect(flags).toStrictEqual([
      { hidden: false, print: false, printable: false },
      { hidden: true, print: false, printable: false },
      { hidden: false, print: true, printable: true },
      { hidden: true, print: true, printable: false },
      { hidden: false, print: false, printable: false },
      { hidden: false, print: true, printable: true },
      { hidden: true, print: false, printable: false },
    ]);
  });

  it('reads an absent or non-integer F as no flags and a negative one as its 32-bit pattern', () => {
    expect([annotationFlags(), annotationFlags({ kind: 'real', value: 4 }), annotationFlags({ kind: 'integer', value: -3 })]).toStrictEqual([
      { hidden: false, print: false, printable: false },
      { hidden: false, print: false, printable: false },
      { hidden: false, print: true, printable: true },
    ]);
  });
  // ISO 32000-1:2008, 12.5.3: the flag word is a 32-bit integer, so an integer beyond 32 bits is read by its low 32 bits.
  it.each([
    { value: 2 ** 31, hidden: false, print: false },
    { value: 2 ** 32 - 1, hidden: true, print: true },
    { value: 2 ** 32 + 4, hidden: false, print: true },
    { value: -(2 ** 32) + 2, hidden: true, print: false },
    { value: -(2 ** 32) - 4, hidden: false, print: true },
  ])('reads $value by its low 32 bits', ({ value, hidden, print }) => {
    expect(annotationFlags({ kind: 'integer', value })).toStrictEqual({ hidden, print, printable: print && !hidden });
  });
});

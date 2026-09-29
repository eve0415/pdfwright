import { describe, expect, it } from 'vitest';

import { annotationFlags } from './annotationFlags.ts';

describe('annotation flags', () => {
  it('reads Hidden from bit 2 and Print from bit 3', () => {
    const flags = [0, 2, 4, 6, 1, 5, 0xfffffffb].map(value => annotationFlags({ kind: 'integer', value }));
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
});

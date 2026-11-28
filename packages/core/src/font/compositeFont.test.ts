import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cidVertical, cidWidths } from './compositeFont.ts';
import { objectIn } from './testing/fontDocument.ts';

// A CIDFont dictionary written as object 10, with its document.
const cidFont = (body: string): Parameters<typeof cidWidths> => {
  const { document, object } = objectIn(body);
  if (object.kind !== 'dictionary') {
    throw new Error('object 10 is not a dictionary');
  }
  return [document, object.entries];
};

describe('CIDFont metrics', () => {
  it('reads both W forms, a range of one CID and DW', () => {
    // ISO 32000-1:2008, 9.7.4.3: "c [ w1 w2 … wn ]" and "cfirst clast w"; DW applies to the CIDs W does not list.
    const widths = cidWidths(...cidFont('<</W[120[400 325 500] 7080 8032 1000 9000 9000 900]/DW 600>>'));
    expect([119, 120, 121, 122, 123, 7079, 7080, 8032, 8033, 9000, 9001].map(cid => widths(cid))).toStrictEqual([
      600, 400, 325, 500, 600, 600, 1000, 1000, 600, 900, 600,
    ]);
  });

  it('reads both W2 forms, each metric as w1, then the position vector', () => {
    // 9.7.4.3: W2 gives "the vertical component of the vertical displacement vector w1 … followed by the horizontal and vertical components for the position vector v".
    const vertical = cidVertical(...cidFont('<</W2[1[-1000 250 772 -900 300 800] 10 20 -950 500 880]>>'));
    expect([vertical(1, 600), vertical(2, 600), vertical(3, 600), vertical(15, 600)]).toStrictEqual([
      { w1: -1000, vx: 250, vy: 772 },
      { w1: -900, vx: 300, vy: 800 },
      { w1: -1000, vx: 300, vy: 880 },
      { w1: -950, vx: 500, vy: 880 },
    ]);
  });
});

describe('properties', () => {
  // Disjoint groups of consecutive CIDs, each written in the `c [w1 … wn]` form or the `cfirst clast w` form.
  const group = fc.record({
    gap: fc.integer({ min: 0, max: 5 }),
    widths: fc.array(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 6 }),
    range: fc.boolean(),
  });

  it('gives each CID the width its W group gives, and DW to the others', () => {
    fc.assert(
      fc.property(fc.array(group, { maxLength: 30 }), fc.integer({ min: 0, max: 2000 }), (groups, dw) => {
        // 9.7.4.3: "c [ w1 w2 … wn ]" gives CIDs c to c + n − 1 their widths; "cfirst clast w" gives every CID from cfirst to clast the width w.
        const expected = new Map<number, number>();
        const written: Array<string> = [];
        let next = 0;
        for (const { gap, widths, range } of groups) {
          const first = next + gap;
          const [width = 0] = widths;
          const spread = range ? widths.map(() => width) : widths;
          for (const [index, value] of spread.entries()) {
            expected.set(first + index, value);
          }
          written.push(range ? `${String(first)} ${String(first + widths.length - 1)} ${String(width)}` : `${String(first)}[${widths.join(' ')}]`);
          next = first + widths.length;
        }
        const read = cidWidths(...cidFont(`<</W[${written.join(' ')}]/DW ${String(dw)}>>`));
        const cids = Array.from({ length: next + 2 }, (_, cid) => cid);
        expect(cids.map(cid => read(cid))).toStrictEqual(cids.map(cid => expected.get(cid) ?? dw));
      }),
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { deltaE2000 } from './deltaE2000.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

// Sharma, Wu and Dalal, "The CIEDE2000 color-difference formula: implementation notes, supplementary test data, and mathematical observations", Color Research & Application 30(1), 2005, Table 1: L*a*b* pairs and their ΔE00 with unit parametric factors, to four decimals.
const SHARMA_PAIRS = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1],
  [50, -1.1848, -84.8006, 50, 0, -82.7485, 1],
  [50, -0.9009, -85.5211, 50, 0, -82.7485, 1],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, -1, 2, 50, 0, 0, 2.3669],
  [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
  [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
  [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
  [50, 2.5, 0, 50, 0, -2.5, 4.3065],
  [50, 2.5, 0, 73, 25, -18, 27.1492],
  [50, 2.5, 0, 61, -5, 29, 22.8977],
  [50, 2.5, 0, 56, -27, -3, 31.903],
  [50, 2.5, 0, 58, 24, 15, 19.4535],
  [50, 2.5, 0, 50, 3.1736, 0.5854, 1],
  [50, 2.5, 0, 50, 3.2972, 0, 1],
  [50, 2.5, 0, 50, 1.8634, 0.5757, 1],
  [50, 2.5, 0, 50, 3.2592, 0.335, 1],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
] as const;

describe('CIEDE2000', () => {
  it.each(SHARMA_PAIRS.map(([l1, a1, b1, l2, a2, b2, expected], index) => ({ pair: index + 1, first: [l1, a1, b1], second: [l2, a2, b2], expected })))(
    'matches published pair $pair with ΔE00 $expected',
    ({ first, second, expected }) => {
      expect(deltaE2000(first, second)).toBeCloseTo(expected, 4);
    },
  );

  // Opposite chroma vectors differ in hue by exactly 180°, where CIEDE2000 takes the unwrapped branch for both the hue difference and the mean hue, as Sharma pairs 10 and 14 show. Expected values are computed in double arithmetic with that branch taken; the neighbouring rows sit just past and just short of the tie.
  it.each([
    { first: [50, 128, 128], second: [50, -128, -128], expected: 78.2259 },
    { first: [50, 127, 64], second: [50, -127, -64], expected: 89.3818 },
    { first: [50, 0.092, 0.21], second: [50, -0.092, -0.21], expected: 0.49996 },
    { first: [50, 10, 20], second: [50, -30, -60], expected: 43.3569 },
    { first: [50, -30, -60], second: [50, 10, 20], expected: 43.3569 },
    { first: [50, -60, 10], second: [50, 120, -20], expected: 63.462 },
    { first: [50, 120, -20], second: [50, -60, 10], expected: 63.462 },
    { first: [50, 128, 128], second: [50, -128, -128.01], expected: 109.8544 },
    { first: [50, 128, 128], second: [50, -128, -127.99], expected: 78.2262 },
  ])('gives ΔE00 $expected for $first against $second, around a hue difference of 180°', ({ first, second, expected }) => {
    expect(deltaE2000(first, second)).toBeCloseTo(expected, 4);
  });

  it('gives zero for a colour against itself, including a neutral one', () => {
    expect(deltaE2000([50, 2.5, 0], [50, 2.5, 0])).toBe(0);
    expect(deltaE2000([50, 0, 0], [50, 0, 0])).toBe(0);
  });

  // Mesh subdivision and sampled-function fitting compare ΔE00 against a threshold, so the bits must not depend on the engine's own trigonometry.
  it('keeps the same float64 digest over 20,000 pairs in every runtime', () => {
    const count = 20_000;
    const bytes = new Uint8Array(count * 8);
    const view = new DataView(bytes.buffer);
    let seed = 12_345;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    for (let index = 0; index < count; index++) {
      const first = [next() * 100, next() * 255 - 128, next() * 255 - 128];
      const second = [next() * 100, next() * 255 - 128, next() * 255 - 128];
      view.setFloat64(index * 8, deltaE2000(first, second), true);
    }
    expect(hex(md5(bytes))).toBe('9c53be55c717ea7a7a7b89e00284d18b');
  });
});

describe('properties', () => {
  // An integer grid keeps distinct colours far enough apart that a positive difference cannot round to zero.
  const lab = fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: -128, max: 127 }), fc.integer({ min: -128, max: 127 }));

  it('is symmetric in its two colours', () => {
    fc.assert(
      fc.property(lab, lab, (first, second) => {
        expect(deltaE2000(first, second)).toBeCloseTo(deltaE2000(second, first), 12);
      }),
    );
  });

  it('is zero exactly when the two colours are equal', () => {
    fc.assert(
      fc.property(lab, lab, fc.boolean(), (first, other, same) => {
        const second = same ? first : other;
        const equal = first.every((value, index) => value === second[index]);
        expect(deltaE2000(first, second) === 0).toBe(equal);
      }),
    );
  });
});

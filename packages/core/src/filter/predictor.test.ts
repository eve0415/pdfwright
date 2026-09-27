import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { undoPredictor } from './predictor.ts';

const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - upperLeft)];
  const smallest = Math.min(...distances);
  if (distances[0] === smallest) return left;
  return distances[1] === smallest ? above : upperLeft;
};

const predict = (tag: number, [left, above, upperLeft]: readonly [number, number, number]): number => {
  if (tag === 1) return left;
  if (tag === 2) return above;
  if (tag === 3) return Math.floor((left + above) / 2);
  if (tag === 4) return paeth(left, above, upperLeft);
  return 0;
};

// Encodes rows with the PNG filter named by each row's tag (RFC 2083, 6).
const pngEncode = (rows: number[][], tags: number[], bytesPerPixel: number): Uint8Array => {
  const output: number[] = [];
  let previous: number[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const tag = tags[rowIndex] ?? 0;
    output.push(tag);
    for (const [index, byte] of row.entries()) {
      const left = row[index - bytesPerPixel] ?? 0;
      const upperLeft = previous[index - bytesPerPixel] ?? 0;
      output.push((byte - predict(tag, [left, previous[index] ?? 0, upperLeft]) + 256) % 256);
    }
    previous = row;
  }
  return Uint8Array.from(output);
};

const rows = [
  [10, 200, 30, 40, 250, 60],
  [11, 190, 35, 45, 255, 1],
  [0, 255, 128, 127, 3, 250],
  [99, 98, 97, 96, 95, 94],
  [1, 2, 3, 4, 5, 6],
];

describe('predictors', () => {
  it('passes data through for predictor 1', () => {
    const data = Uint8Array.of(1, 2, 3);
    expect(undoPredictor(data, { predictor: 1, colors: 1, bitsPerComponent: 8, columns: 1 })).toBe(data);
  });

  it('undoes every PNG row tag, including different tags per row', () => {
    const expected = Uint8Array.from(rows.flat());
    for (const tags of [
      [0, 0, 0, 0, 0],
      [1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2],
      [3, 3, 3, 3, 3],
      [4, 4, 4, 4, 4],
      [0, 1, 2, 3, 4],
    ]) {
      const encoded = pngEncode(rows, tags, 3);
      expect(undoPredictor(encoded, { predictor: 15, colors: 3, bitsPerComponent: 8, columns: 2 })).toStrictEqual(expected);
    }
  });

  it('decodes cross-reference stream rows with Columns 4 and Predictor 12', () => {
    const entries = [
      [1, 0, 0x10, 0],
      [1, 0, 0x4a, 0],
      [2, 0, 0x05, 1],
    ];
    const encoded = pngEncode(entries, [2, 2, 2], 1);
    expect(undoPredictor(encoded, { predictor: 12, colors: 1, bitsPerComponent: 8, columns: 4 })).toStrictEqual(Uint8Array.from(entries.flat()));
  });

  it('rejects unknown PNG tags and parameters outside Table 8', () => {
    expect(() => undoPredictor(Uint8Array.of(5, 0), { predictor: 12, colors: 1, bitsPerComponent: 8, columns: 1 })).toThrow(ParseError);
    expect(() => undoPredictor(Uint8Array.of(0), { predictor: 3, colors: 1, bitsPerComponent: 8, columns: 1 })).toThrow(UnsupportedFeatureError);
    expect(() => undoPredictor(Uint8Array.of(0), { predictor: 12, colors: 0, bitsPerComponent: 8, columns: 1 })).toThrow(ParseError);
    expect(() => undoPredictor(Uint8Array.of(0), { predictor: 12, colors: 1, bitsPerComponent: 3, columns: 1 })).toThrow(ParseError);
  });

  it('undoes TIFF predictor 2 for 8- and 16-bit components', () => {
    const eight = Uint8Array.of(10, 20, 5, 5, 250, 10, 1, 1, 1, 1, 1, 1);
    expect(undoPredictor(eight, { predictor: 2, colors: 2, bitsPerComponent: 8, columns: 3 })).toStrictEqual(
      Uint8Array.of(10, 20, 15, 25, 9, 35, 1, 1, 2, 2, 3, 3),
    );
    const sixteen = Uint8Array.of(0x01, 0x00, 0xff, 0x01, 0x00, 0x02);
    expect(undoPredictor(sixteen, { predictor: 2, colors: 1, bitsPerComponent: 16, columns: 3 })).toStrictEqual(
      Uint8Array.of(0x01, 0x00, 0x00, 0x01, 0x00, 0x03),
    );
  });

  it('undoes TIFF predictor 2 for components packed below 8 bits', () => {
    // Four 4-bit samples stored as the differences 1, 1, 1, 13 from their left neighbours.
    expect(undoPredictor(Uint8Array.of(0x11, 0x1d), { predictor: 2, colors: 1, bitsPerComponent: 4, columns: 4 })).toStrictEqual(Uint8Array.of(0x12, 0x30));
    expect(undoPredictor(Uint8Array.of(0b1100_0000), { predictor: 2, colors: 1, bitsPerComponent: 1, columns: 3 })).toStrictEqual(Uint8Array.of(0b1000_0000));
  });
});

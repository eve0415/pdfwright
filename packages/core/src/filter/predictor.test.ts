import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { undoPredictor } from './predictor.ts';

const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - upperLeft)];
  const smallest = Math.min(...distances);
  if (distances[0] === smallest) {
    return left;
  }
  return distances[1] === smallest ? above : upperLeft;
};

const predict = (tag: number, [left, above, upperLeft]: readonly [number, number, number]): number => {
  if (tag === 1) {
    return left;
  }
  if (tag === 2) {
    return above;
  }
  if (tag === 3) {
    return Math.floor((left + above) / 2);
  }
  if (tag === 4) {
    return paeth(left, above, upperLeft);
  }
  return 0;
};

// Encodes rows with the PNG filter named by each row's tag (RFC 2083, 6).
const pngEncode = (rows: ReadonlyArray<ReadonlyArray<number>>, tags: ReadonlyArray<number>, bytesPerPixel: number): Uint8Array => {
  const output: Array<number> = [];
  let previous: ReadonlyArray<number> = [];
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

// Replaces each component of each row with its difference from the component one sample to the left, modulo 2^bits, leaving the padding bits after the last sample as they are (TIFF 6.0, Section 14).
const tiffEncode = (rows: ReadonlyArray<ReadonlyArray<number>>, colors: number, bits: number, columns: number): Uint8Array => {
  const output: Array<number> = [];
  for (const row of rows) {
    const text = row.map(byte => byte.toString(2).padStart(8, '0')).join('');
    const components = Array.from({ length: colors * columns }, (_, index) => Number.parseInt(text.slice(index * bits, (index + 1) * bits), 2));
    const differences = components.map((value, index) => (index < colors ? value : (value - (components[index - colors] ?? 0) + 2 ** bits) % 2 ** bits));
    const encoded = differences.map(value => value.toString(2).padStart(bits, '0')).join('') + text.slice(colors * columns * bits);
    for (let offset = 0; offset < encoded.length; offset += 8) {
      output.push(Number.parseInt(encoded.slice(offset, offset + 8), 2));
    }
  }
  return Uint8Array.from(output);
};

const rows = [
  [10, 200, 30, 40, 250, 60],
  [11, 190, 35, 45, 255, 1],
  [0, 255, 128, 127, 3, 250],
  [99, 98, 97, 96, 95, 94],
  [1, 2, 3, 4, 5, 6],
  // RFC 2083, 6.6 breaks Paeth ties in the order left, above, upper left. Below this row, byte 3 sees left 0, above 3 and upper left 2, a tie between left and upper left, and byte 4 sees left 3, above 0 and upper left 2, a tie between above and upper left.
  [2, 2, 9, 3, 0, 7],
  [0, 3, 5, 6, 7, 8],
];

describe('predictors', () => {
  it('passes data through for predictor 1', () => {
    const data = Uint8Array.of(1, 2, 3);
    expect(undoPredictor(data, { predictor: 1, colors: 1, bitsPerComponent: 8, columns: 1 })).toStrictEqual(data);
  });

  it('undoes every PNG row tag, including different tags per row', () => {
    const expected = Uint8Array.from(rows.flat());
    for (const tags of [
      [0, 0, 0, 0, 0, 0, 0],
      [1, 1, 1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2, 2, 2],
      [3, 3, 3, 3, 3, 3, 3],
      [4, 4, 4, 4, 4, 4, 4],
      [0, 1, 2, 3, 4, 0, 4],
    ]) {
      const encoded = pngEncode(rows, tags, 3);
      expect(undoPredictor(encoded, { predictor: 15, colors: 3, bitsPerComponent: 8, columns: 2 })).toStrictEqual(expected);
    }
  });

  // ISO 32000-1:2008, 7.4.4.4: the PNG predictors work on bytes, and each byte is predicted from the corresponding byte of the sample to its left, which is max(1, ceil(Colors * BitsPerComponent / 8)) bytes back.
  it.each([
    ['two bytes per sample for one 16-bit component', 1, 16, 3, 2],
    ['six bytes per sample for three 16-bit components', 3, 16, 2, 6],
    ['one byte for two 4-bit samples packed in it', 1, 4, 4, 1],
    ['one byte for eight 1-bit samples packed in it', 1, 1, 16, 1],
  ])('predicts PNG rows from %s', (_, colors, bitsPerComponent, columns, bytesPerPixel) => {
    const rowBytes = Math.ceil((colors * bitsPerComponent * columns) / 8);
    const decoded = [0, 1, 2].map(row => Array.from({ length: rowBytes }, (__, index) => (row * 89 + index * 53 + 17) & 255));
    for (const tags of [
      [1, 1, 1],
      [3, 3, 3],
      [4, 4, 4],
    ]) {
      expect(undoPredictor(pngEncode(decoded, tags, bytesPerPixel), { predictor: 12, colors, bitsPerComponent, columns })).toStrictEqual(
        Uint8Array.from(decoded.flat()),
      );
    }
  });

  it('undoes a final PNG row that holds fewer bytes than Columns asks for', () => {
    expect(undoPredictor(Uint8Array.of(2, 1, 2, 3, 4, 1, 5), { predictor: 12, colors: 1, bitsPerComponent: 8, columns: 4 })).toStrictEqual(
      Uint8Array.of(1, 2, 3, 4, 5),
    );
  });

  it('rejects unknown PNG tags and parameters outside Table 8', () => {
    expect(() => undoPredictor(Uint8Array.of(5, 0), { predictor: 12, colors: 1, bitsPerComponent: 8, columns: 1 })).toThrow(ParseError);
    expect(() => undoPredictor(Uint8Array.of(0), { predictor: 3, colors: 1, bitsPerComponent: 8, columns: 1 })).toThrow(UnsupportedFeatureError);
    expect(undoPredictor(Uint8Array.of(1, 5, 5), { predictor: 16, colors: 1, bitsPerComponent: 8, columns: 2 })).toStrictEqual(Uint8Array.of(5, 10));
    expect(() => undoPredictor(Uint8Array.of(0), { predictor: 12, colors: 0, bitsPerComponent: 8, columns: 1 })).toThrow(ParseError);
    expect(() => undoPredictor(Uint8Array.of(0), { predictor: 12, colors: 1, bitsPerComponent: 3, columns: 1 })).toThrow(ParseError);
  });

  // ISO 32000-1:2008, 7.4.4.4, Table 10: 1 is no prediction, 2 is TIFF Predictor 2 and 10 to 15 are the PNG predictors; "a Predictor value greater than or equal to 10 shall indicate that a PNG predictor is in use".
  it.each([0, -1, 9])('refuses predictor %i, which Table 10 does not define', predictor => {
    expect(() => undoPredictor(Uint8Array.of(1, 5, 5), { predictor, colors: 1, bitsPerComponent: 8, columns: 2 })).toThrow(UnsupportedFeatureError);
  });

  it('undoes PNG prediction for predictor 10, the lowest PNG value', () => {
    expect(undoPredictor(Uint8Array.of(1, 5, 5), { predictor: 10, colors: 1, bitsPerComponent: 8, columns: 2 })).toStrictEqual(Uint8Array.of(5, 10));
  });

  it.each([
    ['Columns 0', { colors: 1, columns: 0 }],
    ['fractional Columns', { colors: 1, columns: 1.5 }],
    ['fractional Colors', { colors: 1.5, columns: 1 }],
  ])('refuses %s', (_, { colors, columns }) => {
    expect(() => undoPredictor(Uint8Array.of(1, 5, 5), { predictor: 12, colors, bitsPerComponent: 8, columns })).toThrow(ParseError);
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

  it('restarts TIFF prediction on each row, keeps the padding bits and leaves a partial last row alone', () => {
    // Three 4-bit samples per row fill a byte and a half, so the low nibble of every second byte is padding. Row 1 holds 3, 5, 9 and row 2 holds 1, 15, 0.
    const encoded = Uint8Array.of(0x32, 0x4f, 0x1e, 0x1a, 0x77);
    expect(undoPredictor(encoded, { predictor: 2, colors: 1, bitsPerComponent: 4, columns: 3 })).toStrictEqual(Uint8Array.of(0x35, 0x9f, 0x1f, 0x0a, 0x77));
  });

  it('undoes TIFF predictor 2 for two 2-bit components per sample', () => {
    // The samples (1, 2), (3, 3) and (0, 1), stored as (1, 2), (2, 1) and (1, 2), with four padding bits.
    expect(undoPredictor(Uint8Array.of(0b0110_1001, 0b0110_0000), { predictor: 2, colors: 2, bitsPerComponent: 2, columns: 3 })).toStrictEqual(
      Uint8Array.of(0b0110_1111, 0b0001_0000),
    );
  });
});

describe('properties', () => {
  const image = fc
    .record({
      colors: fc.integer({ min: 1, max: 4 }),
      bitsPerComponent: fc.constantFrom(1, 2, 4, 8, 16),
      columns: fc.integer({ min: 1, max: 8 }),
    })
    .chain(parameters => {
      const rowBytes = Math.ceil((parameters.colors * parameters.bitsPerComponent * parameters.columns) / 8);
      return fc.record({
        parameters: fc.constant(parameters),
        rows: fc.array(fc.array(fc.nat({ max: 255 }), { minLength: rowBytes, maxLength: rowBytes }), { maxLength: 5 }),
        tags: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 5, maxLength: 5 }),
      });
    });

  it('undoes what a PNG encoder predicted, with any tag on each row', () => {
    fc.assert(
      fc.property(image, fc.integer({ min: 10, max: 15 }), ({ parameters, rows: decoded, tags }, predictor) => {
        const bytesPerPixel = Math.max(1, Math.ceil((parameters.colors * parameters.bitsPerComponent) / 8));
        expect(undoPredictor(pngEncode(decoded, tags, bytesPerPixel), { predictor, ...parameters })).toStrictEqual(Uint8Array.from(decoded.flat()));
      }),
    );
  });

  it('undoes what a TIFF Predictor 2 encoder predicted', () => {
    fc.assert(
      fc.property(image, ({ parameters, rows: decoded }) => {
        const { colors, bitsPerComponent, columns } = parameters;
        expect(undoPredictor(tiffEncode(decoded, colors, bitsPerComponent, columns), { predictor: 2, ...parameters })).toStrictEqual(
          Uint8Array.from(decoded.flat()),
        );
      }),
    );
  });
});

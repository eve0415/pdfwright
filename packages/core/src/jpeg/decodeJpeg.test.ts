import type { DecodeJpegOptions } from './decodeJpeg.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { PdfwrightError } from '../error/pdfwrightError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { md5 } from '../hash/md5.ts';

import { decodeJpeg, inverseDct } from './decodeJpeg.ts';

const frame = (marker: number, precision = 8, components = 3): Uint8Array => {
  const entries = Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]);
  return Uint8Array.from([0xff, 0xd8, 0xff, marker, 0, 8 + components * 3, precision, 0, 8, 0, 8, components, ...entries.flat(), 0xff, 0xd9]);
};

const unsupportedReason = (bytes: Uint8Array): string | undefined => {
  try {
    decodeJpeg(bytes);
  } catch (error: unknown) {
    if (error instanceof UnsupportedFeatureError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('JPEG was accepted');
};

interface Failure {
  readonly type: 'parse' | 'unsupported';
  readonly reason: string | undefined;
}

// Names the error class and reason a call throws, and rethrows any other error so that a TypeError or RangeError fails the test.
const failure = (run: () => void): Failure => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ParseError) {
      return { type: 'parse', reason: error.reason };
    }
    if (error instanceof UnsupportedFeatureError) {
      return { type: 'unsupported', reason: error.reason };
    }
    throw error;
  }
  throw new Error('JPEG was accepted');
};

const coefficients = (): Int32Array => Int32Array.from(Array.from({ length: 64 }, (_, index) => (index === 0 ? 128 : ((index * 37) % 23) - 11)));

const ones = (count: number): Array<number> => Array.from({ length: count }, () => 1);

// ITU-T T.81 (1992), B.1.1.4: a marker, then a two-byte length that counts itself, then the parameters.
const segment = (marker: number, payload: ReadonlyArray<number>): Array<number> => [
  0xff,
  marker,
  Math.floor((payload.length + 2) / 256),
  (payload.length + 2) % 256,
  ...payload,
];

// ITU-T T.81 (1992), B.2.4.1: Pq and Tq in one byte, then 64 elements.
const dqt = (selector: number, values: ReadonlyArray<number>): Array<number> => segment(0xdb, [selector, ...values]);

// ITU-T T.81 (1992), B.2.4.2: Tc and Th in one byte, 16 code-length counts, then the values.
const dht = (selector: number, counts: ReadonlyArray<number>, symbols: ReadonlyArray<number>): Array<number> =>
  segment(0xc4, [selector, ...counts, ...Array.from({ length: 16 - counts.length }, () => 0), ...symbols]);

// ITU-T T.81 (1992), B.2.2: P, Y, X, Nf, then Ci, Hi and Vi, Tqi for each component.
const sof = (input: {
  readonly height: number;
  readonly width: number;
  readonly components: ReadonlyArray<ReadonlyArray<number>>;
  readonly marker?: number;
}): Array<number> =>
  segment(input.marker ?? 0xc0, [
    8,
    Math.floor(input.height / 256),
    input.height % 256,
    Math.floor(input.width / 256),
    input.width % 256,
    input.components.length,
    ...input.components.flat(),
  ]);

// ITU-T T.81 (1992), B.2.3: Ns, then Csj and Tdj, Taj for each component, then Ss, Se and Ah, Al.
const sos = (components: ReadonlyArray<ReadonlyArray<number>>, spectral: ReadonlyArray<number> = [0, 63, 0]): Array<number> =>
  segment(0xda, [components.length, ...components.flat(), ...spectral]);

// ITU-T T.81 (1992), B.2.4.4: the restart interval in MCUs.
const dri = (interval: number): Array<number> => segment(0xdd, [Math.floor(interval / 256), interval % 256]);

const jpeg = (headers: ReadonlyArray<ReadonlyArray<number>>, entropy: ReadonlyArray<number>): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, ...headers.flat(), ...entropy, 0xff, 0xd9]);

const Q_ONE = dqt(0, ones(64));
const Q_EIGHT = dqt(0, [8, ...ones(63)]);
// One one-bit code, 0, for DC category 0 or 1, and one, 0, for the AC end-of-block symbol.
const DC_ZERO = dht(0x00, [1], [0]);
const DC_ONE = dht(0x00, [1], [1]);
const AC_EOB = dht(0x10, [1], [0]);
// DC categories 0 to 11 as the four-bit codes 0000 to 1011 (ITU-T T.81 (1992), Table F.1 and Annex C).
const DC_CATEGORIES = dht(
  0x00,
  [0, 0, 0, 12],
  Array.from({ length: 12 }, (_, index) => index),
);
const GRAY_FRAME = sof({ height: 8, width: 8, components: [[1, 0x11, 0]] });
const GRAY_SCAN = sos([[1, 0x00]]);

const grayJpeg = (entropy: ReadonlyArray<number>): Uint8Array => jpeg([Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_SCAN], entropy);

// ITU-T T.81 (1992), F.1.2.1.1: a DC difference is its category's code followed by the category's count of magnitude bits, negative values in ones' complement.
const dcBits = (difference: number): string => {
  const magnitude = Math.abs(difference);
  const category = magnitude === 0 ? 0 : magnitude.toString(2).length;
  const value = difference >= 0 ? difference : difference + 2 ** category - 1;
  return category.toString(2).padStart(4, '0') + (category === 0 ? '' : value.toString(2).padStart(category, '0'));
};

// ITU-T T.81 (1992), B.1.1.5 and F.1.2.3: the bits are padded with ones to a byte boundary, and a 0xFF byte is followed by a stuffed 0x00.
const entropyBytes = (bits: string): Array<number> => {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '1');
  return Array.from({ length: padded.length / 8 }, (_, index) => Number.parseInt(padded.slice(index * 8, index * 8 + 8), 2)).flatMap(value =>
    value === 0xff ? [0xff, 0] : [value],
  );
};

interface DcImage {
  readonly width: number;
  readonly height: number;
  /** The sampling factor byte of each component, whose identifiers run from 1; one grey component by default. */
  readonly sampling?: ReadonlyArray<number>;
  /** One DC difference per data unit in decoding order; every data unit then ends its AC coefficients at once. */
  readonly differences: ReadonlyArray<number>;
  readonly interval?: number;
  readonly before?: ReadonlyArray<ReadonlyArray<number>>;
}

// A baseline JPEG whose data units hold only a DC coefficient, quantised by 8, so that each data unit is the uniform value 128 plus its predicted DC.
const dcJpeg = (image: DcImage): Uint8Array => {
  const sampling = image.sampling ?? [0x11];
  const unitsPerMcu = sampling.reduce((sum, factors) => sum + Math.floor(factors / 16) * (factors % 16), 0);
  const maxHorizontal = Math.max(...sampling.map(factors => Math.floor(factors / 16)));
  const maxVertical = Math.max(...sampling.map(factors => factors % 16));
  const mcus = Math.ceil(image.width / (8 * maxHorizontal)) * Math.ceil(image.height / (8 * maxVertical));
  if (image.differences.length !== mcus * unitsPerMcu) {
    throw new Error(`a ${String(image.width)} × ${String(image.height)} image needs ${String(mcus * unitsPerMcu)} DC differences`);
  }
  const interval = image.interval ?? 0;
  const entropy: Array<number> = [];
  let bits = '';
  let restarts = 0;
  for (let mcu = 0; mcu < mcus; mcu++) {
    // ITU-T T.81 (1992), B.2.1 and E.1.4: RSTm follows every interval of MCUs, numbered modulo 8.
    if (interval > 0 && mcu > 0 && mcu % interval === 0) {
      entropy.push(...entropyBytes(bits), 0xff, 0xd0 + (restarts % 8));
      restarts++;
      bits = '';
    }
    for (let unit = 0; unit < unitsPerMcu; unit++) {
      bits += `${dcBits(image.differences[mcu * unitsPerMcu + unit] ?? 0)}0`;
    }
  }
  entropy.push(...entropyBytes(bits));
  const components = sampling.map((factors, index) => [index + 1, factors, 0]);
  return jpeg(
    [
      ...(image.before ?? []),
      Q_EIGHT,
      DC_CATEGORIES,
      AC_EOB,
      ...(interval > 0 ? [dri(interval)] : []),
      sof({ height: image.height, width: image.width, components }),
      sos(components.map(([id = 0]) => [id, 0x00])),
    ],
    entropy,
  );
};

const decodedRows = (bytes: Uint8Array, options?: DecodeJpegOptions): Array<Uint8Array> => [...decodeJpeg(bytes, options).rows()];

const filled = (width: number, height: number, value: number): Array<Uint8Array> => Array.from({ length: height }, () => new Uint8Array(width).fill(value));

// Rows whose columns take `values` eight at a time, one value per data unit.
const banded = (height: number, values: ReadonlyArray<number>): Array<Uint8Array> =>
  Array.from({ length: height }, () => Uint8Array.from(values.flatMap(value => Array.from({ length: 8 }, () => value))));

const parseOffset = (run: () => void): number => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ParseError) {
      return error.offset;
    }
    throw error;
  }
  throw new Error('JPEG was accepted');
};

// Adobe Technical Note #5116, "Supporting the DCT Filters in PostScript Level 2", the APP14 marker: "Adobe", a version, two flag words, then the transform byte.
const adobe = (transform: number, identifier = 'Adobe'): Array<number> =>
  segment(0xee, [...Array.from(identifier, character => character.codePointAt(0) ?? 0), 0, 100, 0, 0, 0, 0, transform]);

// A three-component 8 × 8 image whose Y, Cb and Cr data units are 129, 144 and 112, so that converting YCbCr to RGB changes every sample.
const COLOUR: DcImage = { width: 8, height: 8, sampling: [0x11, 0x11, 0x11], differences: [1, 16, -16] };

const samplingJpeg = (components: ReadonlyArray<ReadonlyArray<number>>): Uint8Array =>
  jpeg([Q_ONE, DC_ZERO, AC_EOB, sof({ height: 8, width: 8, components }), sos(components.map(([id = 0]) => [id, 0x00]))], [0x3f]);

const ROBUSTNESS_BASE: DcImage = { width: 32, height: 16, sampling: [0x22, 0x11, 0x11], differences: [3, -2, 5, 1, 7, -9, -4, 2, 0, 6, -1, 3], interval: 1 };

// Decodes every row, and names a refusal by the library's own errors; any other error is rethrown and fails the test.
const outcome = (bytes: Uint8Array): 'decoded' | 'refused' => {
  try {
    decodedRows(bytes);
    return 'decoded';
  } catch (error: unknown) {
    if (error instanceof PdfwrightError) {
      return 'refused';
    }
    throw error;
  }
};

describe('jpeg input validation', () => {
  it('reports an invalid caller colorTransform as an argument error', () => {
    const options: DecodeJpegOptions = {};
    Object.defineProperty(options, 'colorTransform', { value: 2 });
    expect(() => decodeJpeg(grayJpeg([0x3f]), options)).toThrow(InvalidArgumentError);
  });

  it('rejects data and restart markers after the final MCU', () => {
    expect([...decodeJpeg(grayJpeg([0x3f])).rows()]).toHaveLength(8);
    for (const entropy of [[0x3f, 1, 2, 3], [0x3f, 255, 0xd0], [0x3e]]) {
      expect(() => [...decodeJpeg(grayJpeg(entropy)).rows()]).toThrow(ParseError);
    }
  });

  it('pins the inverse DCT output across runtimes', () => {
    const digest = [...md5(inverseDct(coefficients()))].map(value => value.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('114740e0166b329fff476c007e2d1a59');
  });

  it.each([
    { marker: 0xc2, precision: 8, components: 3, reason: 'jpeg-progressive' },
    { marker: 0xc9, precision: 8, components: 3, reason: 'jpeg-arithmetic' },
    { marker: 0xc3, precision: 8, components: 3, reason: 'jpeg-lossless' },
    { marker: 0xc1, precision: 12, components: 3, reason: 'jpeg-12-bit' },
    { marker: 0xc0, precision: 8, components: 4, reason: 'jpeg-cmyk' },
  ])('rejects $reason with a typed reason', ({ marker, precision, components, reason }) => {
    expect(() => decodeJpeg(frame(marker, precision, components))).toThrow(UnsupportedFeatureError);
    expect(unsupportedReason(frame(marker, precision, components))).toBe(reason);
  });

  it('reports every truncation of a valid JPEG as truncated', () => {
    const bytes = grayJpeg([0x3f]);
    expect(decodedRows(bytes)).toStrictEqual(filled(8, 8, 128));
    for (let length = 0; length < bytes.length; length++) {
      expect(failure(() => decodedRows(bytes.subarray(0, length)))).toStrictEqual({ type: 'parse', reason: 'image-truncated' });
    }
  });

  it('decodes or refuses with a library error after any one byte of a valid JPEG changes', () => {
    const base = dcJpeg(ROBUSTNESS_BASE);
    expect(outcome(base)).toBe('decoded');
    for (let offset = 0; offset < base.length; offset++) {
      const original = base[offset] ?? 0;
      for (const value of [0, 0xff, (original + 1) % 256, (original + 128) % 256]) {
        const bytes = Uint8Array.from(base);
        bytes[offset] = value;
        expect(['decoded', 'refused']).toContain(outcome(bytes));
      }
    }
  });
});

describe('jpeg frame markers and sampling', () => {
  // ITU-T T.81 (1992), Table B.1: SOF5 to SOF7 are differential Huffman processes, SOF9 to SOF15 and DAC are arithmetic, and JPG and JPG7 are reserved or extensions.
  it.each([
    { marker: 0xc5, reason: 'jpeg-process' },
    { marker: 0xc8, reason: 'jpeg-process' },
    { marker: 0xf7, reason: 'jpeg-process' },
    { marker: 0xc6, reason: 'jpeg-progressive' },
    { marker: 0xc7, reason: 'jpeg-lossless' },
    { marker: 0xca, reason: 'jpeg-arithmetic' },
    { marker: 0xcb, reason: 'jpeg-arithmetic' },
    { marker: 0xcc, reason: 'jpeg-arithmetic' },
    { marker: 0xcd, reason: 'jpeg-arithmetic' },
    { marker: 0xce, reason: 'jpeg-arithmetic' },
    { marker: 0xcf, reason: 'jpeg-arithmetic' },
  ])('refuses frame marker $marker as $reason', ({ marker, reason }) => {
    expect(failure(() => decodeJpeg(frame(marker)))).toStrictEqual({ type: 'unsupported', reason });
  });

  it.each([
    ['a grey component sampled 2 × 2', [[1, 0x22, 0]]],
    [
      'a chroma component sampled 2 × 1',
      [
        [1, 0x22, 0],
        [2, 0x21, 0],
        [3, 0x11, 0],
      ],
    ],
    [
      'luma subsampled vertically only',
      [
        [1, 0x12, 0],
        [2, 0x11, 0],
        [3, 0x11, 0],
      ],
    ],
    ['a sampling factor of 3', [[1, 0x31, 0]]],
    [
      'two components',
      [
        [1, 0x11, 0],
        [2, 0x11, 0],
      ],
    ],
  ])('refuses %s as jpeg-sampling', (_, components) => {
    expect(failure(() => decodeJpeg(samplingJpeg(components)))).toStrictEqual({ type: 'unsupported', reason: 'jpeg-sampling' });
  });
});

describe('jpeg header segments', () => {
  it.each([
    // ITU-T T.81 (1992), B.2.4.1: Pq is 0 or 1, Tq is 0 to 3, and quantization values are nonzero.
    ['a zero quantization value', [dqt(0, [1, 1, 0, ...ones(61)]), DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_SCAN]],
    ['a quantization precision of 2', [dqt(0x20, ones(128)), DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_SCAN]],
    ['a quantization destination of 4', [Q_ONE, dqt(0x04, ones(64)), DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_SCAN]],
    // The APP1 segment after the short table holds no zero byte, so a parser that read past the table's end would take a valid table from it.
    ['a quantization table of 10 values', [dqt(0, ones(10)), segment(0xe1, ones(255)), DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_SCAN]],
    // ITU-T T.81 (1992), B.2.4.2 and C.2: Tc is 0 or 1, Th is 0 to 3, the counts must fit a binary code tree, and the values must be present.
    ['Huffman code lengths that oversubscribe the tree', [Q_ONE, dht(0x00, [3], [0, 1, 2]), AC_EOB, GRAY_FRAME, GRAY_SCAN]],
    ['a Huffman table with no codes', [Q_ONE, DC_ZERO, dht(0x01, [], []), AC_EOB, GRAY_FRAME, GRAY_SCAN]],
    ['a Huffman table class of 2', [Q_ONE, DC_ZERO, AC_EOB, dht(0x20, [1], [0]), GRAY_FRAME, GRAY_SCAN]],
    ['a Huffman table destination of 4', [Q_ONE, DC_ZERO, AC_EOB, dht(0x04, [1], [0]), GRAY_FRAME, GRAY_SCAN]],
    ['Huffman counts that declare more values than the segment holds', [Q_ONE, dht(0x00, [2], [0]), AC_EOB, GRAY_FRAME, GRAY_SCAN]],
    // ITU-T T.81 (1992), B.2.2: X is at least 1, the segment holds exactly Nf component entries, and component identifiers are distinct.
    ['a frame header of 5 bytes', [Q_ONE, DC_ZERO, AC_EOB, segment(0xc0, [8, 0, 8, 0, 8]), GRAY_SCAN]],
    ['a frame of width 0', [Q_ONE, DC_ZERO, AC_EOB, sof({ height: 8, width: 0, components: [[1, 0x11, 0]] }), GRAY_SCAN]],
    ['a frame component list one byte long', [Q_ONE, DC_ZERO, AC_EOB, segment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0]), GRAY_SCAN]],
    ['two frames', [Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_FRAME, GRAY_SCAN]],
    // ITU-T T.81 (1992), B.2.3: a scan follows its frame, names frame components once each, selects tables that exist, and has length 6 + 2 × Ns.
    ['a scan before any frame', [Q_ONE, DC_ZERO, AC_EOB, GRAY_SCAN, GRAY_FRAME]],
    ['a scan component absent from the frame', [Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, sos([[2, 0x00]])]],
    ['a scan whose DC table is missing', [Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, sos([[1, 0x10]])]],
    ['a scan header one byte long', [Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, segment(0xda, [1, 1, 0, 0, 63, 0, 0])]],
    // ITU-T T.81 (1992), B.2.4.4: the DRI segment holds one two-byte interval.
    ['a restart interval segment of 3 bytes', [Q_ONE, DC_ZERO, AC_EOB, segment(0xdd, [0, 1, 0]), GRAY_FRAME, GRAY_SCAN]],
    // ITU-T T.81 (1992), Table B.1: JPG0 is reserved for JPEG extensions.
    ['a JPG0 segment', [Q_ONE, DC_ZERO, AC_EOB, segment(0xf0, [0]), GRAY_FRAME, GRAY_SCAN]],
  ])('refuses %s as invalid', (_, headers) => {
    expect(failure(() => decodeJpeg(jpeg(headers, [0x3f])))).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
  });

  it('refuses a repeated scan component of a three-component frame', () => {
    const components = [
      [1, 0x11, 0],
      [2, 0x11, 0],
      [3, 0x11, 0],
    ];
    const repeated = jpeg(
      [
        Q_ONE,
        DC_ZERO,
        AC_EOB,
        sof({ height: 8, width: 8, components }),
        sos([
          [1, 0],
          [1, 0],
          [2, 0],
        ]),
      ],
      [0x03],
    );
    expect(failure(() => decodeJpeg(repeated))).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
  });

  it('refuses duplicate frame component identifiers', () => {
    // With no scan after the frame, a parser that accepted the frame would report a missing scan instead.
    const duplicate = Uint8Array.from([
      0xff,
      0xd8,
      ...sof({
        height: 8,
        width: 8,
        components: [
          [1, 0x11, 0],
          [1, 0x11, 0],
          [2, 0x11, 0],
        ],
      }),
    ]);
    expect(failure(() => decodeJpeg(duplicate))).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
  });

  // ITU-T T.81 (1992), B.2.3: a sequential scan has Ss 0, Se 63 and Ah, Al 0.
  it.each([
    ['a spectral start of 1', [1, 63, 0]],
    ['a spectral end of 62', [0, 62, 0]],
    ['successive approximation bits', [0, 63, 0x10]],
  ])('refuses a baseline scan with %s as progressive', (_, spectral) => {
    const progressive = jpeg([Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, sos([[1, 0x00]], spectral)], [0x3f]);
    expect(failure(() => decodeJpeg(progressive))).toStrictEqual({ type: 'unsupported', reason: 'jpeg-progressive' });
  });

  it('reads 16-bit and 8-bit quantization tables and a segment holding two tables', () => {
    // A DC difference of +1 quantised by 8 is a DC coefficient of 8, which the inverse DCT turns into 128 + 8 / 8.
    const sixteenBit = dqt(0x10, [0, 8, ...Array.from({ length: 63 }, () => [0, 1]).flat()]);
    expect(decodedRows(jpeg([sixteenBit, DC_ONE, AC_EOB, GRAY_FRAME, GRAY_SCAN], [0x5f]))).toStrictEqual(filled(8, 8, 129));
    expect(decodedRows(jpeg([Q_EIGHT, DC_ONE, AC_EOB, GRAY_FRAME, GRAY_SCAN], [0x5f]))).toStrictEqual(filled(8, 8, 129));
    const twoTables = segment(0xdb, [0x00, ...ones(64), 0x01, 8, ...ones(63)]);
    const usesTableOne = sof({ height: 8, width: 8, components: [[1, 0x11, 1]] });
    expect(decodedRows(jpeg([twoTables, DC_ONE, AC_EOB, usesTableOne, GRAY_SCAN], [0x5f]))).toStrictEqual(filled(8, 8, 129));
  });

  it('skips fill bytes before a marker and skips COM and APP15 segments', () => {
    const uniform = filled(8, 8, 128);
    expect(decodedRows(jpeg([[0xff, 0xff], Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_SCAN], [0x3f]))).toStrictEqual(uniform);
    expect(decodedRows(jpeg([segment(0xfe, [1, 2]), segment(0xef, [3]), Q_ONE, DC_ZERO, AC_EOB, GRAY_FRAME, GRAY_SCAN], [0x3f]))).toStrictEqual(uniform);
  });

  it('refuses a stuffed byte and a restart marker among the headers at the marker', () => {
    // ITU-T T.81 (1992), B.1.1.2 and B.1.1.5: X'FF00' and RSTm occur only inside entropy-coded data.
    const stuffed = Uint8Array.from([0xff, 0xd8, ...Q_ONE, 0xff, 0x00, ...DC_ZERO]);
    expect(failure(() => decodeJpeg(stuffed))).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
    expect(parseOffset(() => decodeJpeg(stuffed))).toBe(2 + Q_ONE.length + 1);
    const restart = Uint8Array.from([0xff, 0xd8, ...Q_ONE, 0xff, 0xd0, ...DC_ZERO]);
    expect(failure(() => decodeJpeg(restart))).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
    expect(parseOffset(() => decodeJpeg(restart))).toBe(2 + Q_ONE.length + 2);
  });

  it('refuses a second scan and a table marker after the entropy data', () => {
    expect(failure(() => decodeJpeg(grayJpeg([0x3f, 0xff, 0xda, 0, 8])))).toStrictEqual({ type: 'unsupported', reason: 'jpeg-multi-scan' });
    expect(failure(() => decodeJpeg(grayJpeg([0x3f, 0xff, 0xdb, 0, 8])))).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
  });
});

describe('jpeg entropy-coded data', () => {
  it.each([
    // Seventeen 1 bits follow the DC code, and the AC table's only code is the single bit 0.
    ['an undefined Huffman code', [Q_ONE, DC_ZERO, AC_EOB], [0x7f, 0xff, 0x00, 0xff, 0x00]],
    // ITU-T T.81 (1992), F.1.2.2.1: a zero size with a run other than 15 is end-of-block only for run 0.
    ['an AC run of 1 with size 0', [Q_ONE, DC_ZERO, dht(0x10, [1], [0x10])], [0x3f]],
    ['a DC category of 17', [Q_ONE, dht(0x00, [1], [17]), AC_EOB], [0x3f]],
  ])('refuses %s while iterating rows', (_, tables, entropy) => {
    const image = decodeJpeg(jpeg([...tables, GRAY_FRAME, GRAY_SCAN], entropy));
    expect(failure(() => [...image.rows()])).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
  });

  it('reports entropy data that ends before the last MCU as truncated', () => {
    const image = decodeJpeg(jpeg([Q_ONE, DC_ZERO, AC_EOB, sof({ height: 8, width: 16, components: [[1, 0x11, 0]] }), GRAY_SCAN], [0x3f]));
    expect(failure(() => [...image.rows()])).toStrictEqual({ type: 'parse', reason: 'image-truncated' });
  });

  it('refuses a restart marker inside the entropy data of a file without restart intervals at that marker', () => {
    const bytes = jpeg([Q_ONE, DC_ZERO, AC_EOB, sof({ height: 8, width: 16, components: [[1, 0x11, 0]] }), GRAY_SCAN], [0x3f, 0xff, 0xd0, 0x3f]);
    const image = decodeJpeg(bytes);
    expect(failure(() => [...image.rows()])).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
    expect(parseOffset(() => [...image.rows()])).toBe(bytes.length - 5);
  });

  it('predicts each DC from the previous data unit and resets the prediction at each restart', () => {
    expect(decodedRows(dcJpeg({ width: 16, height: 8, differences: [1, 1] }))).toStrictEqual(banded(8, [129, 130]));
    expect(decodedRows(dcJpeg({ width: 16, height: 8, differences: [1, 1], interval: 1 }))).toStrictEqual(banded(8, [129, 129]));
  });

  it('decodes restart markers numbered modulo 8', () => {
    const differences = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const bytes = dcJpeg({ width: 80, height: 8, differences, interval: 1 });
    // Nine restart markers separate ten MCUs: RST0 to RST7, then RST0 again.
    expect(bytes.filter((value, index) => bytes[index - 1] === 0xff && value >= 0xd0 && value <= 0xd7)).toStrictEqual(
      Uint8Array.of(0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd0),
    );
    expect(decodedRows(bytes)).toStrictEqual(
      banded(
        8,
        differences.map(difference => 128 + difference),
      ),
    );
  });

  it('decodes an explicit restart interval of 0 as no restart intervals', () => {
    const plain = dcJpeg({ width: 16, height: 8, differences: [1, 1] });
    const disabled = dcJpeg({ width: 16, height: 8, differences: [1, 1], before: [dri(0)] });
    expect(decodedRows(disabled)).toStrictEqual(decodedRows(plain));
  });

  it.each([
    ['a restart marker out of sequence', [0x3f, 0xff, 0xd1, 0x3f]],
    ['a missing restart marker', [0x3f, 0x3f]],
  ])('refuses %s', (_, entropy) => {
    const image = decodeJpeg(jpeg([Q_ONE, DC_ZERO, AC_EOB, dri(1), sof({ height: 8, width: 16, components: [[1, 0x11, 0]] }), GRAY_SCAN], entropy));
    expect(failure(() => [...image.rows()])).toStrictEqual({ type: 'parse', reason: 'image-invalid' });
  });

  it('crops the data units of a partial MCU to the frame', () => {
    const rows = decodedRows(dcJpeg({ width: 9, height: 9, differences: [1, 1, 1, 1] }));
    expect(rows).toStrictEqual([
      ...Array.from({ length: 8 }, () => Uint8Array.of(129, 129, 129, 129, 129, 129, 129, 129, 130)),
      Uint8Array.of(131, 131, 131, 131, 131, 131, 131, 131, 132),
    ]);
  });
});

describe('jpeg colour transform', () => {
  it('lets an Adobe transform of 0 override the three-component default', () => {
    const plain = dcJpeg(COLOUR);
    const marked = dcJpeg({ ...COLOUR, before: [adobe(0)] });
    expect(decodeJpeg(marked).adobeColorTransform).toBe(0);
    expect(decodedRows(marked)).toStrictEqual(decodedRows(plain, { colorTransform: 0 }));
    expect(decodedRows(marked)).not.toStrictEqual(decodedRows(plain));
    const untransformed = Array.from({ length: 8 }, () => Uint8Array.from(Array.from({ length: 8 }, () => [129, 144, 112]).flat()));
    expect(decodedRows(plain, { colorTransform: 0 })).toStrictEqual(untransformed);
  });

  it.each([
    ['shorter than 12 bytes', segment(0xee, [...Array.from('Adobe', character => character.codePointAt(0) ?? 0), 0, 100, 0, 0, 0, 0])],
    ['with another identifier', adobe(0, 'Adobf')],
  ])('ignores an APP14 segment %s', (_, marker) => {
    const plain = dcJpeg(COLOUR);
    const marked = dcJpeg({ ...COLOUR, before: [marker] });
    expect(decodeJpeg(marked).adobeColorTransform).toBeUndefined();
    expect(decodedRows(marked)).toStrictEqual(decodedRows(plain));
  });

  it('refuses an Adobe transform of 2 on a grey image', () => {
    expect(failure(() => decodeJpeg(dcJpeg({ width: 8, height: 8, differences: [0], before: [adobe(2)] })))).toStrictEqual({
      type: 'unsupported',
      reason: 'jpeg-color-transform',
    });
  });

  it('ignores colorTransform 1 on a grey image', () => {
    const bytes = dcJpeg({ width: 16, height: 8, differences: [1, 1] });
    expect(decodedRows(bytes, { colorTransform: 1 })).toStrictEqual(banded(8, [129, 130]));
  });
});

describe('jpeg limits', () => {
  it('counts every component against maxDecodedBytes', () => {
    // 8 × 8 samples of three components are 192 bytes.
    expect(() => decodeJpeg(dcJpeg(COLOUR), { maxDecodedBytes: 191 })).toThrow(ResourceLimitError);
    expect(decodeJpeg(dcJpeg(COLOUR), { maxDecodedBytes: 192 }).components).toBe(3);
  });

  it('counts every sampled data unit against maxRowBytes', () => {
    // One 2 × 2 MCU holds six data units of 64 bytes, and the 16-pixel row holds 48 interleaved samples: 432 bytes.
    const subsampled = dcJpeg({ width: 16, height: 16, sampling: [0x22, 0x11, 0x11], differences: [0, 0, 0, 0, 0, 0] });
    expect(() => decodeJpeg(subsampled, { maxRowBytes: 431 })).toThrow(ResourceLimitError);
    expect(decodedRows(subsampled, { maxRowBytes: 432 })).toHaveLength(16);
  });

  it('refuses an infinite limit', () => {
    expect(() => decodeJpeg(grayJpeg([0x3f]), { maxDecodedBytes: Number.POSITIVE_INFINITY })).toThrow(InvalidArgumentError);
    expect(() => decodeJpeg(grayJpeg([0x3f]), { maxRowBytes: Number.POSITIVE_INFINITY })).toThrow(InvalidArgumentError);
  });
});

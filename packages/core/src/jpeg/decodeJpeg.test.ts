import type { DecodeJpegOptions } from './decodeJpeg.ts';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { PdfwrightError } from '../error/pdfwrightError.ts';
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
// One one-bit code, 0, for DC category 0, and one, 0, for the AC end-of-block symbol.
const DC_ZERO = dht(0x00, [1], [0]);
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

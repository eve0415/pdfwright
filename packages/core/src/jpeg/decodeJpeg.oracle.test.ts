import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { magick, runChecked } from '../../../../scripts/readerOracle.ts';
import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { decodeJpeg } from './decodeJpeg.ts';

const rgb = (width = 32, height = 32): Uint8Array => {
  const bytes = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      bytes[offset] = (x * 7 + y * 3) % 256;
      bytes[offset + 1] = (x * 2 + y * 6) % 256;
      bytes[offset + 2] = (x * 3 + y * 4) % 256;
    }
  }
  return bytes;
};

// Four 16 × 16 quadrants of blue, yellow, red and cyan put Cb and Cr near both ends of their range, where an error of 0.02 in a conversion coefficient moves a sample by more than 2.
const saturated = (): Uint8Array => {
  const colours = [
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 0],
    [0, 255, 255],
  ];
  return Uint8Array.from(Array.from({ length: 32 * 32 }, (_, index) => colours[Math.floor(index / 512) * 2 + Math.floor((index % 32) / 16)] ?? []).flat());
};

const decoded = (bytes: Uint8Array): Uint8Array => {
  const result = decodeJpeg(bytes);
  const output = new Uint8Array(result.width * result.height * result.components);
  let offset = 0;
  for (const row of result.rows()) {
    output.set(row, offset);
    offset += row.length;
  }
  expect(offset).toBe(output.length);
  return output;
};

const maximumDifference = (actual: Uint8Array, reference: Uint8Array): number => {
  let maximum = 0;
  for (let index = 0; index < actual.length; index++) {
    maximum = Math.max(maximum, Math.abs((actual[index] ?? 0) - (reference[index] ?? 0)));
  }
  return maximum;
};

const markerOffset = (bytes: Uint8Array, marker: number): number => {
  for (let index = 0; index < bytes.length - 1; index++) {
    if (bytes[index] === 0xff && bytes[index + 1] === marker) {
      return index;
    }
  }
  throw new Error(`marker ${String(marker)} is missing`);
};

const withAdobe = (jpeg: Uint8Array, transform: number): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xee, 0, 14, 65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, transform, ...jpeg.subarray(2)]);

const gray = (): Uint8Array => Uint8Array.from(Array.from({ length: 32 * 32 }, (_, index) => (index * 31) % 256));

const fullyDecode = (jpeg: Uint8Array): void => {
  const rows = decodeJpeg(jpeg).rows();
  while (rows.next().done !== true) {
    // Decoding each row is the check: a malformed row throws, and the rows themselves are not kept.
  }
};

const rowsWith = (jpeg: Uint8Array, colorTransform: 0 | 1): Uint8Array => {
  const image = decodeJpeg(jpeg, { colorTransform });
  const output = new Uint8Array(image.width * image.height * image.components);
  let offset = 0;
  for (const row of image.rows()) {
    output.set(row, offset);
    offset += row.length;
  }
  return output;
};

// ITU-T T.81 (1992), B.1.1.4: a marker, then a two-byte length that counts itself, then the parameters.
const jpegSegment = (marker: number, payload: ReadonlyArray<number>): Array<number> => [
  255,
  marker,
  Math.floor((payload.length + 2) / 256),
  (payload.length + 2) % 256,
  ...payload,
];

const clamped = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

// ITU-T T.871 (2011), 7: R = Y + 1.402 (Cr − 128), G = Y − 0.344136 (Cb − 128) − 0.714136 (Cr − 128), B = Y + 1.772 (Cb − 128).
const ycbcrToRgb = (samples: Uint8Array): Uint8Array =>
  Uint8Array.from({ length: samples.length }, (_, index) => {
    const pixel = index - (index % 3);
    const [y = 0, cb = 128, cr = 128] = samples.subarray(pixel, pixel + 3);
    return clamped([y + 1.402 * (cr - 128), y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128), y + 1.772 * (cb - 128)][index % 3] ?? 0);
  });

const parseReason = (run: () => void): string | undefined => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ParseError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('JPEG was accepted');
};

const unsupportedReason = (run: () => void): string | undefined => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof UnsupportedFeatureError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('JPEG was accepted');
};

const djpeg = async (jpeg: Uint8Array): Promise<Uint8Array> => {
  const { stdout, stderr } = await runChecked('djpeg', ['-pnm'], jpeg);
  expect(stderr).toBe('');
  const header = new TextEncoder().encode('P5\n8 8\n255\n');
  expect(stdout.subarray(0, header.length)).toStrictEqual(header);
  expect(stdout).toHaveLength(header.length + 64);
  return stdout.subarray(header.length);
};

const zrlJpeg = (nonzeroAc = 47, finalSymbol = 0xf0): Uint8Array => {
  const bits = `0${'001'.repeat(nonzeroAc)}01${finalSymbol === 0xf1 ? '1' : ''}`;
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '1');
  // ITU-T T.81 (1992), F.1.2.3: a 0xFF byte of entropy-coded data is followed by a stuffed 0x00.
  const entropy = Array.from({ length: padded.length / 8 }, (_, index) => Number.parseInt(padded.slice(index * 8, index * 8 + 8), 2)).flatMap(value =>
    value === 0xff ? [0xff, 0] : [value],
  );
  return Uint8Array.from([
    255,
    0xd8,
    ...jpegSegment(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...jpegSegment(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...jpegSegment(0xc4, [0x10, 0, 2, ...Array.from({ length: 14 }, () => 0), 1, finalSymbol]),
    ...jpegSegment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]),
    ...jpegSegment(0xda, [1, 1, 0, 0, 63, 0]),
    ...entropy,
    255,
    0xd9,
  ]);
};

describe('jpeg decoding against ImageMagick libjpeg', () => {
  it('accepts a final ZRL that ends at coefficient 64 and matches djpeg', async () => {
    const jpeg = zrlJpeg();
    expect(maximumDifference(decoded(jpeg), await djpeg(jpeg))).toBeLessThanOrEqual(1);
  });

  it('accepts a final nonzero AC coefficient at position 63 and matches djpeg', async () => {
    // 47 coefficients, then a run of 15 zeros puts the last coefficient at position 63, the last one a block has.
    const jpeg = zrlJpeg(47, 0xf1);
    expect(maximumDifference(decoded(jpeg), await djpeg(jpeg))).toBeLessThanOrEqual(1);
  });

  it('rejects a nonzero AC coefficient beyond position 63', () => {
    expect(() => decoded(zrlJpeg(48, 0xf1))).toThrow(ParseError);
  });

  it('crops partial 2 × 2 MCUs at the right and bottom edges as libjpeg does', async () => {
    const jpeg = await magick(['-size', '33x17', '-depth', '8', 'rgb:-', '-sampling-factor', '2x2,1x1,1x1', '-quality', '90', 'jpeg:-'], rgb(33, 17));
    const reference = await magick(['-define', 'jpeg:fancy-upsampling=off', 'jpeg:-', '-depth', '8', 'rgb:-'], jpeg);
    const actual = decoded(jpeg);
    expect(actual).toHaveLength(33 * 17 * 3);
    expect(reference).toHaveLength(33 * 17 * 3);
    expect(maximumDifference(actual, reference)).toBeLessThanOrEqual(2);
  });

  it.each(['1x1,1x1,1x1', '2x1,1x1,1x1', '2x2,1x1,1x1'])('decodes generated RGB JPEG with sampling %s', async sampling => {
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-sampling-factor', sampling, '-quality', '90', 'jpeg:-'], rgb());
    const reference = await magick(['-define', 'jpeg:fancy-upsampling=off', 'jpeg:-', '-depth', '8', 'rgb:-'], jpeg);
    const actual = decoded(jpeg);
    expect(actual).toHaveLength(reference.length);
    expect(maximumDifference(actual, reference)).toBeLessThanOrEqual(2);
  });

  it('decodes generated grayscale and 8-bit SOF1 images', async () => {
    const monochrome = await magick(['-size', '32x32', '-depth', '8', 'gray:-', '-quality', '90', 'jpeg:-'], gray());
    const grayReference = await magick(['jpeg:-', '-depth', '8', 'gray:-'], monochrome);
    expect(maximumDifference(decoded(monochrome), grayReference)).toBeLessThanOrEqual(1);
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-sampling-factor', '1x1,1x1,1x1', '-quality', '90', 'jpeg:-'], rgb());
    const extended = Uint8Array.from(jpeg);
    extended[markerOffset(extended, 0xc0) + 1] = 0xc1;
    expect(decoded(extended)).toStrictEqual(decoded(jpeg));
  });

  it('decodes restart intervals and reads Adobe APP14 colour transform', async () => {
    const jpeg = await magick(
      ['-size', '32x32', '-depth', '8', 'rgb:-', '-sampling-factor', '1x1,1x1,1x1', '-define', 'jpeg:restart-interval=4', '-quality', '90', 'jpeg:-'],
      rgb(),
    );
    expect(markerOffset(jpeg, 0xdd)).toBeGreaterThan(0);
    const reference = await magick(['-define', 'jpeg:fancy-upsampling=off', 'jpeg:-', '-depth', '8', 'rgb:-'], jpeg);
    expect(maximumDifference(decoded(jpeg), reference)).toBeLessThanOrEqual(2);
    const adobe = withAdobe(jpeg, 1);
    expect(decodeJpeg(adobe).adobeColorTransform).toBe(1);
    expect(decoded(adobe)).toStrictEqual(decoded(jpeg));
  });

  it('uses PDF ColorTransform only when APP14 is absent', async () => {
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-quality', '90', 'jpeg:-'], rgb());
    // With colorTransform 0 the samples stay YCbCr, and converting them reproduces the default output.
    expect(maximumDifference(ycbcrToRgb(rowsWith(jpeg, 0)), decoded(jpeg))).toBeLessThanOrEqual(1);
    expect(maximumDifference(rowsWith(jpeg, 0), decoded(jpeg))).toBeGreaterThan(2);
    expect(rowsWith(withAdobe(jpeg, 1), 0)).toStrictEqual(decoded(jpeg));
    const vivid = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-quality', '90', 'jpeg:-'], saturated());
    expect(maximumDifference(ycbcrToRgb(rowsWith(vivid, 0)), decoded(vivid))).toBeLessThanOrEqual(1);
  });

  it('refuses multi-scan and Adobe YCCK markers with typed reasons', async () => {
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-quality', '90', 'jpeg:-'], rgb());
    const multiscanned = Uint8Array.from(jpeg);
    multiscanned[markerOffset(multiscanned, 0xda) + 4] = 2;
    expect(unsupportedReason(() => decodeJpeg(multiscanned))).toBe('jpeg-multi-scan');
    expect(unsupportedReason(() => decodeJpeg(withAdobe(jpeg, 2)))).toBe('jpeg-color-transform');
  });

  it('reports every truncation of a generated JPEG as truncated and invalid marker lengths by reason', async () => {
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-quality', '90', 'jpeg:-'], rgb());
    for (let length = 0; length < jpeg.length; length++) {
      expect(
        parseReason(() => {
          fullyDecode(jpeg.subarray(0, length));
        }),
      ).toBe('image-truncated');
    }
    const quantization = markerOffset(jpeg, 0xdb);
    for (const [length, reason] of [
      [0, 'image-invalid'],
      [1, 'image-invalid'],
      [65_535, 'image-truncated'],
    ] as const) {
      const malformed = Uint8Array.from(jpeg);
      malformed[quantization + 2] = Math.floor(length / 256);
      malformed[quantization + 3] = length % 256;
      expect(
        parseReason(() => {
          fullyDecode(malformed);
        }),
      ).toBe(reason);
    }
  });

  it('returns the ICC profile ImageMagick embeds and refuses its progressive output', async () => {
    const profilePath = path.resolve(import.meta.dirname, '../../../../tests/fixtures/icc/sRGB-v4.icc');
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-profile', profilePath, '-quality', '90', 'jpeg:-'], rgb());
    expect(decodeJpeg(jpeg).iccProfile).toStrictEqual(new Uint8Array(await readFile(profilePath)));
    const progressive = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-interlace', 'JPEG', '-quality', '90', 'jpeg:-'], rgb());
    expect(() => decodeJpeg(progressive)).toThrow(UnsupportedFeatureError);
  });
});

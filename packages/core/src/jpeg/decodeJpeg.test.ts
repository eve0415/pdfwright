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
    if (error instanceof UnsupportedFeatureError) return error.reason;
    throw error;
  }
  throw new Error('JPEG was accepted');
};

const coefficients = (): Int32Array => Int32Array.from(Array.from({ length: 64 }, (_, index) => (index === 0 ? 128 : ((index * 37) % 23) - 11)));

const jpegSegment = (marker: number, payload: readonly number[]): number[] => [255, marker, 0, payload.length + 2, ...payload];

const grayJpeg = (entropy: readonly number[]): Uint8Array =>
  Uint8Array.from([
    255,
    0xd8,
    ...jpegSegment(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...jpegSegment(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...jpegSegment(0xc4, [0x10, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...jpegSegment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]),
    ...jpegSegment(0xda, [1, 1, 0, 0, 63, 0]),
    ...entropy,
    255,
    0xd9,
  ]);

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

  it('rejects every truncation of a marker sequence without hanging', () => {
    const bytes = frame(0xc0);
    for (let length = 0; length < bytes.length; length++) {
      expect(() => decodeJpeg(bytes.subarray(0, length))).toThrow(ParseError);
    }
  });

  it('rejects deterministic garbage marker and length mutations with typed errors', () => {
    for (let seed = 0; seed < 256; seed++) {
      const bytes = frame(0xc0);
      const offset = seed % bytes.length;
      bytes[offset] = seed;
      expect(() => decodeJpeg(bytes)).toThrow(PdfwrightError);
    }
  });
});

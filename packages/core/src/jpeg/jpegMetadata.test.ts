import type { ExifOrientation, ParseReason } from '../index.ts';

import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import { InvalidArgumentError, ParseError, ResourceLimitError, UnsupportedFeatureError, decodeJpeg, parseIccProfile } from '../index.ts';

// The JPEGs below are written by hand: one 8×8 grey data unit whose DC difference and AC end-of-block are one-bit Huffman codes, so every sample is 128.
const segment = (marker: number, payload: readonly number[]): number[] => [
  255,
  marker,
  Math.floor((payload.length + 2) / 256),
  (payload.length + 2) % 256,
  ...payload,
];

const grayJpeg = (extra: readonly number[] = [], sof = 0xc0): Uint8Array =>
  Uint8Array.from([
    255,
    0xd8,
    ...extra,
    ...segment(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...segment(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...segment(0xc4, [0x10, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...segment(sof, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    0x3f,
    255,
    0xd9,
  ]);

const ascii = (text: string): number[] => Array.from(text, character => character.codePointAt(0) ?? 0);

// ICC.1:2022, Annex B.4: "ICC_PROFILE", a null byte, the 1-based sequence number, the chunk count, then the chunk.
const iccSegment = (sequence: number, count: number, chunk: Uint8Array): number[] => segment(0xe2, [...ascii('ICC_PROFILE'), 0, sequence, count, ...chunk]);

const iccChunks = (profile: Uint8Array, size: number): Uint8Array[] =>
  Array.from({ length: Math.ceil(profile.length / size) }, (_, index) => profile.subarray(index * size, (index + 1) * size));

// TIFF 6.0, Section 2: byte order, 42, the IFD0 offset 8, then one 12-byte entry.
const exifSegment = (order: 'II' | 'MM', entry: { readonly tag: number; readonly type: number; readonly count: number; readonly value: number }): number[] => {
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const view = new DataView(tiff.buffer);
  const little = order === 'II';
  tiff.set(ascii(order));
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 1, little);
  view.setUint16(10, entry.tag, little);
  view.setUint16(12, entry.type, little);
  view.setUint32(14, entry.count, little);
  view.setUint16(18, entry.value, little);
  return segment(0xe1, [...ascii('Exif'), 0, 0, ...tiff]);
};

const orientation = (order: 'II' | 'MM', value: number): number[] => exifSegment(order, { tag: 0x0112, type: 3, count: 1, value });

const decodeReason = (jpeg: Uint8Array): ParseReason | undefined => {
  try {
    decodeJpeg(jpeg);
  } catch (error: unknown) {
    if (error instanceof ParseError) return error.reason;
    throw error;
  }
  throw new Error('JPEG was accepted');
};

const orientationOf = (extra: readonly number[]): ExifOrientation | undefined => decodeJpeg(grayJpeg(extra)).orientation;

const profileOf = (jpeg: Uint8Array): Uint8Array => {
  const profile = decodeJpeg(jpeg).iccProfile;
  if (profile === undefined) throw new Error('JPEG has no ICC profile');
  return profile;
};

const UNIFORM_ROWS = Array.from({ length: 8 }, () => new Uint8Array(8).fill(128));

describe('decodeJpeg public surface', () => {
  it('decodes a baseline grey image and reports no metadata it does not carry', () => {
    const image = decodeJpeg(grayJpeg());
    expect([image.width, image.height, image.components, image.colorSpace, image.adobeColorTransform, image.iccProfile, image.orientation]).toStrictEqual([
      8,
      8,
      1,
      'gray',
      undefined,
      undefined,
      undefined,
    ]);
    expect([...image.rows()]).toStrictEqual(UNIFORM_ROWS);
    expect([...image.rows()]).toStrictEqual(UNIFORM_ROWS);
  });

  it('reassembles a multi-segment ICC profile whose chunks arrive out of order', () => {
    const chunks = iccChunks(fograBytes, 65_519);
    expect(chunks.length).toBeGreaterThan(2);
    const segments = chunks.map((chunk, index) => iccSegment(index + 1, chunks.length, chunk));
    const profile = profileOf(grayJpeg(segments.toReversed().flat()));
    expect(profile).toStrictEqual(fograBytes);
    expect(parseIccProfile(profile).header.colorSpace).toBe('CMYK');
  });

  it.each([
    ['a missing chunk', [iccSegment(1, 2, Uint8Array.of(1))]],
    ['a repeated chunk', [iccSegment(1, 2, Uint8Array.of(1)), iccSegment(1, 2, Uint8Array.of(1)), iccSegment(2, 2, Uint8Array.of(2))]],
    ['disagreeing counts', [iccSegment(1, 2, Uint8Array.of(1)), iccSegment(2, 3, Uint8Array.of(2))]],
    ['sequence number zero', [iccSegment(0, 1, Uint8Array.of(1))]],
    ['a sequence number above the count', [iccSegment(2, 1, Uint8Array.of(1))]],
  ])('refuses an ICC profile with %s', (_, segments) => {
    const jpeg = grayJpeg(segments.flat());
    expect(decodeReason(jpeg)).toBe('image-invalid');
  });

  it.each([
    ['II', 6],
    ['MM', 6],
    ['II', 1],
    ['MM', 8],
  ] as const)('reads the %s Exif Orientation %i', (order, value) => {
    expect(orientationOf(orientation(order, value))).toBe(value);
  });

  it('reads only the first Exif segment and ignores unreadable Exif data', () => {
    expect(orientationOf([...orientation('II', 3), ...orientation('II', 6)])).toBe(3);
    const unreadable = [
      orientation('II', 0),
      orientation('MM', 9),
      exifSegment('II', { tag: 0x0112, type: 4, count: 1, value: 6 }),
      exifSegment('II', { tag: 0x0112, type: 3, count: 2, value: 6 }),
      exifSegment('MM', { tag: 0x0110, type: 3, count: 1, value: 6 }),
      segment(0xe1, [...ascii('Exif'), 0, 0, ...ascii('XX'), 0, 42]),
      segment(0xe1, [...ascii('Exif'), 0, 0, ...ascii('II'), 42, 0, 255, 255, 0, 0]),
      segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0]),
    ];
    for (const extra of unreadable) expect(orientationOf(extra)).toBeUndefined();
  });

  it('refuses images past its limits and invalid limits', () => {
    expect(() => decodeJpeg(grayJpeg(), { maxDecodedBytes: 63 })).toThrow(ResourceLimitError);
    expect(decodeJpeg(grayJpeg(), { maxDecodedBytes: 64 }).width).toBe(8);
    expect(() => decodeJpeg(grayJpeg(), { maxRowBytes: 64 })).toThrow(ResourceLimitError);
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => decodeJpeg(grayJpeg(), { maxDecodedBytes: value })).toThrow(InvalidArgumentError);
      expect(() => decodeJpeg(grayJpeg(), { maxRowBytes: value })).toThrow(InvalidArgumentError);
    }
  });

  it('refuses progressive JPEG and reports truncation by reason', () => {
    expect(() => decodeJpeg(grayJpeg([], 0xc2))).toThrow(UnsupportedFeatureError);
    const bytes = grayJpeg();
    expect(decodeReason(bytes.subarray(0, 20))).toBe('image-truncated');
    expect(decodeReason(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe('image-invalid');
  });
});

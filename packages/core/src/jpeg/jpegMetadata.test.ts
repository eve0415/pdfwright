import type { ExifOrientation, ParseReason } from '../index.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import { InvalidArgumentError, ParseError, ResourceLimitError, UnsupportedFeatureError, decodeJpeg, parseIccProfile } from '../index.ts';

// The JPEGs below are written by hand: one 8×8 grey data unit whose DC difference and AC end-of-block are one-bit Huffman codes, so every sample is 128.
const segment = (marker: number, payload: ReadonlyArray<number>): Array<number> => [
  255,
  marker,
  Math.floor((payload.length + 2) / 256),
  (payload.length + 2) % 256,
  ...payload,
];

const grayJpeg = (extra: ReadonlyArray<number> = [], sof = 0xc0): Uint8Array =>
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

const ascii = (text: string): Array<number> => Array.from(text, character => character.codePointAt(0) ?? 0);

// ICC.1:2022, Annex B.4: "ICC_PROFILE", a null byte, the 1-based sequence number, the chunk count, then the chunk.
const iccSegment = (sequence: number, count: number, chunk: Uint8Array): Array<number> =>
  segment(0xe2, [...ascii('ICC_PROFILE'), 0, sequence, count, ...chunk]);

const iccChunks = (profile: Uint8Array, size: number): Array<Uint8Array> =>
  Array.from({ length: Math.ceil(profile.length / size) }, (_, index) => profile.subarray(index * size, (index + 1) * size));

interface IfdEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  readonly value: number;
}

// TIFF 6.0, Section 2: byte order, 42, the IFD0 offset 8, the entry count, 12-byte entries, then the next IFD offset.
const tiffHeader = (order: 'II' | 'MM', entries: ReadonlyArray<IfdEntry>): Uint8Array => {
  const tiff = new Uint8Array(8 + 2 + 12 * entries.length + 4);
  const view = new DataView(tiff.buffer);
  const little = order === 'II';
  tiff.set(ascii(order));
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, entries.length, little);
  for (const [index, entry] of entries.entries()) {
    const position = 10 + index * 12;
    view.setUint16(position, entry.tag, little);
    view.setUint16(position + 2, entry.type, little);
    view.setUint32(position + 4, entry.count, little);
    view.setUint16(position + 8, entry.value, little);
  }
  return tiff;
};

const exifPayload = (tiff: ReadonlyArray<number> | Uint8Array): Array<number> => segment(0xe1, [...ascii('Exif'), 0, 0, ...tiff]);

const exifSegment = (order: 'II' | 'MM', entry: IfdEntry): Array<number> => exifPayload(tiffHeader(order, [entry]));

const orientation = (order: 'II' | 'MM', value: number): Array<number> => exifSegment(order, { tag: 0x01_12, type: 3, count: 1, value });

const decodeReason = (jpeg: Uint8Array): ParseReason | undefined => {
  try {
    decodeJpeg(jpeg);
  } catch (error: unknown) {
    if (error instanceof ParseError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('JPEG was accepted');
};

const parseOffset = (jpeg: Uint8Array): number => {
  try {
    decodeJpeg(jpeg);
  } catch (error: unknown) {
    if (error instanceof ParseError) {
      return error.offset;
    }
    throw error;
  }
  throw new Error('JPEG was accepted');
};

const orientationOf = (extra: ReadonlyArray<number>): ExifOrientation | undefined => decodeJpeg(grayJpeg(extra)).orientation;

const profileOf = (jpeg: Uint8Array): Uint8Array => {
  const profile = decodeJpeg(jpeg).iccProfile;
  if (profile === undefined) {
    throw new Error('JPEG has no ICC profile');
  }
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
    // Each set below would be complete under the last count it declares, so only the rule the row names refuses it.
    ['disagreeing counts', [iccSegment(1, 3, Uint8Array.of(1)), iccSegment(2, 2, Uint8Array.of(2))]],
    ['sequence number zero', [iccSegment(0, 1, Uint8Array.of(1)), iccSegment(1, 1, Uint8Array.of(2))]],
    ['a sequence number above the count', [iccSegment(1, 1, Uint8Array.of(1)), iccSegment(2, 1, Uint8Array.of(2))]],
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
      exifSegment('II', { tag: 0x01_12, type: 4, count: 1, value: 6 }),
      exifSegment('II', { tag: 0x01_12, type: 3, count: 2, value: 6 }),
      exifSegment('MM', { tag: 0x01_10, type: 3, count: 1, value: 6 }),
      // A whole big-endian TIFF with Orientation 6 whose byte order mark is neither II nor MM.
      exifPayload([...ascii('XX'), ...tiffHeader('MM', [{ tag: 0x01_12, type: 3, count: 1, value: 6 }]).subarray(2)]),
      // Six TIFF bytes cannot hold the IFD0 offset.
      exifPayload([...ascii('II'), 42, 0, 8, 0]),
      segment(0xe1, [...ascii('Exif'), 0, 0, ...ascii('II'), 42, 0, 255, 255, 0, 0]),
      segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0]),
    ];
    for (const extra of unreadable) {
      expect(orientationOf(extra)).toBeUndefined();
    }
  });

  it('refuses images past its limits and invalid limits', () => {
    expect(() => decodeJpeg(grayJpeg(), { maxDecodedBytes: 63 })).toThrow(ResourceLimitError);
    expect(decodeJpeg(grayJpeg(), { maxDecodedBytes: 64 }).width).toBe(8);
    // One 8 × 8 MCU stores 64 samples and the row holds 8 more: 72 bytes.
    expect(() => decodeJpeg(grayJpeg(), { maxRowBytes: 71 })).toThrow(ResourceLimitError);
    expect([...decodeJpeg(grayJpeg(), { maxRowBytes: 72 }).rows()]).toStrictEqual(UNIFORM_ROWS);
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

  it.each([
    ['no sequence number or count', []],
    ['a sequence number and no count', [1]],
  ])('refuses an ICC chunk header with %s at the header', (_, header) => {
    // A fill byte follows the segment (ITU-T T.81 (1992), B.1.1.2), so a reader that took the chunk header from past the segment's end would read chunk 255 of 255 there and fail later, at the scan.
    const jpeg = grayJpeg([...segment(0xe2, [...ascii('ICC_PROFILE'), 0, ...header]), 0xff]);
    expect(decodeReason(jpeg)).toBe('image-invalid');
    // The APP2 payload starts at byte 6, after SOI and the segment's marker and length, and its chunk header follows the 12-byte identifier.
    expect(parseOffset(jpeg)).toBe(18);
  });

  it('ignores an APP2 segment that is not an ICC profile chunk', () => {
    // Read as an ICC chunk, bytes 12 and 13 would declare chunk 1 of 1.
    const flashPix = segment(0xe2, [...ascii('FPXR'), 0, 0, 1, 2, 3, 4, 5, 6, 7, 1, 1, 9, 9]);
    expect(decodeJpeg(grayJpeg(flashPix)).iccProfile).toBeUndefined();
  });

  it('returns a single-chunk profile and accepts an empty chunk', () => {
    expect(profileOf(grayJpeg(iccSegment(1, 1, Uint8Array.of(7, 8, 9))))).toStrictEqual(Uint8Array.of(7, 8, 9));
    expect(profileOf(grayJpeg([...iccSegment(1, 2, Uint8Array.of(1, 2, 3)), ...iccSegment(2, 2, new Uint8Array())]))).toStrictEqual(Uint8Array.of(1, 2, 3));
  });

  it('finds Orientation after another IFD0 entry', () => {
    const tiff = tiffHeader('MM', [
      { tag: 0x01_10, type: 2, count: 4, value: 0x41_42 },
      { tag: 0x01_12, type: 3, count: 1, value: 6 },
    ]);
    expect(orientationOf(exifPayload(tiff))).toBe(6);
  });

  it('stops at an IFD0 entry that does not fit in the segment', () => {
    // TIFF 6.0, Section 2: an IFD entry is 12 bytes, and the Orientation entry starts at TIFF byte 22, after the header, the entry count and one entry.
    const whole = tiffHeader('MM', [
      { tag: 0x01_10, type: 2, count: 4, value: 0x41_42 },
      { tag: 0x01_12, type: 3, count: 1, value: 6 },
    ]);
    // Eleven bytes hold the tag, type, count and both value bytes, so only the length check refuses the entry.
    expect(orientationOf(exifPayload(whole.subarray(0, 33)))).toBeUndefined();
    expect(orientationOf(exifPayload(whole.subarray(0, 34)))).toBe(6);
  });

  it('reads Exif only under the identifier Exif followed by two null bytes', () => {
    const tiff = tiffHeader('II', [{ tag: 0x01_12, type: 3, count: 1, value: 6 }]);
    expect(orientationOf(segment(0xe1, [...ascii('Exif'), 0, ...ascii('x'), ...tiff]))).toBeUndefined();
  });
});

const iccCases = fc.record({ profile: fc.uint8Array({ minLength: 1, maxLength: 300 }), size: fc.integer({ min: 2, max: 64 }) }).chain(({ profile, size }) => {
  const chunks = iccChunks(profile, size);
  const indices = chunks.map((_, index) => index);
  return fc.shuffledSubarray(indices, { minLength: indices.length, maxLength: indices.length }).map(order => ({ profile, chunks, order }));
});

const exifCases = fc.record({
  order: fc.constantFrom('II', 'MM'),
  value: fc.integer({ min: 1, max: 8 }),
  fillers: fc.array(fc.record({ tag: fc.integer({ min: 0, max: 0xff_ff }).filter(tag => tag !== 0x01_12), value: fc.integer({ min: 0, max: 0xff_ff }) }), {
    maxLength: 6,
  }),
  position: fc.nat({ max: 6 }),
});

describe('properties', () => {
  it('reassembles an ICC profile from chunks in any order', () => {
    fc.assert(
      fc.property(iccCases, ({ profile, chunks, order }) => {
        const segments = order.flatMap(index => iccSegment(index + 1, chunks.length, chunks[index] ?? new Uint8Array()));
        expect(profileOf(grayJpeg(segments))).toStrictEqual(profile);
      }),
    );
  });

  it('reads Orientation wherever it sits among the IFD0 entries', () => {
    fc.assert(
      fc.property(exifCases, ({ order, value, fillers, position }) => {
        const entries = fillers.map(filler => ({ tag: filler.tag, type: 3, count: 1, value: filler.value }));
        entries.splice(Math.min(position, entries.length), 0, { tag: 0x01_12, type: 3, count: 1, value });
        expect(orientationOf(exifPayload(tiffHeader(order, entries)))).toBe(value);
      }),
    );
  });
});

import type { ParseReason, UnsupportedFeatureReason } from '../index.ts';
import type { TestPng } from './pngTestEncoder.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import srgbV4Bytes from '../../../../tests/fixtures/icc/sRGB-v4.icc?icc-bytes';
import { deflateZlib } from '../flate/deflate.ts';
import { InvalidArgumentError, ParseError, ResourceLimitError, UnsupportedFeatureError, decodePng, pngToRgba8 } from '../index.ts';

import { crc32 } from './crc32.ts';
import { asciiBytes, encodeTestPng, filteredImageData, pngChunk, uint32Bytes } from './pngTestEncoder.ts';

// Every fixture here is encoded in the test by pngTestEncoder.ts from sample values computed below, with this repository's deflater and CRC-32, so the decoder is checked against the values the encoder was given.
const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

interface Size {
  readonly width: number;
  readonly height: number;
  readonly interlaced?: boolean;
}

const pattern = (count: number, limit: number): Array<number> => Array.from({ length: count }, (_, index) => (index * 7919 + 13) % limit);

const palette = (entries: number): Array<number> => Array.from({ length: entries * 3 }, (_, index) => (index * 37) % 256);

const image = (colorType: number, bitDepth: number, size: Size): TestPng => {
  const count = size.width * size.height * (CHANNELS.get(colorType) ?? 1);
  const levels = Math.min(256, 2 ** bitDepth);
  if (colorType === 3) {
    return { ...size, colorType, bitDepth, samples: pattern(count, levels), before: [pngChunk('PLTE', palette(levels))] };
  }
  return { ...size, colorType, bitDepth, samples: pattern(count, 2 ** bitDepth) };
};

const bytes = (text: string): Uint8Array => Uint8Array.from(asciiBytes(text));

const reason = (run: () => void): ParseReason | UnsupportedFeatureReason | undefined => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ParseError || error instanceof UnsupportedFeatureError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('PNG was accepted');
};

const decodeReason = (png: Uint8Array): ParseReason | UnsupportedFeatureReason | undefined =>
  reason(() => {
    decodePng(png);
  });

const streamReason = (source: TestPng, stream: Uint8Array): ParseReason | UnsupportedFeatureReason | undefined =>
  decodeReason(encodeTestPng({ ...source, stream }));

const flipped = (png: Uint8Array, index: number): Uint8Array => {
  const copy = Uint8Array.from(png);
  copy[index] = 255 - (copy[index] ?? 0);
  return copy;
};

const rgba = (source: TestPng): Array<number> => [...pngToRgba8(decodePng(encodeTestPng(source)))];

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const concat = (...parts: ReadonlyArray<ReadonlyArray<number> | Uint8Array>): Uint8Array => Uint8Array.from(parts.flatMap(part => [...part]));

interface HeaderFields {
  readonly width?: number;
  readonly height?: number;
  readonly bitDepth?: number;
  readonly colorType?: number;
  readonly compression?: number;
  readonly filter?: number;
  readonly interlace?: number;
}

// PNG Third Edition, 11.2.1: width, height, bit depth, colour type, compression method, filter method and interlace method; a 1 × 1 8-bit grey image by default.
const headerData = (fields: HeaderFields): Array<number> => [
  ...uint32Bytes(fields.width ?? 1),
  ...uint32Bytes(fields.height ?? 1),
  fields.bitDepth ?? 8,
  fields.colorType ?? 0,
  fields.compression ?? 0,
  fields.filter ?? 0,
  fields.interlace ?? 0,
];

const GRAY_PIXEL = image(0, 8, { width: 1, height: 1 });

// A file whose IHDR carries `header` and whose image data is one grey pixel unless given.
const withHeader = (header: ReadonlyArray<number>, filtered: Uint8Array = filteredImageData(GRAY_PIXEL)): Uint8Array =>
  concat(SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateZlib(filtered)), pngChunk('IEND'));

// Inserts chunks between the last IDAT and IEND, which is the last 12 bytes of an encoded test PNG.
const beforeIend = (png: Uint8Array, ...chunks: ReadonlyArray<Uint8Array>): Uint8Array =>
  concat(png.subarray(0, png.length - 12), ...chunks, png.subarray(png.length - 12));

const RGB_PIXEL = image(2, 8, { width: 1, height: 1 });

const profileChunk = (name: ReadonlyArray<number>, method = 0, stream: Uint8Array = deflateZlib(srgbV4Bytes)): Uint8Array =>
  pngChunk('iCCP', [...name, 0, method, ...stream]);

const SIZES: ReadonlyArray<Size> = [
  { width: 1, height: 1 },
  { width: 3, height: 2 },
  { width: 5, height: 5 },
  { width: 13, height: 9 },
];

const CASES = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
].flatMap(([colorType = 0, bitDepth = 8]) => SIZES.flatMap(size => [false, true].map(interlaced => image(colorType, bitDepth, { ...size, interlaced }))));

describe('png chunk CRC-32', () => {
  it('matches the ISO 3309 check value and the IEND chunk CRC', () => {
    const first = crc32(bytes('12345'));
    expect(crc32(bytes('123456789'))).toBe(0xcb_f4_39_26);
    expect(crc32(bytes('IEND'))).toBe(0xae_42_60_82);
    expect(crc32(bytes('6789'), first)).toBe(0xcb_f4_39_26);
  });

  it('is 0 for no bytes', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('decoding PNG datastreams', () => {
  it.each(CASES)('decodes colour type $colorType at bit depth $bitDepth, $width × $height, interlaced $interlaced', source => {
    const decoded = decodePng(encodeTestPng({ ...source, idatChunks: 3 }));
    expect([
      decoded.width,
      decoded.height,
      decoded.bitDepth,
      decoded.interlaced,
      decoded.samples.BYTES_PER_ELEMENT === Uint16Array.BYTES_PER_ELEMENT,
    ]).toStrictEqual([source.width, source.height, source.bitDepth, source.interlaced, source.bitDepth === 16]);
    expect([...decoded.samples]).toStrictEqual(source.samples);
  });

  it('names the colour types and channel counts', () => {
    const names = [0, 2, 3, 4, 6].map(colorType => {
      const decoded = decodePng(encodeTestPng(image(colorType, 8, { width: 2, height: 2 })));
      return [decoded.colorType, decoded.channels];
    });
    expect(names).toStrictEqual([
      ['gray', 1],
      ['rgb', 3],
      ['indexed', 1],
      ['gray-alpha', 2],
      ['rgba', 4],
    ]);
  });

  it('passes iCCP, sRGB, gAMA and cHRM through as data', () => {
    const chromaticities = [31_270, 32_900, 64_000, 33_000, 30_000, 60_000, 15_000, 6000];
    const before = [
      pngChunk('iCCP', [...asciiBytes('sRGB v4'), 0, 0, ...deflateZlib(srgbV4Bytes)]),
      pngChunk('sRGB', [1]),
      pngChunk('gAMA', uint32Bytes(45_455)),
      pngChunk(
        'cHRM',
        chromaticities.flatMap(value => uint32Bytes(value)),
      ),
    ];
    const decoded = decodePng(encodeTestPng({ ...image(2, 8, { width: 2, height: 2 }), before }));
    expect(decoded.iccProfile).toStrictEqual({ name: 'sRGB v4', profile: srgbV4Bytes });
    expect([decoded.srgbIntent, decoded.gamma]).toStrictEqual(['relative-colorimetric', 45_455]);
    expect(decoded.chromaticities).toStrictEqual({
      whiteX: 31_270,
      whiteY: 32_900,
      redX: 64_000,
      redY: 33_000,
      greenX: 30_000,
      greenY: 60_000,
      blueX: 15_000,
      blueY: 6000,
    });
  });

  it('reports no colour or transparency data a file does not carry', () => {
    const plain = decodePng(encodeTestPng(image(2, 8, { width: 2, height: 2 })));
    const absent = [plain.iccProfile, plain.srgbIntent, plain.gamma, plain.chromaticities, plain.palette, plain.paletteAlpha, plain.transparentColor];
    expect(absent.filter(value => value !== undefined)).toStrictEqual([]);
  });

  it('ignores unknown ancillary chunks and bytes after IEND', () => {
    const source = image(0, 8, { width: 3, height: 3 });
    const png = encodeTestPng({ ...source, before: [pngChunk('tEXt', asciiBytes('Comment\0test')), pngChunk('zzZz', [1, 2, 3])] });
    expect([...decodePng(Uint8Array.from([...png, 0, 1, 2])).samples]).toStrictEqual(source.samples);
  });

  it('refuses CRC mismatches in critical and ancillary chunks and a damaged signature', () => {
    const png = encodeTestPng({ ...image(0, 8, { width: 2, height: 2 }), before: [pngChunk('gAMA', uint32Bytes(45_455))] });
    // Byte 29 is the first byte of the IHDR CRC; byte 41 is the first byte of the gAMA data.
    expect(decodeReason(flipped(png, 29))).toBe('image-crc-mismatch');
    expect(decodeReason(flipped(png, 41))).toBe('image-crc-mismatch');
    expect(decodeReason(flipped(png, 1))).toBe('image-invalid');
  });

  it('refuses an Adler-32 mismatch, truncation, and image data of the wrong length', () => {
    const source = image(2, 8, { width: 4, height: 3 });
    const filtered = filteredImageData(source);
    const stream = deflateZlib(filtered);
    const png = encodeTestPng(source);
    const short = deflateZlib(filtered.subarray(0, 20));
    const long = deflateZlib(Uint8Array.from([...filtered, 0]));
    expect(streamReason(source, flipped(stream, stream.length - 1))).toBe('image-checksum-mismatch');
    for (const length of [4, 20, 40, png.length - 12, png.length - 1]) {
      expect(decodeReason(png.subarray(0, length))).toBe('image-truncated');
    }
    expect(streamReason(source, short)).toBe('image-truncated');
    expect(streamReason(source, long)).toBe('image-invalid');
    expect(streamReason(source, Uint8Array.from([...stream, 0]))).toBe('image-invalid');
  });

  it.each([
    ['an undefined filter type', { ...image(0, 8, { width: 2, height: 1 }), stream: deflateZlib(Uint8Array.of(5, 0, 0)) }],
    ['a palette index past PLTE', { ...image(3, 8, { width: 2, height: 1 }), samples: [0, 3], before: [pngChunk('PLTE', palette(3))] }],
    ['an indexed image without PLTE', { ...image(3, 4, { width: 2, height: 1 }), before: [] }],
    ['PLTE in a grey image', { ...image(0, 8, { width: 1, height: 1 }), before: [pngChunk('PLTE', palette(1))] }],
    ['a PLTE larger than the bit depth indexes', { ...image(3, 1, { width: 1, height: 1 }), before: [pngChunk('PLTE', palette(3))] }],
    ['tRNS in an image with alpha', { ...image(6, 8, { width: 1, height: 1 }), before: [pngChunk('tRNS', [0, 0, 0, 0, 0, 0])] }],
    ['a tRNS longer than PLTE', { ...image(3, 8, { width: 1, height: 1 }), samples: [0], before: [pngChunk('PLTE', palette(1)), pngChunk('tRNS', [0, 0])] }],
    ['gAMA after PLTE', { ...image(3, 8, { width: 1, height: 1 }), samples: [0], before: [pngChunk('PLTE', palette(1)), pngChunk('gAMA', [0, 0, 0, 1])] }],
    ['a repeated sRGB', { ...image(0, 8, { width: 1, height: 1 }), before: [pngChunk('sRGB', [0]), pngChunk('sRGB', [0])] }],
    ['an undefined sRGB intent', { ...image(0, 8, { width: 1, height: 1 }), before: [pngChunk('sRGB', [4])] }],
    ['an iCCP with no name', { ...image(0, 8, { width: 1, height: 1 }), before: [pngChunk('iCCP', [0, 0, ...deflateZlib(srgbV4Bytes)])] }],
    ['a second IHDR', { ...image(0, 8, { width: 1, height: 1 }), before: [pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])] }],
    ['bit depth 16 on an indexed image', { ...image(0, 8, { width: 1, height: 1 }), colorType: 3, bitDepth: 16 }],
    ['bit depth 4 on a truecolour image', { ...image(2, 8, { width: 1, height: 1 }), bitDepth: 4 }],
    ['IDAT chunks that are not consecutive', { ...image(0, 8, { width: 4, height: 4 }), idatChunks: 2, betweenIdat: [pngChunk('tEXt', asciiBytes('a\0b'))] }],
  ] as const)('refuses %s', (_, source) => {
    expect(decodeReason(encodeTestPng(source))).toBe('image-invalid');
  });

  it('refuses an unknown critical chunk by reason', () => {
    const critical = pngChunk('XxXx', [1]);
    const png = encodeTestPng({ ...image(0, 8, { width: 1, height: 1 }), before: [critical] });
    expect(decodeReason(png)).toBe('png-critical-chunk');
  });

  it('refuses images past maxDecodedBytes and invalid limits', () => {
    const png = encodeTestPng(image(6, 16, { width: 4, height: 4 }));
    // Four rows of four 16-bit RGBA pixels inflate to 4 × (1 + 32) bytes, which is more than the 128 sample bytes.
    expect(decodePng(png, { maxDecodedBytes: 132 }).width).toBe(4);
    expect(() => decodePng(png, { maxDecodedBytes: 131 })).toThrow(ResourceLimitError);
    for (const value of [0, -1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => decodePng(png, { maxDecodedBytes: value })).toThrow(InvalidArgumentError);
    }
    const profile = encodeTestPng({
      ...image(0, 8, { width: 1, height: 1 }),
      before: [pngChunk('iCCP', [...asciiBytes('p'), 0, 0, ...deflateZlib(srgbV4Bytes)])],
    });
    expect(() => decodePng(profile, { maxDecodedBytes: srgbV4Bytes.length - 1 })).toThrow(ResourceLimitError);
    expect(decodePng(profile, { maxDecodedBytes: srgbV4Bytes.length }).iccProfile?.profile).toStrictEqual(srgbV4Bytes);
  });

  it('counts unpacked sample bytes against maxDecodedBytes', () => {
    // Sixteen 1-bit samples filter to 3 bytes but unpack to 16.
    const png = encodeTestPng(image(0, 1, { width: 16, height: 1 }));
    expect(() => decodePng(png, { maxDecodedBytes: 15 })).toThrow(ResourceLimitError);
    expect(decodePng(png, { maxDecodedBytes: 16 }).samples).toHaveLength(16);
  });
});

describe('decoding PNG structure', () => {
  it.each([
    ['an IHDR of 14 bytes', [...headerData({}), 0]],
    // An empty image has no filtered bytes, so its image data is an empty zlib datastream that a reader accepting the size would decode.
    ['width 0', headerData({ width: 0 }), new Uint8Array()],
    ['height 0', headerData({ height: 0 }), new Uint8Array()],
    ['width 2^31', headerData({ width: 2 ** 31 })],
    ['height 2^31', headerData({ height: 2 ** 31 })],
    // PNG Third Edition, 6.1, Table 9 defines colour types 0, 2, 3, 4 and 6 only.
    ['colour type 1', headerData({ colorType: 1 })],
    ['colour type 5', headerData({ colorType: 5 })],
    ['colour type 7', headerData({ colorType: 7 })],
    ['compression method 1', headerData({ compression: 1 })],
    ['filter method 1', headerData({ filter: 1 })],
    ['interlace method 2', headerData({ interlace: 2 })],
  ])('refuses an IHDR with %s', (_, header, filtered?: Uint8Array) => {
    expect(decodeReason(withHeader(header, filtered))).toBe('image-invalid');
  });

  it('refuses an image of width 2^31 − 1 by its size, not its header', () => {
    expect(() => decodePng(withHeader(headerData({ width: 2 ** 31 - 1, bitDepth: 1 })))).toThrow(ResourceLimitError);
  });

  it.each([
    // The first chunk holds a valid IHDR body under another name, and no IHDR follows.
    ['a first chunk that is not IHDR', concat(SIGNATURE, pngChunk('tEXt', headerData({})), encodeTestPng(GRAY_PIXEL).subarray(33))],
    // PNG Third Edition, 5.3: a length above 2^31 − 1 is invalid however many bytes follow it.
    ['a chunk length of 2^31', concat(SIGNATURE, pngChunk('IHDR', headerData({})), [0x80, 0, 0, 0, ...asciiBytes('gAMA'), 0, 0, 0, 0])],
    ['a chunk type with a digit', encodeTestPng({ ...GRAY_PIXEL, before: [pngChunk('ID4T', [1])] })],
    ['an IEND with data', concat(encodeTestPng(GRAY_PIXEL).subarray(0, -12), pngChunk('IEND', [0]))],
    ['no IDAT', concat(SIGNATURE, pngChunk('IHDR', headerData({})), pngChunk('IEND'))],
    // PNG Third Edition, 11.2.2: PLTE holds 1 to 256 entries of three bytes, at most once and before IDAT.
    ['an empty PLTE', encodeTestPng({ ...RGB_PIXEL, before: [pngChunk('PLTE', [])] })],
    ['a PLTE of 4 bytes', encodeTestPng({ ...RGB_PIXEL, before: [pngChunk('PLTE', [1, 2, 3, 4])] })],
    ['a PLTE of 257 entries', encodeTestPng({ ...RGB_PIXEL, before: [pngChunk('PLTE', palette(257))] })],
    ['a repeated PLTE', encodeTestPng({ ...RGB_PIXEL, before: [pngChunk('PLTE', palette(1)), pngChunk('PLTE', palette(1))] })],
    ['a PLTE after IDAT', beforeIend(encodeTestPng(RGB_PIXEL), pngChunk('PLTE', palette(1)))],
    [
      'a 2-bit index past a 3-entry PLTE',
      encodeTestPng({ width: 4, height: 1, colorType: 3, bitDepth: 2, samples: [0, 1, 2, 3], before: [pngChunk('PLTE', palette(3))] }),
    ],
    // PNG Third Edition, 11.3.1.1: tRNS is two bytes for grey, six for truecolour, absent with alpha, at most once, and after PLTE for indexed-colour.
    ['a grey tRNS of 1 byte', encodeTestPng({ ...GRAY_PIXEL, before: [pngChunk('tRNS', [0])] })],
    ['a truecolour tRNS of 4 bytes', encodeTestPng({ ...RGB_PIXEL, before: [pngChunk('tRNS', [0, 0, 0, 0])] })],
    ['tRNS in a grey image with alpha', encodeTestPng({ ...image(4, 8, { width: 1, height: 1 }), before: [pngChunk('tRNS', [0, 0])] })],
    ['a repeated tRNS', encodeTestPng({ ...GRAY_PIXEL, before: [pngChunk('tRNS', [0, 0]), pngChunk('tRNS', [0, 0])] })],
    ['an indexed tRNS before PLTE', encodeTestPng({ ...image(3, 1, { width: 1, height: 1 }), before: [pngChunk('tRNS', [0]), pngChunk('PLTE', palette(2))] })],
    // PNG Third Edition, 11.3.2.1, 11.3.2.2 and 11.3.2.5: cHRM is 32 bytes, gAMA 4 and sRGB 1, and none follows IDAT.
    ['a gAMA of 3 bytes', encodeTestPng({ ...GRAY_PIXEL, before: [pngChunk('gAMA', [0, 0, 1])] })],
    [
      'a cHRM of 31 bytes',
      encodeTestPng({
        ...GRAY_PIXEL,
        before: [
          pngChunk(
            'cHRM',
            Array.from({ length: 31 }, () => 1),
          ),
        ],
      }),
    ],
    ['an sRGB of 2 bytes', encodeTestPng({ ...GRAY_PIXEL, before: [pngChunk('sRGB', [0, 0])] })],
    ['a gAMA after IDAT', beforeIend(encodeTestPng(GRAY_PIXEL), pngChunk('gAMA', uint32Bytes(45_455)))],
    // PNG Third Edition, 11.3.2.3: iCCP appears once, with a 1 to 79 byte name, a null separator, compression method 0 and a valid zlib datastream.
    ['a repeated iCCP', encodeTestPng({ ...GRAY_PIXEL, before: [profileChunk(asciiBytes('a')), profileChunk(asciiBytes('b'))] })],
    ['an iCCP name of 80 bytes', encodeTestPng({ ...GRAY_PIXEL, before: [profileChunk(asciiBytes('n'.repeat(80)))] })],
    ['iCCP compression method 1', encodeTestPng({ ...GRAY_PIXEL, before: [profileChunk(asciiBytes('p'), 1)] })],
    // 0x07 opens a final deflate block of the reserved type 3 (RFC 1951, 3.2.3).
    [
      'an iCCP with a corrupt zlib stream',
      encodeTestPng({ ...GRAY_PIXEL, before: [profileChunk(asciiBytes('p'), 0, Uint8Array.of(0x78, 0x9c, 0x07, 0, 0, 0, 0))] }),
    ],
  ])('refuses %s', (_, png) => {
    expect(decodeReason(png)).toBe('image-invalid');
  });

  it('refuses an iCCP profile whose Adler-32 does not match', () => {
    const stream = deflateZlib(srgbV4Bytes);
    expect(decodeReason(encodeTestPng({ ...GRAY_PIXEL, before: [profileChunk(asciiBytes('p'), 0, flipped(stream, stream.length - 1))] }))).toBe(
      'image-checksum-mismatch',
    );
  });

  it('accepts an iCCP name of 79 bytes', () => {
    const name = 'n'.repeat(79);
    expect(decodePng(encodeTestPng({ ...GRAY_PIXEL, before: [profileChunk(asciiBytes(name))] })).iccProfile?.name).toBe(name);
  });

  it.each([
    [0, 'perceptual'],
    [1, 'relative-colorimetric'],
    [2, 'saturation'],
    [3, 'absolute-colorimetric'],
  ] as const)('names sRGB rendering intent %i %s', (intent, name) => {
    expect(decodePng(encodeTestPng({ ...GRAY_PIXEL, before: [pngChunk('sRGB', [intent])] })).srgbIntent).toBe(name);
  });

  it('maps image data zlib failures to the reason that describes them', () => {
    const source = image(2, 8, { width: 4, height: 3 });
    const stream = deflateZlib(filteredImageData(source));
    // PNG Third Edition, 10.1 and RFC 1950, 2.2: a cut datastream and a cut check value are truncation; a bad header or a preset dictionary is invalid data.
    expect(streamReason(source, stream.subarray(0, Math.floor(stream.length / 2)))).toBe('image-truncated');
    expect(streamReason(source, stream.subarray(0, -2))).toBe('image-truncated');
    expect(streamReason(source, Uint8Array.from([0x78, 0x00, ...stream.subarray(2)]))).toBe('image-invalid');
    expect(streamReason(source, Uint8Array.from([0x78, 0x20, ...stream.subarray(2)]))).toBe('image-invalid');
  });

  it('accepts an empty IDAT between two IDAT chunks', () => {
    const source = image(0, 8, { width: 4, height: 4 });
    expect([...decodePng(encodeTestPng({ ...source, idatChunks: 2, betweenIdat: [pngChunk('IDAT')] })).samples]).toStrictEqual(source.samples);
  });

  it('refuses an undefined filter type in the last Adam7 pass', () => {
    const source = image(0, 8, { width: 8, height: 8, interlaced: true });
    const filtered = filteredImageData(source);
    // Pass 7 of an 8 × 8 image is its last four rows of eight bytes, each after a filter type byte.
    filtered[filtered.length - 36] = 5;
    expect(streamReason(source, deflateZlib(filtered))).toBe('image-invalid');
  });

  it('returns a truecolour image’s suggested palette without applying it', () => {
    const source: TestPng = { width: 2, height: 1, colorType: 2, bitDepth: 8, samples: [0, 0, 0, 200, 100, 50], before: [pngChunk('PLTE', [10, 20, 30])] };
    const decoded = decodePng(encodeTestPng(source));
    expect([decoded.palette, [...decoded.samples], [...pngToRgba8(decoded)]]).toStrictEqual([
      Uint8Array.of(10, 20, 30),
      [0, 0, 0, 200, 100, 50],
      [0, 0, 0, 255, 200, 100, 50, 255],
    ]);
  });
});

describe('converting decoded PNG to 8-bit RGBA', () => {
  it('scales low bit depths exactly and reduces 16-bit samples by their high byte', () => {
    expect(rgba({ width: 2, height: 1, colorType: 0, bitDepth: 1, samples: [0, 1] })).toStrictEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(rgba({ width: 4, height: 1, colorType: 0, bitDepth: 2, samples: [0, 1, 2, 3] })).toStrictEqual([
      0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255,
    ]);
    expect(rgba({ width: 2, height: 1, colorType: 0, bitDepth: 4, samples: [1, 15] })).toStrictEqual([17, 17, 17, 255, 255, 255, 255, 255]);
    expect(rgba({ width: 1, height: 1, colorType: 6, bitDepth: 16, samples: [0x12_ff, 0xff_ff, 0x00_80, 0x80_00] })).toStrictEqual([0x12, 0xff, 0x00, 0x80]);
    expect(rgba({ width: 1, height: 1, colorType: 4, bitDepth: 16, samples: [0xab_cd, 0x01_ff] })).toStrictEqual([0xab, 0xab, 0xab, 0x01]);
  });

  it('applies tRNS colour keys at the stored sample depth', () => {
    const grayKey = pngChunk('tRNS', [0x12, 0x34]);
    expect(rgba({ width: 2, height: 1, colorType: 0, bitDepth: 16, samples: [0x12_34, 0x12_35], before: [grayKey] })).toStrictEqual([
      0x12, 0x12, 0x12, 0, 0x12, 0x12, 0x12, 255,
    ]);
    // Each opaque pixel differs from the key in one channel only, so the key must match red, green and blue together.
    const rgbKey = pngChunk('tRNS', [0, 1, 0, 2, 0, 3]);
    expect(rgba({ width: 4, height: 1, colorType: 2, bitDepth: 8, samples: [1, 2, 3, 1, 2, 4, 9, 2, 3, 1, 9, 3], before: [rgbKey] })).toStrictEqual([
      1, 2, 3, 0, 1, 2, 4, 255, 9, 2, 3, 255, 1, 9, 3, 255,
    ]);
  });

  it('applies palette alpha with opaque entries past the end of tRNS', () => {
    const before = [pngChunk('PLTE', [10, 20, 30, 40, 50, 60, 70, 80, 90]), pngChunk('tRNS', [0, 128])];
    const indexed: TestPng = { width: 3, height: 1, colorType: 3, bitDepth: 2, samples: [0, 1, 2], before };
    expect(rgba(indexed)).toStrictEqual([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255]);
    const decoded = decodePng(encodeTestPng(indexed));
    expect([decoded.palette, decoded.paletteAlpha]).toStrictEqual([Uint8Array.of(10, 20, 30, 40, 50, 60, 70, 80, 90), Uint8Array.of(0, 128)]);
  });

  it('accepts a palette alpha table as long as PLTE', () => {
    const before = [pngChunk('PLTE', [10, 20, 30, 40, 50, 60, 70, 80, 90]), pngChunk('tRNS', [0, 128, 200])];
    expect(rgba({ width: 3, height: 1, colorType: 3, bitDepth: 2, samples: [0, 1, 2], before })).toStrictEqual([
      10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 200,
    ]);
  });

  it('passes 8-bit grey through and matches low-depth and 16-bit colour keys exactly', () => {
    expect(rgba({ width: 4, height: 1, colorType: 0, bitDepth: 8, samples: [0, 17, 200, 255] })).toStrictEqual([
      0, 0, 0, 255, 17, 17, 17, 255, 200, 200, 200, 255, 255, 255, 255, 255,
    ]);
    // The second pixel differs from the 16-bit key only in the low byte of red, which the 8-bit output drops.
    const rgbKey = pngChunk('tRNS', [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
    expect(
      rgba({ width: 2, height: 1, colorType: 2, bitDepth: 16, samples: [0x12_34, 0x56_78, 0x9a_bc, 0x12_35, 0x56_78, 0x9a_bc], before: [rgbKey] }),
    ).toStrictEqual([0x12, 0x56, 0x9a, 0, 0x12, 0x56, 0x9a, 255]);
    expect(rgba({ width: 3, height: 1, colorType: 0, bitDepth: 2, samples: [1, 2, 3], before: [pngChunk('tRNS', [0, 2])] })).toStrictEqual([
      85, 85, 85, 255, 170, 170, 170, 0, 255, 255, 255, 255,
    ]);
  });
});

const KINDS = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
] as const;

// Random images of every colour type and bit depth, with a random filter type for each written row; Adam7 writes at most 2 × height + 7 rows.
const pngImages = (side: number): fc.Arbitrary<TestPng> =>
  fc
    .record({ kind: fc.constantFrom(...KINDS), width: fc.integer({ min: 1, max: side }), height: fc.integer({ min: 1, max: side }), interlaced: fc.boolean() })
    .chain(({ kind: [colorType, bitDepth], width, height, interlaced }) => {
      const count = width * height * (CHANNELS.get(colorType) ?? 1);
      const levels = 2 ** bitDepth;
      const rows = 2 * height + 7;
      return fc
        .record({
          samples: fc.array(fc.integer({ min: 0, max: levels - 1 }), { minLength: count, maxLength: count }),
          filters: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: rows, maxLength: rows }),
        })
        .map(({ samples, filters }): TestPng => ({
          width,
          height,
          colorType,
          bitDepth,
          interlaced,
          samples,
          filters,
          before: colorType === 3 ? [pngChunk('PLTE', palette(levels))] : [],
        }));
    });

const smallImages = pngImages(8);

interface Field {
  readonly start: number;
  readonly end: number;
}

// The byte range of each chunk's type, data and CRC, which PNG Third Edition, 5.3 places after a four-byte length.
const chunkFields = (png: Uint8Array): Array<Field> => {
  const fields: Array<Field> = [];
  for (let offset = 8; offset < png.length;) {
    const length = (png[offset] ?? 0) * 16_777_216 + (png[offset + 1] ?? 0) * 65_536 + (png[offset + 2] ?? 0) * 256 + (png[offset + 3] ?? 0);
    fields.push({ start: offset + 4, end: offset + 12 + length });
    offset += 12 + length;
  }
  return fields;
};

const isLetter = (value: number): boolean => (value >= 65 && value <= 90) || (value >= 97 && value <= 122);

describe('properties', () => {
  it('decodes every colour type, bit depth, size, interlace and filter choice to the encoded samples', () => {
    fc.assert(
      fc.property(pngImages(40), source => {
        expect([...decodePng(encodeTestPng(source)).samples]).toStrictEqual(source.samples);
      }),
    );
  });

  it('refuses a change to any byte of a chunk’s type, data or CRC by CRC, or by type when it stops being a letter', () => {
    fc.assert(
      fc.property(smallImages, fc.nat(), fc.nat(), fc.integer({ min: 1, max: 255 }), (source, chunk, position, delta) => {
        const png = encodeTestPng(source);
        const fields = chunkFields(png);
        const field = fields[chunk % fields.length] ?? { start: 8, end: 9 };
        const offset = field.start + (position % (field.end - field.start));
        const changed = Uint8Array.from(png);
        changed[offset] = ((png[offset] ?? 0) + delta) % 256;
        // PNG Third Edition, 5.3 and 5.5: the type is four ASCII letters, and the CRC covers the type and the data.
        const expected = offset < field.start + 4 && !isLetter(changed[offset] ?? 0) ? 'image-invalid' : 'image-crc-mismatch';
        expect(decodeReason(changed)).toBe(expected);
      }),
    );
  });

  it('reports every prefix of a valid PNG as truncated', () => {
    fc.assert(
      fc.property(smallImages, fc.nat(), (source, cut) => {
        const png = encodeTestPng(source);
        expect(decodeReason(png.subarray(0, cut % png.length))).toBe('image-truncated');
      }),
    );
  });

  it('scales grey samples below 16 bits to v × 255 / (2^d − 1) with opaque alpha', () => {
    const greyRows = fc
      .constantFrom(1, 2, 4, 8)
      .chain(bitDepth => fc.array(fc.integer({ min: 0, max: 2 ** bitDepth - 1 }), { minLength: 1, maxLength: 40 }).map(samples => ({ bitDepth, samples })));
    fc.assert(
      fc.property(greyRows, ({ bitDepth, samples }) => {
        // PNG Third Edition, 13.12: at these depths the scaled value is an exact integer.
        const expected = samples.flatMap(value => {
          const scaled = (value * 255) / (2 ** bitDepth - 1);
          return [scaled, scaled, scaled, 255];
        });
        expect(rgba({ width: samples.length, height: 1, colorType: 0, bitDepth, samples })).toStrictEqual(expected);
      }),
    );
  });

  it('continues a CRC-32 across a split', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ maxLength: 64 }), (first, second) => {
        expect(crc32(Uint8Array.from([...first, ...second]))).toBe(crc32(second, crc32(first)));
      }),
    );
  });
});

import type { ParseReason, UnsupportedFeatureReason } from '../index.ts';
import type { TestPng } from './pngTestEncoder.ts';

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

const pattern = (count: number, limit: number): number[] => Array.from({ length: count }, (_, index) => (index * 7919 + 13) % limit);

const palette = (entries: number): number[] => Array.from({ length: entries * 3 }, (_, index) => (index * 37) % 256);

const image = (colorType: number, bitDepth: number, size: Size): TestPng => {
  const count = size.width * size.height * (CHANNELS.get(colorType) ?? 1);
  const levels = Math.min(256, 2 ** bitDepth);
  if (colorType === 3) return { ...size, colorType, bitDepth, samples: pattern(count, levels), before: [pngChunk('PLTE', palette(levels))] };
  return { ...size, colorType, bitDepth, samples: pattern(count, 2 ** bitDepth) };
};

const bytes = (text: string): Uint8Array => Uint8Array.from(asciiBytes(text));

const reason = (run: () => void): ParseReason | UnsupportedFeatureReason | undefined => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ParseError || error instanceof UnsupportedFeatureError) return error.reason;
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

const rgba = (source: TestPng): number[] => [...pngToRgba8(decodePng(encodeTestPng(source)))];

const SIZES: readonly Size[] = [
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
});

describe('decoding PNG datastreams', () => {
  it.each(CASES)('decodes colour type $colorType at bit depth $bitDepth, $width × $height, interlaced $interlaced', source => {
    const decoded = decodePng(encodeTestPng({ ...source, idatChunks: 3 }));
    expect([decoded.width, decoded.height, decoded.bitDepth, decoded.interlaced, decoded.samples instanceof Uint16Array]).toStrictEqual([
      source.width,
      source.height,
      source.bitDepth,
      source.interlaced,
      source.bitDepth === 16,
    ]);
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
    // Byte 29 is the last byte of the IHDR CRC; byte 41 is the first byte of the gAMA data.
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
    for (const length of [4, 20, 40, png.length - 12, png.length - 1]) expect(decodeReason(png.subarray(0, length))).toBe('image-truncated');
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
    for (const value of [0, -1, 0.5, Number.POSITIVE_INFINITY]) expect(() => decodePng(png, { maxDecodedBytes: value })).toThrow(InvalidArgumentError);
    const profile = encodeTestPng({
      ...image(0, 8, { width: 1, height: 1 }),
      before: [pngChunk('iCCP', [...asciiBytes('p'), 0, 0, ...deflateZlib(srgbV4Bytes)])],
    });
    expect(() => decodePng(profile, { maxDecodedBytes: srgbV4Bytes.length - 1 })).toThrow(ResourceLimitError);
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
    const rgbKey = pngChunk('tRNS', [0, 1, 0, 2, 0, 3]);
    expect(rgba({ width: 2, height: 1, colorType: 2, bitDepth: 8, samples: [1, 2, 3, 1, 2, 4], before: [rgbKey] })).toStrictEqual([1, 2, 3, 0, 1, 2, 4, 255]);
  });

  it('applies palette alpha with opaque entries past the end of tRNS', () => {
    const before = [pngChunk('PLTE', [10, 20, 30, 40, 50, 60, 70, 80, 90]), pngChunk('tRNS', [0, 128])];
    const indexed: TestPng = { width: 3, height: 1, colorType: 3, bitDepth: 2, samples: [0, 1, 2], before };
    expect(rgba(indexed)).toStrictEqual([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255]);
    const decoded = decodePng(encodeTestPng(indexed));
    expect([decoded.palette, decoded.paletteAlpha]).toStrictEqual([Uint8Array.of(10, 20, 30, 40, 50, 60, 70, 80, 90), Uint8Array.of(0, 128)]);
  });
});

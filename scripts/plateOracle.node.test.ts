import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePam, parseTiff, readPlate, sampleIndex } from './plateOracle.ts';

interface TiffInput {
  readonly bigEndian?: boolean;
  readonly width: number;
  readonly height: number;
  readonly samplesPerPixel?: number;
  readonly bits?: number;
  readonly compression?: number;
  readonly strips: ReadonlyArray<Uint8Array>;
  /** Added to the last strip's byte count, to write a count the data does not have. */
  readonly countSkew?: number;
}

// Writes a TIFF 6.0 file: an 8-byte header, the strips, the values that do not fit in their entries, then one IFD whose entries are sorted by tag.
const tiff = ({ bigEndian = false, width, height, samplesPerPixel = 1, bits = 8, compression = 1, strips, countSkew = 0 }: TiffInput): Uint8Array => {
  const parts: Array<number> = [];
  const u16 = (value: number): Array<number> => (bigEndian ? [value >> 8, value & 0xff] : [value & 0xff, value >> 8]);
  const u32 = (value: number): Array<number> => {
    const bytes = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    return bigEndian ? bytes : bytes.toReversed();
  };
  parts.push(...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]), ...u16(42), 0, 0, 0, 0);
  const stripOffsets: Array<number> = [];
  for (const strip of strips) {
    stripOffsets.push(parts.length);
    parts.push(...strip);
  }
  const counts = strips.map((strip, index) => strip.length + (index === strips.length - 1 ? countSkew : 0));
  // Each entry is [tag, type, values]; values of more than four bytes go before the IFD.
  const entries: Array<readonly [number, number, ReadonlyArray<number>]> = [
    [256, 3, [width]],
    [257, 3, [height]],
    [258, 3, Array.from({ length: samplesPerPixel }, () => bits)],
    [259, 3, [compression]],
    [273, 4, stripOffsets],
    [277, 3, [samplesPerPixel]],
    [279, 4, counts],
    // XResolution, a RATIONAL, which the reader skips.
    [282, 5, [72, 1]],
  ];
  const encoded = entries.map(([tag, type, values]) => {
    const bytes = values.flatMap(value => (type === 3 ? u16(value) : u32(value)));
    if (bytes.length <= 4) {
      return [tag, type, values.length / (type === 5 ? 2 : 1), [...bytes, 0, 0, 0, 0].slice(0, 4)] as const;
    }
    const offset = parts.length;
    parts.push(...bytes);
    return [tag, type, values.length / (type === 5 ? 2 : 1), u32(offset)] as const;
  });
  const ifd = parts.length;
  parts.push(...u16(entries.length));
  for (const [tag, type, count, value] of encoded) {
    parts.push(...u16(tag), ...u16(type), ...u32(count), ...value);
  }
  parts.push(0, 0, 0, 0);
  parts.splice(4, 4, ...u32(ifd));
  return Uint8Array.from(parts);
};

const PIXELS = Uint8Array.from([0, 10, 20, 30, 40, 50]);

describe('TIFF plates', () => {
  it('reads little- and big-endian files with several strips alike', () => {
    const strips = [PIXELS.subarray(0, 3), PIXELS.subarray(3)];
    const expected = { width: 3, height: 2, data: PIXELS, samplesPerPixel: 1 };
    expect(parseTiff(tiff({ width: 3, height: 2, strips }))).toStrictEqual(expected);
    expect(parseTiff(tiff({ bigEndian: true, width: 3, height: 2, strips }))).toStrictEqual(expected);
  });

  // Two SHORT bits-per-sample values fit in the entry; three or four are stored at an offset.
  it.each([2, 3, 4])('reads the bits per sample of %i samples per pixel', samplesPerPixel => {
    const data = Uint8Array.from({ length: 2 * samplesPerPixel }, (_, index) => index);
    expect(parseTiff(tiff({ bigEndian: true, width: 2, height: 1, samplesPerPixel, strips: [data] }))).toStrictEqual({
      width: 2,
      height: 1,
      data,
      samplesPerPixel,
    });
  });

  it.each([
    ['16-bit samples', { bits: 16 }, /bits per sample/u],
    ['a compressed plate', { compression: 5 }, /uncompressed/u],
    ['strips that hold fewer bytes than the pixels', { strips: [PIXELS.subarray(0, 5)] }, /not the 6/u],
    ['a byte count past the end of the file', { countSkew: 4096, strips: [PIXELS.subarray(0, 2)], width: 1, height: 4098 }, /past the end/u],
  ])('refuses %s', (_, input, message) => {
    expect(() => parseTiff(tiff({ width: 3, height: 2, strips: [PIXELS], ...input }))).toThrow(message);
  });

  it('refuses a file that is not a TIFF', () => {
    expect(() => parseTiff(Uint8Array.from([0x49, 0x49, 43, 0, 8, 0, 0, 0]))).toThrow(/header/u);
    expect(() => parseTiff(new TextEncoder().encode('P7\nWIDTH 1'))).toThrow(/header/u);
  });
});

describe('pixel coordinates', () => {
  const image = { width: 3, height: 2, samplesPerPixel: 4 };

  it('indexes the first sample of each corner pixel', () => {
    expect([sampleIndex(image, 0, 0), sampleIndex(image, 2, 0), sampleIndex(image, 0, 1), sampleIndex(image, 2, 1)]).toStrictEqual([0, 8, 12, 20]);
  });

  it.each([
    [3, 0],
    [0, 2],
    [-1, 0],
    [0, -1],
    [0.5, 0],
    [Number.NaN, 0],
  ])('refuses (%d, %d), which is not a pixel', (x, y) => {
    expect(() => sampleIndex(image, x, y)).toThrow(RangeError);
  });
});

const withPlate = async <T>(bytes: Uint8Array, read: (file: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-plate-'));
  try {
    const file = path.join(directory, 'o(Spot).tif');
    await writeFile(file, bytes);
    return await read(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('reading a plate', () => {
  const name = new TextEncoder().encode('Spot');

  it('reads ink as 255 less the stored value, and refuses a coordinate off the plate', async () => {
    await withPlate(tiff({ width: 3, height: 2, strips: [PIXELS] }), async file => {
      const plate = await readPlate([{ name, file }], name);
      expect([plate.width, plate.height, plate.inkAt(0, 0), plate.inkAt(2, 0), plate.inkAt(0, 1), plate.inkAt(2, 1)]).toStrictEqual([3, 2, 255, 235, 225, 205]);
      expect(() => plate.inkAt(3, 0)).toThrow(RangeError);
      expect(() => plate.inkAt(0, 2)).toThrow(RangeError);
    });
  });

  it('refuses a plate it was not given and a plate with more than one sample per pixel', async () => {
    await withPlate(tiff({ width: 3, height: 1, samplesPerPixel: 2, strips: [PIXELS] }), async file => {
      await expect(readPlate([{ name, file }], new TextEncoder().encode('Spo'))).rejects.toThrow('missing separation plate');
      await expect(readPlate([{ name, file }], name)).rejects.toThrow(/one sample per pixel/u);
    });
  });
});

const pam = (header: string, data: Uint8Array): Uint8Array => Uint8Array.from([...new TextEncoder().encode(header), ...data]);

describe('PAM images', () => {
  const header = 'P7\nWIDTH 2\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nTUPLTYPE RGB\nENDHDR\n';

  it('reads the size, depth and samples MuPDF writes', () => {
    expect(parsePam(pam(header, PIXELS))).toStrictEqual({ width: 2, height: 1, data: PIXELS, samplesPerPixel: 3 });
  });

  it.each([
    ['16-bit samples', header.replace('MAXVAL 255', 'MAXVAL 65535'), PIXELS],
    ['data shorter than its header', header, PIXELS.subarray(0, 5)],
    ['data longer than its header', header, Uint8Array.from([...PIXELS, 0])],
    ['no end of header', header.replace('ENDHDR\n', ''), PIXELS],
    ['no width', header.replace('WIDTH 2\n', ''), PIXELS],
  ])('refuses an image with %s', (_, text, data) => {
    expect(() => parsePam(pam(text, data))).toThrow(/PAM/u);
  });
});

import type { ParseReason } from '../error/parseError.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { undoPredictor } from '../filter/predictor.ts';
import { inflateZlib } from '../flate/inflate.ts';

import { crc32 } from './crc32.ts';

/** The five PNG colour types of PNG Third Edition, 6.1, Table 9: 0 grey, 2 truecolour, 3 indexed-colour, 4 grey with alpha, 6 truecolour with alpha. */
export type PngColorType = 'gray' | 'rgb' | 'indexed' | 'gray-alpha' | 'rgba';

/** Bits per sample, or per palette index for indexed-colour images (PNG Third Edition, 11.2.1). */
export type PngBitDepth = 1 | 2 | 4 | 8 | 16;

/** The rendering intent an `sRGB` chunk names (PNG Third Edition, 11.3.2.5). */
export type PngRenderingIntent = 'perceptual' | 'relative-colorimetric' | 'saturation' | 'absolute-colorimetric';

/** A `cHRM` chunk's eight values as stored: each chromaticity coordinate times 100,000 (PNG Third Edition, 11.3.2.1). */
export interface PngChromaticities {
  readonly whiteX: number;
  readonly whiteY: number;
  readonly redX: number;
  readonly redY: number;
  readonly greenX: number;
  readonly greenY: number;
  readonly blueX: number;
  readonly blueY: number;
}

/** An `iCCP` chunk's profile name and inflated profile (PNG Third Edition, 11.3.2.3); the profile is returned as bytes and not parsed. */
export interface PngIccProfile {
  readonly name: string;
  readonly profile: Uint8Array;
}

/** A decoded PNG: its header, its samples, and the colour chunks it carries, passed through as data. */
export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly colorType: PngColorType;
  readonly bitDepth: PngBitDepth;
  /** Samples per pixel: 1 for grey and indexed-colour, 2 for grey with alpha, 3 for truecolour, 4 for truecolour with alpha. */
  readonly channels: 1 | 2 | 3 | 4;
  /** Whether the file stored its pixels in Adam7 order; `samples` is in image order either way. */
  readonly interlaced: boolean;
  /**
   * One element per sample, rows top to bottom, pixels left to right, the channels of a pixel adjacent in the order the colour type names them, alpha last.
   * Bit depths 1 to 8 give a Uint8Array whose elements run from 0 to 2^depth − 1, unscaled; bit depth 16 gives a Uint16Array. Indexed-colour images hold palette indices.
   */
  readonly samples: Uint8Array | Uint16Array;
  /** The `PLTE` entries as red, green, blue byte triples, or undefined when the file has none; a truecolour image's palette is only a suggestion. */
  readonly palette: Uint8Array | undefined;
  /** An indexed-colour image's `tRNS` alpha table; it may be shorter than the palette, and entries past its end are opaque. */
  readonly paletteAlpha: Uint8Array | undefined;
  /** A grey or truecolour image's `tRNS` sample value (one value for grey, three for truecolour); pixels equal to it are fully transparent. */
  readonly transparentColor: readonly number[] | undefined;
  readonly iccProfile: PngIccProfile | undefined;
  readonly srgbIntent: PngRenderingIntent | undefined;
  /** A `gAMA` chunk's value as stored: the image gamma times 100,000 (PNG Third Edition, 11.3.2.2). */
  readonly gamma: number | undefined;
  readonly chromaticities: PngChromaticities | undefined;
}

/** Limits for `decodePng`. */
export interface DecodePngOptions {
  /** Largest size accepted for the inflated image data, the returned samples, and an inflated ICC profile, each in bytes; 16 MiB by default. Larger images throw ResourceLimitError before inflating. */
  readonly maxDecodedBytes?: number;
}

interface ColorTypeInfo {
  readonly colorType: PngColorType;
  readonly channels: 1 | 2 | 3 | 4;
  readonly depths: readonly PngBitDepth[];
}

// PNG Third Edition, 6.1, Table 9: the allowed bit depths of each colour type.
const COLOR_TYPES = new Map<number, ColorTypeInfo>([
  [0, { colorType: 'gray', channels: 1, depths: [1, 2, 4, 8, 16] }],
  [2, { colorType: 'rgb', channels: 3, depths: [8, 16] }],
  [3, { colorType: 'indexed', channels: 1, depths: [1, 2, 4, 8] }],
  [4, { colorType: 'gray-alpha', channels: 2, depths: [8, 16] }],
  [6, { colorType: 'rgba', channels: 4, depths: [8, 16] }],
]);

const INTENTS: readonly PngRenderingIntent[] = ['perceptual', 'relative-colorimetric', 'saturation', 'absolute-colorimetric'];

// PNG Third Edition, 8.1: Adam7's seven passes as starting column, starting row, column step and row step.
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
const SEQUENTIAL = [[0, 0, 1, 1]] as const;

// PNG Third Edition, 5.2: the eight-byte PNG signature.
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_CHUNK_LENGTH = 2_147_483_647;
const DEFAULT_MAX_DECODED_BYTES = 16 * 1024 * 1024;

interface Header {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: PngBitDepth;
  readonly info: ColorTypeInfo;
  readonly interlaced: boolean;
}

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
  readonly offset: number;
}

interface Pass {
  readonly x: number;
  readonly y: number;
  readonly stepX: number;
  readonly stepY: number;
  readonly width: number;
  readonly height: number;
  readonly rowBytes: number;
}

const fail = (offset: number, detail: string, reason: ParseReason = 'image-invalid'): never => {
  throw new ParseError(`invalid PNG: ${detail}`, offset, reason);
};

const uint32 = (data: Uint8Array, offset: number): number =>
  (data[offset] ?? 0) * 16_777_216 + (data[offset + 1] ?? 0) * 65_536 + (data[offset + 2] ?? 0) * 256 + (data[offset + 3] ?? 0);

const isLetter = (byte: number): boolean => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);

// PNG Third Edition, 5.3: each chunk is a four-byte length of at most 2^31 − 1, a four-letter type, the data, and a CRC over type and data.
const readChunk = (data: Uint8Array, offset: number): Chunk => {
  if (offset + 8 > data.length) return fail(offset, 'chunk header is truncated', 'image-truncated');
  const length = uint32(data, offset);
  if (length > MAX_CHUNK_LENGTH) return fail(offset, 'chunk length exceeds 2^31 − 1');
  const typeBytes = data.subarray(offset + 4, offset + 8);
  if (!typeBytes.every(byte => isLetter(byte))) return fail(offset + 4, 'chunk type is not four letters');
  const end = offset + 8 + length;
  if (end + 4 > data.length) return fail(offset, 'chunk is truncated', 'image-truncated');
  // PNG Third Edition, 5.5: the CRC covers the chunk type and data fields, not the length.
  if (crc32(data.subarray(offset + 4, end)) !== uint32(data, end)) return fail(end, 'chunk CRC does not match', 'image-crc-mismatch');
  return { type: String.fromCodePoint(...typeBytes), data: data.subarray(offset + 8, end), offset };
};

// PNG Third Edition, 11.2.1: width and height are 1 to 2^31 − 1; compression, filter and interlace methods are 0, 0 and 0 or 1.
const readHeader = (chunk: Chunk): Header => {
  const { data, offset } = chunk;
  if (data.length !== 13) return fail(offset, 'IHDR length is not 13');
  const width = uint32(data, 0);
  const height = uint32(data, 4);
  if (width === 0 || height === 0 || width > MAX_CHUNK_LENGTH || height > MAX_CHUNK_LENGTH) return fail(offset, 'image dimensions are outside 1 to 2^31 − 1');
  const info = COLOR_TYPES.get(data[9] ?? 0) ?? fail(offset, 'colour type is undefined');
  const bitDepth = info.depths.find(depth => depth === data[8]) ?? fail(offset, 'bit depth is not allowed for the colour type');
  if (data[10] !== 0) return fail(offset, 'compression method is not 0');
  if (data[11] !== 0) return fail(offset, 'filter method is not 0');
  if (data[12] !== 0 && data[12] !== 1) return fail(offset, 'interlace method is not 0 or 1');
  return { width, height, bitDepth, info, interlaced: data[12] === 1 };
};

// PNG Third Edition, 10.1: image data and iCCP profiles are zlib datastreams with deflate compression, and their Adler-32 check values are verified here.
const inflateChecked = (input: { readonly stream: Uint8Array; readonly limit: number; readonly offset: number; readonly what: string }): Uint8Array => {
  const { stream, limit, offset, what } = input;
  const inflated = ((): ReturnType<typeof inflateZlib> => {
    try {
      return inflateZlib(stream, { maxOutputBytes: limit });
    } catch (error: unknown) {
      if (error instanceof ParseError || error instanceof UnsupportedFeatureError) {
        return fail(offset, `${what} is invalid: ${error.message}`, error.message.includes('truncated') ? 'image-truncated' : 'image-invalid');
      }
      throw error;
    }
  })();
  for (const warning of inflated.warnings) {
    if (warning.code === 'checksum-mismatch') fail(offset, `${what} Adler-32 check value does not match`, 'image-checksum-mismatch');
    if (warning.code === 'truncated-trailer') fail(offset, `${what} check value is truncated`, 'image-truncated');
    fail(offset, `data follows the ${what} zlib datastream`);
  }
  return inflated.data;
};

const inflateImageData = (stream: Uint8Array, expected: number, offset: number): Uint8Array => {
  try {
    return inflateChecked({ stream, limit: expected, offset, what: 'image data' });
  } catch (error: unknown) {
    // The caller has checked `expected` against maxDecodedBytes, so reaching it here means the datastream holds more data than the header declares.
    if (error instanceof ResourceLimitError) return fail(offset, 'image data is longer than the header declares');
    throw error;
  }
};

const passes = (header: Header): Pass[] => {
  const layout = header.interlaced ? ADAM7 : SEQUENTIAL;
  const result: Pass[] = [];
  for (const [x, y, stepX, stepY] of layout) {
    const width = Math.ceil(Math.max(0, header.width - x) / stepX);
    const height = Math.ceil(Math.max(0, header.height - y) / stepY);
    // PNG Third Edition, 9.1: "No filter type bytes are present in an empty pass."
    if (width > 0 && height > 0) result.push({ x, y, stepX, stepY, width, height, rowBytes: Math.ceil((width * header.info.channels * header.bitDepth) / 8) });
  }
  return result;
};

// Exact powers of two for shifting and masking packed samples with integer division, since the repository's lint rejects bitwise operators here.
const POWERS_OF_TWO: readonly number[] = [1, 2, 4, 8, 16, 32, 64, 128, 256];

const readSample = (row: Uint8Array, index: number, depth: PngBitDepth): number => {
  if (depth === 8) return row[index] ?? 0;
  if (depth === 16) return (row[index * 2] ?? 0) * 256 + (row[index * 2 + 1] ?? 0);
  // PNG Third Edition, 7.2: samples narrower than a byte are packed with the leftmost sample in the high-order bits.
  const bit = index * depth;
  const shift = POWERS_OF_TWO[8 - depth - (bit % 8)] ?? 1;
  return Math.floor((row[Math.floor(bit / 8)] ?? 0) / shift) % (POWERS_OF_TWO[depth] ?? 1);
};

const unfilter = (input: {
  readonly filtered: Uint8Array;
  readonly header: Header;
  readonly samples: Uint8Array | Uint16Array;
  readonly offset: number;
}): void => {
  const { filtered, header, samples, offset } = input;
  const { channels } = header.info;
  let position = 0;
  for (const pass of passes(header)) {
    const length = pass.height * (pass.rowBytes + 1);
    const slice = filtered.subarray(position, position + length);
    for (let row = 0; row < pass.height; row++) {
      // PNG Third Edition, 9.2: filter method 0 defines filter types 0 to 4.
      if ((slice[row * (pass.rowBytes + 1)] ?? 0) > 4) fail(offset, 'filter type is undefined');
    }
    // PNG Third Edition, 9.2 to 9.4 define the same None, Sub, Up, Average and Paeth filters as the PDF PNG predictors.
    const rows = undoPredictor(slice, { predictor: 15, colors: channels, bitsPerComponent: header.bitDepth, columns: pass.width });
    for (let row = 0; row < pass.height; row++) {
      const bytes = rows.subarray(row * pass.rowBytes, (row + 1) * pass.rowBytes);
      const target = (pass.y + row * pass.stepY) * header.width;
      for (let column = 0; column < pass.width; column++) {
        const pixel = (target + pass.x + column * pass.stepX) * channels;
        for (let channel = 0; channel < channels; channel++) samples[pixel + channel] = readSample(bytes, column * channels + channel, header.bitDepth);
      }
    }
    position += length;
  }
};

const readPalette = (chunk: Chunk, header: Header): Uint8Array => {
  // PNG Third Edition, 11.2.2: 1 to 256 entries of three bytes, no more than the bit depth can index, and none for grey colour types.
  const entries = chunk.data.length / 3;
  if (!Number.isInteger(entries) || entries < 1 || entries > 256) return fail(chunk.offset, 'PLTE length is not 3 to 768 bytes in threes');
  if (header.info.colorType === 'gray' || header.info.colorType === 'gray-alpha') return fail(chunk.offset, 'PLTE appears in a grey image');
  const indexable = POWERS_OF_TWO[header.bitDepth] ?? 256;
  if (header.info.colorType === 'indexed' && entries > indexable) return fail(chunk.offset, 'PLTE has more entries than the bit depth can index');
  return Uint8Array.from(chunk.data);
};

interface Transparency {
  readonly paletteAlpha: Uint8Array | undefined;
  readonly transparentColor: readonly number[] | undefined;
}

const readTransparency = (chunk: Chunk, header: Header, palette: Uint8Array | undefined): Transparency => {
  // PNG Third Edition, 11.3.1.1: an alpha table for indexed-colour, one grey or RGB sample value otherwise, and no tRNS where the image has an alpha channel.
  const { data, offset } = chunk;
  const { colorType } = header.info;
  if (colorType === 'indexed') {
    if (palette === undefined || data.length > palette.length / 3) return fail(offset, 'tRNS has more entries than PLTE');
    return { paletteAlpha: Uint8Array.from(data), transparentColor: undefined };
  }
  if (colorType === 'gray') {
    if (data.length !== 2) return fail(offset, 'grey tRNS length is not 2');
    return { paletteAlpha: undefined, transparentColor: [(data[0] ?? 0) * 256 + (data[1] ?? 0)] };
  }
  if (colorType === 'rgb') {
    if (data.length !== 6) return fail(offset, 'truecolour tRNS length is not 6');
    return { paletteAlpha: undefined, transparentColor: [0, 2, 4].map(index => (data[index] ?? 0) * 256 + (data[index + 1] ?? 0)) };
  }
  return fail(offset, 'tRNS appears in an image with an alpha channel');
};

const readIcc = (chunk: Chunk, maxBytes: number): PngIccProfile => {
  // PNG Third Edition, 11.3.2.3: a 1-79 byte Latin-1 profile name, a null separator, compression method 0, and a zlib datastream.
  const { data, offset } = chunk;
  const separator = data.indexOf(0);
  if (separator < 1 || separator > 79) return fail(offset, 'iCCP profile name is not 1 to 79 bytes');
  if (data[separator + 1] !== 0) return fail(offset, 'iCCP compression method is not 0');
  const name = String.fromCodePoint(...data.subarray(0, separator));
  return { name, profile: inflateChecked({ stream: data.subarray(separator + 2), limit: maxBytes, offset, what: 'iCCP profile' }) };
};

const readChromaticities = (chunk: Chunk): PngChromaticities => {
  if (chunk.data.length !== 32) return fail(chunk.offset, 'cHRM length is not 32');
  const [whiteX = 0, whiteY = 0, redX = 0, redY = 0, greenX = 0, greenY = 0, blueX = 0, blueY = 0] = Array.from({ length: 8 }, (_, index) =>
    uint32(chunk.data, index * 4),
  );
  return { whiteX, whiteY, redX, redY, greenX, greenY, blueX, blueY };
};

const readIntent = (chunk: Chunk): PngRenderingIntent => {
  if (chunk.data.length !== 1) return fail(chunk.offset, 'sRGB length is not 1');
  return INTENTS[chunk.data[0] ?? INTENTS.length] ?? fail(chunk.offset, 'sRGB rendering intent is undefined');
};

interface Ancillary {
  palette: Uint8Array | undefined;
  transparency: Transparency | undefined;
  iccProfile: PngIccProfile | undefined;
  srgbIntent: PngRenderingIntent | undefined;
  gamma: number | undefined;
  chromaticities: PngChromaticities | undefined;
}

// PNG Third Edition, 5.6: cHRM, gAMA, iCCP and sRGB precede PLTE and IDAT; tRNS follows PLTE and precedes IDAT; each appears at most once.
const readColorChunk = (chunk: Chunk, state: Ancillary, context: { readonly header: Header; readonly maxBytes: number }): void => {
  const { type, data, offset } = chunk;
  const once = (value: unknown): void => {
    if (value !== undefined) fail(offset, `${type} appears more than once`);
  };
  if (type !== 'tRNS' && state.palette !== undefined) fail(offset, `${type} follows PLTE`);
  switch (type) {
    case 'tRNS': {
      once(state.transparency);
      state.transparency = readTransparency(chunk, context.header, state.palette);
      break;
    }
    case 'gAMA': {
      once(state.gamma);
      if (data.length !== 4) fail(offset, 'gAMA length is not 4');
      state.gamma = uint32(data, 0);
      break;
    }
    case 'cHRM': {
      once(state.chromaticities);
      state.chromaticities = readChromaticities(chunk);
      break;
    }
    case 'sRGB': {
      once(state.srgbIntent);
      state.srgbIntent = readIntent(chunk);
      break;
    }
    default: {
      once(state.iccProfile);
      state.iccProfile = readIcc(chunk, context.maxBytes);
    }
  }
};

const COLOR_CHUNKS = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP']);

interface Datastream {
  readonly state: Ancillary;
  readonly parts: readonly Uint8Array[];
  readonly firstIdat: number;
}

// PNG Third Edition, 5.6: IHDR comes first, PLTE precedes IDAT, the IDAT chunks are consecutive, and IEND comes last.
const readDatastream = (data: Uint8Array, header: Header, context: { readonly start: number; readonly maxBytes: number }): Datastream => {
  const state: Ancillary = {
    palette: undefined,
    transparency: undefined,
    iccProfile: undefined,
    srgbIntent: undefined,
    gamma: undefined,
    chromaticities: undefined,
  };
  const parts: Uint8Array[] = [];
  let idat: 'before' | 'inside' | 'after' = 'before';
  let firstIdat = 0;
  let chunk = readChunk(data, context.start);
  while (chunk.type !== 'IEND') {
    if (idat === 'inside' && chunk.type !== 'IDAT') idat = 'after';
    if (chunk.type === 'IDAT') {
      if (idat === 'after') fail(chunk.offset, 'IDAT chunks are not consecutive');
      if (idat === 'before') firstIdat = chunk.offset;
      idat = 'inside';
      parts.push(chunk.data);
    } else if (chunk.type === 'IHDR') {
      fail(chunk.offset, 'IHDR appears more than once');
    } else if (chunk.type === 'PLTE') {
      if (state.palette !== undefined || idat !== 'before') fail(chunk.offset, 'PLTE is repeated or follows IDAT');
      state.palette = readPalette(chunk, header);
    } else if (COLOR_CHUNKS.has(chunk.type)) {
      if (idat !== 'before') fail(chunk.offset, `${chunk.type} follows IDAT`);
      readColorChunk(chunk, state, { header, maxBytes: context.maxBytes });
    } else if ((chunk.type.codePointAt(0) ?? 0) < 97) {
      // PNG Third Edition, 5.4: a chunk whose first letter is upper case is critical, and an unknown critical chunk cannot be safely ignored.
      throw new UnsupportedFeatureError(`PNG critical chunk ${chunk.type} is unsupported`, 'png-critical-chunk');
    }
    chunk = readChunk(data, chunk.offset + chunk.data.length + 12);
  }
  if (chunk.data.length > 0) fail(chunk.offset, 'IEND is not empty');
  if (parts.length === 0) fail(chunk.offset, 'IDAT is missing');
  if (header.info.colorType === 'indexed' && state.palette === undefined) fail(chunk.offset, 'indexed-colour image has no PLTE');
  return { state, parts, firstIdat };
};

const concatenate = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let written = 0;
  for (const part of parts) {
    output.set(part, written);
    written += part.length;
  }
  return output;
};

const checkIndices = (samples: Uint8Array | Uint16Array, palette: Uint8Array, offset: number): void => {
  const entries = palette.length / 3;
  // PNG Third Edition, 11.2.2: an indexed-colour pixel is an index into PLTE, so an index past the last entry names no colour.
  for (const index of samples) if (index >= entries) fail(offset, 'palette index is past the last PLTE entry');
};

const maxBytesOption = (options: DecodePngOptions): number => {
  const limit = options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new InvalidArgumentError('maxDecodedBytes must be a positive integer');
  return limit;
};

const decodeSamples = (input: { readonly header: Header; readonly datastream: Datastream; readonly maxBytes: number }): Uint8Array | Uint16Array => {
  const { header, datastream, maxBytes } = input;
  const filteredLength = passes(header).reduce((sum, pass) => sum + pass.height * (pass.rowBytes + 1), 0);
  const sampleCount = header.width * header.height * header.info.channels;
  const sampleBytes = sampleCount * (header.bitDepth === 16 ? 2 : 1);
  if (!Number.isSafeInteger(filteredLength) || !Number.isSafeInteger(sampleBytes) || Math.max(filteredLength, sampleBytes) > maxBytes) {
    throw new ResourceLimitError(`PNG image data exceeds maxDecodedBytes (${String(maxBytes)} bytes)`);
  }
  // PNG Third Edition, 10.2: the contents of all the IDAT chunks, concatenated, make up one zlib datastream.
  const filtered = inflateImageData(concatenate(datastream.parts), filteredLength, datastream.firstIdat);
  if (filtered.length !== filteredLength) fail(datastream.firstIdat, 'image data is shorter than the header declares', 'image-truncated');
  const samples = header.bitDepth === 16 ? new Uint16Array(sampleCount) : new Uint8Array(sampleCount);
  unfilter({ filtered, header, samples, offset: datastream.firstIdat });
  const { palette } = datastream.state;
  if (palette !== undefined && header.info.colorType === 'indexed') checkIndices(samples, palette, datastream.firstIdat);
  return samples;
};

/**
 * Decodes a PNG datastream (PNG Third Edition, W3C, which ISO/IEC 15948 standardises): every colour type and bit depth, PLTE and tRNS, Adam7 interlacing, CRC and Adler-32 verification, and the iCCP, sRGB, gAMA and cHRM chunks.
 * Malformed files throw ParseError with an `image-*` reason; an unknown critical chunk throws UnsupportedFeatureError with reason `png-critical-chunk`; an image past `maxDecodedBytes` throws ResourceLimitError; unknown ancillary chunks and bytes after IEND are ignored.
 */
export const decodePng = (data: Uint8Array, options: DecodePngOptions = {}): DecodedPng => {
  const maxBytes = maxBytesOption(options);
  if (data.length < SIGNATURE.length) fail(0, 'signature is truncated', 'image-truncated');
  if (SIGNATURE.some((value, index) => data[index] !== value)) fail(0, 'signature is missing');
  const first = readChunk(data, SIGNATURE.length);
  if (first.type !== 'IHDR') fail(first.offset, 'IHDR is not the first chunk');
  const header = readHeader(first);
  const datastream = readDatastream(data, header, { start: first.offset + first.data.length + 12, maxBytes });
  const samples = decodeSamples({ header, datastream, maxBytes });
  const { state } = datastream;
  return {
    width: header.width,
    height: header.height,
    colorType: header.info.colorType,
    bitDepth: header.bitDepth,
    channels: header.info.channels,
    interlaced: header.interlaced,
    samples,
    palette: state.palette,
    paletteAlpha: state.transparency?.paletteAlpha,
    transparentColor: state.transparency?.transparentColor,
    iccProfile: state.iccProfile,
    srgbIntent: state.srgbIntent,
    gamma: state.gamma,
    chromaticities: state.chromaticities,
  };
};

// PNG Third Edition, 13.12: 1-, 2- and 4-bit values map exactly onto 0 to 255 by multiplying by 255, 85 and 17; 16-bit values keep their high byte.
const SCALE_TO_8 = [0, 255, 85, 0, 17, 0, 0, 0, 1] as const;
const scaleTo8 = (value: number, depth: PngBitDepth): number => (depth === 16 ? Math.floor(value / 256) : value * SCALE_TO_8[depth]);

const writeIndexed = (png: DecodedPng, pixel: number, output: Uint8Array): void => {
  const index = png.samples[pixel] ?? 0;
  output.set(png.palette?.subarray(index * 3, index * 3 + 3) ?? [], pixel * 4);
  output[pixel * 4 + 3] = png.paletteAlpha?.[index] ?? 255;
};

const writeGray = (png: DecodedPng, pixel: number, output: Uint8Array): void => {
  const source = pixel * png.channels;
  const gray = png.samples[source] ?? 0;
  output.fill(scaleTo8(gray, png.bitDepth), pixel * 4, pixel * 4 + 3);
  if (png.channels === 2) output[pixel * 4 + 3] = scaleTo8(png.samples[source + 1] ?? 0, png.bitDepth);
  else output[pixel * 4 + 3] = gray === png.transparentColor?.[0] ? 0 : 255;
};

const writeTruecolor = (png: DecodedPng, pixel: number, output: Uint8Array): void => {
  const source = pixel * png.channels;
  const [red = 0, green = 0, blue = 0, alpha = 0] = png.samples.subarray(source, source + png.channels);
  output[pixel * 4] = scaleTo8(red, png.bitDepth);
  output[pixel * 4 + 1] = scaleTo8(green, png.bitDepth);
  output[pixel * 4 + 2] = scaleTo8(blue, png.bitDepth);
  if (png.channels === 4) output[pixel * 4 + 3] = scaleTo8(alpha, png.bitDepth);
  else {
    const key = png.transparentColor;
    output[pixel * 4 + 3] = red === key?.[0] && green === key[1] && blue === key[2] ? 0 : 255;
  }
};

const PIXEL_WRITERS = {
  indexed: writeIndexed,
  gray: writeGray,
  'gray-alpha': writeGray,
  rgb: writeTruecolor,
  rgba: writeTruecolor,
} as const satisfies Record<PngColorType, (png: DecodedPng, pixel: number, output: Uint8Array) => void>;

/**
 * Converts a decoded PNG to 8-bit RGBA with straight (unassociated) alpha, four bytes per pixel in image order.
 * 16-bit samples are reduced to their high byte (`v >> 8`), which can differ by one from the rounding PNG Third Edition, 13.12 describes; 1-, 2- and 4-bit samples are scaled exactly. Palette entries and tRNS supply colour and alpha, a colour key is matched at the stored sample depth, and no gamma or colour-space conversion is applied.
 */
export const pngToRgba8 = (png: DecodedPng): Uint8Array => {
  const pixels = png.width * png.height;
  const output = new Uint8Array(pixels * 4);
  const write = PIXEL_WRITERS[png.colorType];
  for (let pixel = 0; pixel < pixels; pixel++) write(png, pixel, output);
  return output;
};

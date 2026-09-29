import { deflateZlib } from '../flate/deflate.ts';

import { crc32 } from './crc32.ts';

/** A test image for `encodeTestPng`: samples in the layout `decodePng` returns, and the chunks to write before IDAT. */
export interface TestPng {
  readonly width: number;
  readonly height: number;
  /** The PNG colour type code: 0, 2, 3, 4 or 6. */
  readonly colorType: number;
  readonly bitDepth: number;
  readonly interlaced?: boolean;
  readonly samples: readonly number[];
  readonly before?: readonly Uint8Array[];
  /** How many IDAT chunks the zlib datastream is split across; 1 by default. */
  readonly idatChunks?: number;
  /** Chunks written between consecutive IDAT chunks, which PNG forbids. */
  readonly betweenIdat?: readonly Uint8Array[];
  /** Replaces the zlib datastream that the samples would produce. */
  readonly stream?: Uint8Array;
}

const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/** A big-endian four-byte unsigned integer, as PNG writes lengths, CRCs and header fields. */
export const uint32Bytes = (value: number): number[] => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return [...bytes];
};

/** The bytes of an ASCII string. */
export const asciiBytes = (text: string): number[] => Array.from(text, character => character.codePointAt(0) ?? 0);

/** Writes one chunk with its length and CRC. */
export const pngChunk = (type: string, data: readonly number[] | Uint8Array = []): Uint8Array => {
  const body = Uint8Array.from([...asciiBytes(type), ...data]);
  return Uint8Array.from([...uint32Bytes(body.length - 4), ...body, ...uint32Bytes(crc32(body))]);
};

const POWERS_OF_TWO = [1, 2, 4, 8, 16, 32, 64, 128] as const;

const packRow = (values: readonly number[], depth: number): Uint8Array => {
  const row = new Uint8Array(Math.ceil((values.length * depth) / 8));
  for (const [index, value] of values.entries()) {
    if (depth === 16) {
      row[index * 2] = Math.floor(value / 256);
      row[index * 2 + 1] = value % 256;
    } else {
      const bit = index * depth;
      const byte = Math.floor(bit / 8);
      row[byte] = (row[byte] ?? 0) + value * (POWERS_OF_TWO[8 - depth - (bit % 8)] ?? 1);
    }
  }
  return row;
};

const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const [toLeft, toAbove, toUpperLeft] = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - upperLeft)];
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
  return toAbove <= toUpperLeft ? above : upperLeft;
};

// Each row uses the next of the five filter types in turn, so every filter is exercised.
const filterRows = (rows: readonly Uint8Array[], bytesPerPixel: number, firstType: number): number[] => {
  const output: number[] = [];
  let previous: Uint8Array = new Uint8Array(rows[0]?.length ?? 0);
  for (const [rowIndex, row] of rows.entries()) {
    const type = (firstType + rowIndex) % 5;
    output.push(type);
    for (let index = 0; index < row.length; index++) {
      const left = index >= bytesPerPixel ? (row[index - bytesPerPixel] ?? 0) : 0;
      const above = previous[index] ?? 0;
      const upperLeft = index >= bytesPerPixel ? (previous[index - bytesPerPixel] ?? 0) : 0;
      const prediction = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][type] ?? 0;
      output.push(((row[index] ?? 0) - prediction + 256) % 256);
    }
    previous = row;
  }
  return output;
};

/** The filtered, uncompressed image data for a test image, pass by pass. */
export const filteredImageData = (image: TestPng): Uint8Array => {
  const channels = CHANNELS.get(image.colorType) ?? 1;
  const bytesPerPixel = Math.max(1, Math.ceil((channels * image.bitDepth) / 8));
  const layout = image.interlaced === true ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const output: number[] = [];
  for (const [passIndex, [x0, y0, stepX, stepY]] of layout.entries()) {
    const rows: Uint8Array[] = [];
    for (let y = y0; y < image.height; y += stepY) {
      const values: number[] = [];
      for (let x = x0; x < image.width; x += stepX) {
        for (let channel = 0; channel < channels; channel++) values.push(image.samples[(y * image.width + x) * channels + channel] ?? 0);
      }
      if (values.length > 0) rows.push(packRow(values, image.bitDepth));
    }
    output.push(...filterRows(rows, bytesPerPixel, passIndex));
  }
  return Uint8Array.from(output);
};

/** Encodes a test PNG with this repository's deflater and CRC-32, for decoder tests in every runtime. */
export const encodeTestPng = (image: TestPng): Uint8Array => {
  const header = [...uint32Bytes(image.width), ...uint32Bytes(image.height), image.bitDepth, image.colorType, 0, 0, image.interlaced === true ? 1 : 0];
  const stream: Uint8Array = image.stream ?? deflateZlib(filteredImageData(image));
  const count = image.idatChunks ?? 1;
  const size = Math.ceil(stream.length / count);
  const idat = Array.from({ length: count }, (_, index) => [
    ...(index > 0 ? (image.betweenIdat ?? []) : []),
    pngChunk('IDAT', stream.subarray(index * size, (index + 1) * size)),
  ]).flat();
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', header), ...(image.before ?? []), ...idat, pngChunk('IEND')];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

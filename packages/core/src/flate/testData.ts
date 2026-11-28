// Inputs shared by the deflate and inflate tests, so that both sides of the codec are checked against the same data.

import { seededBytes } from '../testing/seededBytes.ts';

/** One KiB of English text, which compresses into a dynamic Huffman block. */
export const foxText = (): Uint8Array => new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(24).slice(0, 1024));

/** One MiB without structure, which deflate cannot shrink. */
export const randomData = (): Uint8Array => seededBytes(1024 * 1024, 0x12_34_56_78);

/** Ten MiB repeating ABCD, which compresses into long runs of maximal matches. */
export const largeData = (): Uint8Array => {
  const data = new Uint8Array(10 * 1024 * 1024);
  for (let index = 0; index < data.length; index++) {
    data[index] = 65 + (index % 4);
  }
  return data;
};

/** Joins byte arrays in order. */
export const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

/** The length of each array and the first index where they differ, or -1, so a mismatch in megabytes of output prints two numbers rather than a byte-by-byte diff. */
export const comparison = (actual: Uint8Array, expected: Uint8Array): [number, number] => {
  const shorter = Math.min(actual.length, expected.length);
  for (let index = 0; index < shorter; index++) {
    if (actual[index] !== expected[index]) {
      return [actual.length, index];
    }
  }
  return [actual.length, actual.length === expected.length ? -1 : shorter];
};

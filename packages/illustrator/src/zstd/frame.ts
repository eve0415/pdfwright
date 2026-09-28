import { InvalidArgumentError, UnsupportedFeatureError } from '@pdfwright/core';

import { encodeCompressedBlock } from './compressBlock.ts';
import { createMatchFinder } from './matchFinder.ts';

const BLOCK_SIZE = 128 * 1024;

export type ZstandardCompressor = (data: Uint8Array) => Uint8Array;
export type NativeCompression = 'zstandard' | 'zstandard-raw-blocks' | { readonly zstandard: ZstandardCompressor };

const readByte = (bytes: Uint8Array, position: number): number => {
  const byte = bytes[position];
  if (byte === undefined) throw new InvalidArgumentError('truncated Zstandard frame');
  return byte;
};

const readUnsigned = (bytes: Uint8Array, position: number, size: number): bigint => {
  let value = 0n;
  for (let index = 0; index < size; index++) value += BigInt(readByte(bytes, position + index)) << BigInt(index * 8);
  return value;
};

const windowSize = (descriptor: number): bigint => {
  // RFC 8878, 3.1.1.1.2: exponent and mantissa encode a window as base plus eighths of that base.
  const base = 1n << BigInt(10 + (descriptor >> 3));
  return base + (base / 8n) * BigInt(descriptor & 7);
};

const descriptorFor = (size: bigint): number => {
  for (let descriptor = 0x58; descriptor <= 255; descriptor++) {
    if (windowSize(descriptor) >= size) return descriptor;
  }
  throw new InvalidArgumentError('Zstandard frame requires a window beyond the RFC descriptor range');
};

const contentSizeFieldSize = (flag: number, singleSegment: boolean): number => {
  if (flag > 0) return 2 ** flag;
  return singleSegment ? 1 : 0;
};

const walkBlocks = (frame: Uint8Array, start: number): number => {
  let position = start;
  let last = false;
  while (!last) {
    // RFC 8878, 3.1.1.2: each three-byte block header carries size, type and the final-block bit.
    const header = readByte(frame, position) | (readByte(frame, position + 1) << 8) | (readByte(frame, position + 2) << 16);
    position += 3;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 3 || size > BLOCK_SIZE) throw new InvalidArgumentError('invalid Zstandard block');
    const bodySize = type === 1 ? 1 : size;
    if (position + bodySize > frame.length) throw new InvalidArgumentError('truncated Zstandard block');
    position += bodySize;
    last = (header & 1) !== 0;
  }
  return position;
};

/** Rewrites a caller frame to the observed no-size, no-checksum, explicit-window header. */
export const normalizeZstandardFrame = (frame: Uint8Array): Uint8Array => {
  if (readByte(frame, 0) !== 0x28 || readByte(frame, 1) !== 0xb5 || readByte(frame, 2) !== 0x2f || readByte(frame, 3) !== 0xfd) {
    throw new UnsupportedFeatureError('caller must supply one ordinary Zstandard frame');
  }
  const flags = readByte(frame, 4);
  // RFC 8878, 3.1.1.1.1: dictionary IDs and reserved header bits have no valid Illustrator-native use.
  if ((flags & 3) !== 0) throw new UnsupportedFeatureError('Zstandard dictionaries are unsupported');
  if ((flags & 0x18) !== 0) throw new InvalidArgumentError('Zstandard frame has reserved header bits');
  const singleSegment = (flags & 0x20) !== 0;
  const contentSizeFlag = flags >> 6;
  const contentSizeBytes = contentSizeFieldSize(contentSizeFlag, singleSegment);
  let position = 5;
  let descriptor = 0x58;
  if (!singleSegment) {
    descriptor = Math.max(descriptor, readByte(frame, position));
    position++;
  }
  if (contentSizeBytes > 0) {
    // RFC 8878, 3.1.1.1.4: the two-byte content-size form adds 256 to the stored value.
    const contentSize = readUnsigned(frame, position, contentSizeBytes) + (contentSizeBytes === 2 ? 256n : 0n);
    if (singleSegment) descriptor = descriptorFor(contentSize);
    position += contentSizeBytes;
  }
  const blockStart = position;
  const blockEnd = walkBlocks(frame, blockStart);
  position = blockEnd;
  if ((flags & 4) !== 0) position += 4;
  if (position !== frame.length) throw new InvalidArgumentError('Zstandard frame has trailing or missing bytes');
  const output = new Uint8Array(6 + blockEnd - blockStart);
  output.set([0x28, 0xb5, 0x2f, 0xfd, 0, descriptor]);
  output.set(frame.subarray(blockStart, blockEnd), 6);
  return output;
};

/** Encodes one RFC 8878 frame using raw blocks and the 2 MiB window used by Illustrator 30.8.2. */
export const encodeRawFrame = (input: Uint8Array): Uint8Array => {
  const blocks = Math.max(1, Math.ceil(input.length / BLOCK_SIZE));
  const output = new Uint8Array(6 + input.length + 3 * blocks);
  // RFC 8878, 3.1.1 and 3.1.1.1.1.1: magic number, no content size, and an explicit window descriptor.
  output.set([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]);
  let position = 6;
  for (let index = 0; index < blocks; index++) {
    const start = index * BLOCK_SIZE;
    const size = Math.min(BLOCK_SIZE, input.length - start);
    // RFC 8878, 3.1.1.2.1-3.1.1.2.4: a little-endian block header gives last-block, type 0 (Raw_Block), and size.
    const header = (size << 3) | (index === blocks - 1 ? 1 : 0);
    output[position] = header & 255;
    output[position + 1] = (header >>> 8) & 255;
    output[position + 2] = (header >>> 16) & 255;
    position += 3;
    output.set(input.subarray(start, start + size), position);
    position += size;
  }
  return output;
};

/** Encodes one frame using predefined-table compressed blocks when smaller, raw blocks otherwise. */
export const encodeZstandardFrame = (input: Uint8Array): Uint8Array => {
  const finder = createMatchFinder(input);
  const parts: Uint8Array[] = [Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 0x58)];
  const blocks = Math.max(1, Math.ceil(input.length / BLOCK_SIZE));
  for (let index = 0; index < blocks; index++) {
    const start = index * BLOCK_SIZE;
    const end = Math.min(input.length, start + BLOCK_SIZE);
    const parsed = finder.parseBlock(start, end);
    const compressed = encodeCompressedBlock(parsed);
    const useCompressed = compressed.length < end - start;
    const body = useCompressed ? compressed : input.subarray(start, end);
    // RFC 8878, 3.1.1.2: block type 2 is compressed; type 0 is raw, and bit 0 marks the final block.
    const header = (body.length << 3) | (useCompressed ? 4 : 0) | (index === blocks - 1 ? 1 : 0);
    parts.push(Uint8Array.of(header & 255, (header >>> 8) & 255, (header >>> 16) & 255), body);
  }
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

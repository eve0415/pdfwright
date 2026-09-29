import { ParseError } from '../error/parseError.ts';

/** The eight values of the TIFF and Exif Orientation tag: 1 is upright, 2 to 8 name a mirror and/or rotation of the stored rows (TIFF 6.0, Section 8, Orientation). */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** APP2 `ICC_PROFILE` chunks collected so far, by 1-based sequence number, with the chunk count they declare. */
export interface IccChunks {
  count: number;
  readonly chunks: Map<number, Uint8Array>;
}

interface Bounds {
  readonly start: number;
  readonly end: number;
}

// ICC.1:2022, Annex B.4: the APP2 identifier is "ICC_PROFILE" followed by a null byte.
const ICC_IDENTIFIER = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0];
// Exif APP1 data begins with "Exif" and two null bytes, followed by a TIFF header.
const EXIF_IDENTIFIER = [0x45, 0x78, 0x69, 0x66, 0, 0];
const ORIENTATION_TAG = 0x0112;
const SHORT_TYPE = 3;

const startsWith = (data: Uint8Array, bounds: Bounds, prefix: readonly number[]): boolean =>
  bounds.end - bounds.start >= prefix.length && prefix.every((value, index) => data[bounds.start + index] === value);

/** Whether an APP2 segment carries an ICC profile chunk. */
export const isIccSegment = (data: Uint8Array, bounds: Bounds): boolean => startsWith(data, bounds, ICC_IDENTIFIER);

/** Whether an APP1 segment carries Exif data. */
export const isExifSegment = (data: Uint8Array, bounds: Bounds): boolean => startsWith(data, bounds, EXIF_IDENTIFIER);

const invalidIcc = (offset: number, detail: string): never => {
  throw new ParseError(`invalid JPEG ICC profile: ${detail}`, offset, 'image-invalid');
};

/** Records one APP2 ICC chunk; ICC.1:2022, Annex B.4 numbers chunks from 1 and gives every chunk the same total count. */
export const readIccChunk = (data: Uint8Array, bounds: Bounds, chunks: IccChunks): void => {
  const header = bounds.start + ICC_IDENTIFIER.length;
  if (bounds.end - header < 2) invalidIcc(header, 'chunk header is short');
  const sequence = data[header] ?? 0;
  const count = data[header + 1] ?? 0;
  if (count === 0 || sequence === 0 || sequence > count) invalidIcc(header, 'chunk sequence number is outside its count');
  if (chunks.count !== 0 && chunks.count !== count) invalidIcc(header + 1, 'chunks disagree on their count');
  if (chunks.chunks.has(sequence)) invalidIcc(header, 'chunk sequence number repeats');
  chunks.count = count;
  chunks.chunks.set(sequence, data.subarray(header + 2, bounds.end));
};

/** Concatenates the ICC chunks in sequence order, or returns undefined when the file has none. */
export const assembleIccProfile = (chunks: IccChunks, offset: number): Uint8Array | undefined => {
  if (chunks.count === 0) return undefined;
  const parts: Uint8Array[] = [];
  let length = 0;
  for (let sequence = 1; sequence <= chunks.count; sequence++) {
    const part = chunks.chunks.get(sequence) ?? invalidIcc(offset, `chunk ${String(sequence)} of ${String(chunks.count)} is missing`);
    parts.push(part);
    length += part.length;
  }
  const profile = new Uint8Array(length);
  let position = 0;
  for (const part of parts) {
    profile.set(part, position);
    position += part.length;
  }
  return profile;
};

const isOrientation = (value: number): value is ExifOrientation => Number.isInteger(value) && value >= 1 && value <= 8;

/**
 * Reads the Orientation tag from the primary image directory (IFD0) of an Exif APP1 segment.
 * Exif metadata does not affect the samples, so an unreadable TIFF structure, a missing tag, or a value outside 1 to 8 yields undefined rather than an error.
 */
export const readExifOrientation = (data: Uint8Array, bounds: Bounds): ExifOrientation | undefined => {
  const tiff = bounds.start + EXIF_IDENTIFIER.length;
  const length = bounds.end - tiff;
  // TIFF 6.0, Section 2, Image File Header: "II" or "MM" byte order, the number 42, and the offset of the first IFD, all relative to the header.
  if (length < 8) return undefined;
  const view = new DataView(data.buffer, data.byteOffset + tiff, length);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return undefined;
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) return undefined;
  const directory = view.getUint32(4, little);
  // TIFF 6.0, Section 2, Image File Directory: a 2-byte entry count followed by 12-byte entries of tag, type, count and value or offset.
  if (directory < 8 || directory + 2 > length) return undefined;
  const entries = view.getUint16(directory, little);
  for (let index = 0; index < entries; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > length) return undefined;
    if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue;
    // TIFF 6.0, Section 8, Orientation: Type SHORT, Count 1; a value of four bytes or fewer is stored in the entry, left-justified.
    if (view.getUint16(entry + 2, little) !== SHORT_TYPE || view.getUint32(entry + 4, little) !== 1) return undefined;
    const value = view.getUint16(entry + 8, little);
    return isOrientation(value) ? value : undefined;
  }
  return undefined;
};

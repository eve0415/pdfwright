import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';

interface Box {
  readonly type: string;
  readonly content: number;
  readonly end: number;
}

const boxAt = (bytes: Uint8Array, offset: number, boundary: number): Box | undefined => {
  if (offset + 8 > boundary) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(offset);
  const type = new TextDecoder('latin1').decode(bytes.subarray(offset + 4, offset + 8));
  let header = 8;
  let length = declared;
  if (declared === 1) {
    if (offset + 16 > boundary) return undefined;
    length = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12);
    header = 16;
  } else if (declared === 0) length = boundary - offset;
  if (!Number.isSafeInteger(length) || length < header || offset + length > boundary) return undefined;
  return { type, content: offset + header, end: offset + length };
};

const rgbColr = (bytes: Uint8Array, box: Box, maxProfileBytes: number): boolean => {
  if (box.end - box.content < 3) return false;
  const method = bytes[box.content];
  if (method === 1) {
    if (box.end - box.content < 7) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(box.content + 3) === 16;
  }
  if (method !== 2) return false;
  const size = box.end - box.content - 3;
  if (size > maxProfileBytes) throw new ResourceLimitError(`JP2 embedded ICC profile exceeds maxDecodedBytes (${String(maxProfileBytes)} bytes)`);
  try {
    const profile = parseIccProfile(bytes.subarray(box.content + 3, box.end));
    return profile.header.colorSpace === 'RGB';
  } catch (error: unknown) {
    if (error instanceof InvalidProfileError || error instanceof UnsupportedFeatureError) return false;
    throw error;
  }
};

const headerRgb = (bytes: Uint8Array, header: Box, maxProfileBytes: number): boolean => {
  for (let offset = header.content; offset < header.end;) {
    const box = boxAt(bytes, offset, header.end);
    if (box === undefined) return false;
    if (box.type === 'colr') return rgbColr(bytes, box, maxProfileBytes);
    offset = box.end;
  }
  return false;
};

/** Reads the first JP2 colr box and accepts only an explicit sRGB enumeration or RGB ICC profile. ISO 32000-1:2008, 7.4.9 says JPX colour data is used when an image dictionary has no ColorSpace and may contain enumerated spaces or ICC profiles. */
export const jpxHasRgbColor = (bytes: Uint8Array, maxProfileBytes: number): boolean => {
  const signature = boxAt(bytes, 0, bytes.length);
  if (signature?.type !== 'jP  ' || signature.end - signature.content !== 4) return false;
  if ([0x0d, 0x0a, 0x87, 0x0a].some((byte, index) => bytes[signature.content + index] !== byte)) return false;
  for (let offset = signature.end; offset < bytes.length;) {
    const box = boxAt(bytes, offset, bytes.length);
    if (box === undefined) return false;
    if (box.type === 'jp2h') return headerRgb(bytes, box, maxProfileBytes);
    offset = box.end;
  }
  return false;
};

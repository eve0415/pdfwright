import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { Lexer } from '../parse/lexer.ts';

import { isWhitespace } from '../parse/characterClass.ts';

const inlineParameter = (values: readonly PdfDirectObject[], names: readonly string[]): PdfDirectObject | undefined => {
  for (let index = 0; index + 1 < values.length; index += 2) {
    const key = values[index];
    if (key?.kind === 'name' && names.includes(new TextDecoder('latin1').decode(key.bytes))) return values[index + 1];
  }
  return undefined;
};

const COMPONENTS = new Map([
  ['G', 1],
  ['DeviceGray', 1],
  ['RGB', 3],
  ['DeviceRGB', 3],
  ['CMYK', 4],
  ['DeviceCMYK', 4],
  ['I', 1],
  ['Indexed', 1],
]);

const imageComponents = (mask: PdfDirectObject | undefined, space: PdfDirectObject | undefined): number | undefined => {
  if (mask?.kind === 'boolean' && mask.value) return 1;
  return space?.kind === 'name' ? COMPONENTS.get(new TextDecoder('latin1').decode(space.bytes)) : undefined;
};

const imageBits = (mask: PdfDirectObject | undefined, bits: PdfDirectObject | undefined): number | undefined => {
  if (bits?.kind === 'integer') return bits.value;
  return mask?.kind === 'boolean' && mask.value ? 1 : undefined;
};

// ISO 32000-1:2008, 8.9.3 pads each sample row to a byte boundary; 8.9.7, Table 93 gives inline image width, height, bits, colour space and filter keys.
const unfilteredImageLength = (parameters: readonly PdfDirectObject[]): number | undefined => {
  if (parameters.length % 2 !== 0 || inlineParameter(parameters, ['F', 'Filter']) !== undefined) return undefined;
  const width = inlineParameter(parameters, ['W', 'Width']);
  const height = inlineParameter(parameters, ['H', 'Height']);
  const mask = inlineParameter(parameters, ['IM', 'ImageMask']);
  const bits = inlineParameter(parameters, ['BPC', 'BitsPerComponent']);
  const space = inlineParameter(parameters, ['CS', 'ColorSpace']);
  const components = imageComponents(mask, space);
  const perComponent = imageBits(mask, bits);
  if (width?.kind !== 'integer' || height?.kind !== 'integer' || components === undefined || perComponent === undefined) return undefined;
  if (width.value <= 0 || height.value <= 0 || ![1, 2, 4, 8, 16].includes(perComponent)) return undefined;
  const rowBits = width.value * components * perComponent;
  const length = Math.ceil(rowBits / 8) * height.value;
  return Number.isSafeInteger(rowBits) && Number.isSafeInteger(length) ? length : undefined;
};

const exactInlineEnd = (bytes: Uint8Array, start: number, length: number): number | undefined => {
  if (start + length >= bytes.length) return undefined;
  let end = start + length;
  while (end < bytes.length && isWhitespace(bytes[end] ?? 0)) end++;
  return end > start + length && bytes[end] === 0x45 && bytes[end + 1] === 0x49 && (end + 2 >= bytes.length || isWhitespace(bytes[end + 2] ?? 0))
    ? end + 2
    : undefined;
};

// ISO 32000-1:2008, 8.9.7: "Unless the image uses ASCIIHexDecode or ASCII85Decode as one of its filters, the ID operator shall be followed by a single white-space character, and the next character shall be interpreted as the first byte of image data."
/**
 * Reads the data of an inline image whose parameters the lexer has just read up to and including ID, and leaves the lexer after the EI that ends it.
 * Unfiltered data is measured from width, height, components and bits per component, so that an EI sequence inside the samples does not end it; other data ends at the first EI between white-space characters.
 */
export const inlineImageData = (lexer: Lexer, parameters: readonly PdfDirectObject[]): Uint8Array => {
  const { bytes } = lexer;
  const start = lexer.position + (isWhitespace(bytes[lexer.position] ?? 0) ? 1 : 0);
  const length = unfilteredImageLength(parameters);
  const exact = length === undefined ? undefined : exactInlineEnd(bytes, start, length);
  if (exact !== undefined && length !== undefined) {
    lexer.seek(exact);
    return bytes.subarray(start, start + length);
  }
  for (let position = start; position + 1 < bytes.length; position++) {
    if (
      bytes[position] === 0x45 &&
      bytes[position + 1] === 0x49 &&
      isWhitespace(bytes[position - 1] ?? 0x20) &&
      (position + 2 >= bytes.length || isWhitespace(bytes[position + 2] ?? 0x20))
    ) {
      lexer.seek(position + 2);
      return bytes.subarray(start, Math.max(start, position - 1));
    }
  }
  lexer.seek(bytes.length);
  return bytes.subarray(start);
};

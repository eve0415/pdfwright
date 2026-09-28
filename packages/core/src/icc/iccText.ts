import { InvalidProfileError } from '../error/invalidProfileError.ts';

const signature = (bytes: Uint8Array, offset: number): string =>
  String.fromCodePoint(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
const invalid = (offset: number): never => {
  throw new InvalidProfileError('invalid ICC text tag', 'bad-tag-data', { offset });
};

const ascii = (bytes: Uint8Array, start: number, end: number): string => new TextDecoder('ascii').decode(bytes.subarray(start, end));

const description = (bytes: Uint8Array, view: DataView, range: { start: number; end: number }): string => {
  // ICC.1:2001-04, 6.5.17 Table 68: the invariant ASCII count includes its terminating zero.
  const { start, end } = range;
  if (end - start < 13) invalid(start);
  const count = view.getUint32(start + 8);
  if (count < 1 || count > end - start - 12 || bytes[start + 12 + count - 1] !== 0) invalid(start + 8);
  return ascii(bytes, start + 12, start + 12 + count - 1);
};

const plainText = (bytes: Uint8Array, start: number, end: number): string => {
  // ICC.1:2001-04, 6.5.18 Table 70: textType fills the tag after byte 8 and ends with 00h.
  if (end - start < 9 || bytes[end - 1] !== 0) invalid(start);
  return ascii(bytes, start + 8, end - 1);
};

const localized = (bytes: Uint8Array, view: DataView, range: { start: number; end: number }): string => {
  // ICC.1:2022, 10.15 Table 54: each 12-byte record points to a UTF-16BE string within the tag.
  const { start, end } = range;
  if (end - start < 28) invalid(start);
  const count = view.getUint32(start + 8);
  const size = view.getUint32(start + 12);
  if (count === 0 || size !== 12 || count > Math.floor((end - start - 16) / 12)) invalid(start + 8);
  let choice = 0;
  let priority = 0;
  for (let index = 0; index < count; index++) {
    const record = start + 16 + index * 12;
    const length = view.getUint32(record + 4);
    const offset = view.getUint32(record + 8);
    if (length % 2 !== 0 || offset < 16 + count * 12 || offset > end - start || length > end - start - offset) invalid(record);
    const language = ascii(bytes, record, record + 2);
    const country = ascii(bytes, record + 2, record + 4);
    let rank = 0;
    if (language === 'en') rank = country === 'US' ? 2 : 1;
    if (rank > priority) {
      choice = index;
      priority = rank;
    }
  }
  const selected = start + 16 + choice * 12;
  const length = view.getUint32(selected + 4);
  const offset = view.getUint32(selected + 8);
  try {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(start + offset, start + offset + length));
  } catch {
    return invalid(selected);
  }
};

export const readIccText = (bytes: Uint8Array, start: number, end: number): string => {
  if (start < 0 || end > bytes.length || end - start < 8) invalid(start);
  const type = signature(bytes, start);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'desc') return description(bytes, view, { start, end });
  if (type === 'text') return plainText(bytes, start, end);
  if (type === 'mluc') return localized(bytes, view, { start, end });
  throw new InvalidProfileError('ICC tag must be a text type', 'tag-type-mismatch', { offset: start });
};

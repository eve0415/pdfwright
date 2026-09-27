import { ParseError } from '../../error/parseError.ts';

/** Big-endian reads of a font program's bytes, which throw ParseError past the end of the view so that a reader of a table can turn damage into a reason. */
export interface SfntReader {
  readonly u8: (offset: number) => number;
  readonly u16: (offset: number) => number;
  readonly u24: (offset: number) => number;
  readonly u32: (offset: number) => number;
}

export const sfntReader = (data: Uint8Array): SfntReader => {
  const byte = (offset: number): number => {
    const value = data[offset];
    if (value === undefined || offset < 0) throw new ParseError(`the program ends before byte ${String(offset)}`, offset);
    return value;
  };
  return {
    u8: byte,
    u16: (offset: number): number => byte(offset) * 256 + byte(offset + 1),
    u24: (offset: number): number => byte(offset) * 65_536 + byte(offset + 1) * 256 + byte(offset + 2),
    u32: (offset: number): number => byte(offset) * 16_777_216 + byte(offset + 1) * 65_536 + byte(offset + 2) * 256 + byte(offset + 3),
  };
};

/**
 * The bytes of a table of a TrueType or OpenType program, found in its table directory: sfntVersion, numTables, three search fields, then 16-byte records of tag, checksum, offset and length (the OpenType specification's font file chapter).
 * Undefined when the program has no such table; ParseError when the program is not a TrueType or OpenType font or the table runs past its end.
 */
export const findTable = (data: Uint8Array, tag: string): Uint8Array | undefined => {
  const read = sfntReader(data);
  const version = read.u32(0);
  if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) throw new ParseError('the program is not a TrueType or OpenType font', 0);
  const count = read.u16(4);
  for (let index = 0; index < count; index++) {
    const record = 12 + 16 * index;
    const name = String.fromCodePoint(read.u8(record), read.u8(record + 1), read.u8(record + 2), read.u8(record + 3));
    if (name !== tag) continue;
    const offset = read.u32(record + 8);
    const length = read.u32(record + 12);
    if (offset + length > data.length) throw new ParseError(`the ${tag} table runs past the end of the program`, 0);
    return data.subarray(offset, offset + length);
  }
  return undefined;
};

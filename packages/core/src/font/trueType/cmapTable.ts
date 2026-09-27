import { ParseError } from '../../error/parseError.ts';

/**
 * The Unicode `cmap` subtable of an embedded TrueType or OpenType program, and its format 14 variation sequences.
 * Only the table directory and the `cmap` table are read; every offset and count is checked against the bytes present, so a damaged program gives a reason instead of an exception.
 * The table formats follow the OpenType specification's `cmap` chapter (formats 4, 12 and 14).
 */
export interface TrueTypeCmap {
  /** The platform and encoding identifiers and the format of the subtable read. */
  readonly platform: number;
  readonly encoding: number;
  readonly format: 4 | 12;
  /** The glyph index the subtable maps a Unicode code point to, or undefined when it maps it to nothing or to glyph 0. */
  readonly glyph: (codePoint: number) => number | undefined;
  /** For a variation sequence of format 14: `default` when the base character's own glyph is used, the glyph index of a non-default variant, or undefined when the sequence is not listed. */
  readonly variant: (codePoint: number, selector: number) => number | 'default' | undefined;
}

export type CmapReading =
  | { readonly kind: 'cmap'; readonly cmap: TrueTypeCmap }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Big-endian reads that throw ParseError past the end of the view, which `readTrueTypeCmap` turns into a reason. */
const reader = (data: Uint8Array) => {
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

type Reader = ReturnType<typeof reader>;

// The table directory: sfntVersion, numTables, three search fields, then 16-byte records of tag, checksum, offset and length.
const findTable = (read: Reader, data: Uint8Array, tag: string): Uint8Array | undefined => {
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

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly delta: number;
  /** The byte offset in the subtable of the glyph for `start`, or 0 when the delta applies to the code point itself. */
  readonly glyphs: number;
}

const bySearch = <T extends { readonly start: number; readonly end: number }>(items: readonly T[], key: number): T | undefined => {
  let first = 0;
  let last = items.length - 1;
  while (first <= last) {
    const middle = Math.floor((first + last) / 2);
    const item = items[middle];
    if (item === undefined) return undefined;
    if (key < item.start) last = middle - 1;
    else if (key > item.end) first = middle + 1;
    else return item;
  }
  return undefined;
};

// Format 4: segCountX2 at 6, then endCode[segCount], reservedPad, startCode[segCount], idDelta[segCount], idRangeOffset[segCount] and glyphIdArray.
const format4 = (table: Uint8Array): ((codePoint: number) => number | undefined) => {
  const read = reader(table);
  const length = Math.min(read.u16(2), table.length);
  const count = read.u16(6) / 2;
  if (!Number.isInteger(count) || 16 + 8 * count > length) throw new ParseError('the format 4 segment count does not fit the subtable', 0);
  const segments: Segment[] = [];
  for (let index = 0; index < count; index++) {
    const rangeOffset = read.u16(16 + 6 * count + 2 * index);
    segments.push({
      end: read.u16(14 + 2 * index),
      start: read.u16(16 + 2 * count + 2 * index),
      delta: read.u16(16 + 4 * count + 2 * index),
      glyphs: rangeOffset === 0 ? 0 : 16 + 6 * count + 2 * index + rangeOffset,
    });
  }
  const view = reader(table.subarray(0, length));
  return (codePoint: number): number | undefined => {
    if (codePoint > 0xffff) return undefined;
    const segment = bySearch(segments, codePoint);
    if (segment === undefined) return undefined;
    // "If the idRangeOffset value for the segment is not 0, the mapping of character codes relies on glyphIdArray"; "All idDelta[i] arithmetic is modulo 65536."
    let glyph = codePoint;
    if (segment.glyphs !== 0) {
      const at = segment.glyphs + 2 * (codePoint - segment.start);
      glyph = at + 1 < length ? view.u16(at) : 0;
      if (glyph === 0) return undefined;
    }
    const mapped = (glyph + segment.delta) % 65_536;
    return mapped === 0 ? undefined : mapped;
  };
};

interface Group {
  readonly start: number;
  readonly end: number;
  readonly glyph: number;
}

// Format 12: length at 4 and numGroups at 12, then 12-byte groups of startCharCode, endCharCode and startGlyphID.
const format12 = (table: Uint8Array): ((codePoint: number) => number | undefined) => {
  const read = reader(table);
  const count = read.u32(12);
  if (16 + 12 * count > Math.min(read.u32(4), table.length)) throw new ParseError('the format 12 group count does not fit the subtable', 0);
  const groups: Group[] = [];
  for (let index = 0; index < count; index++) {
    const at = 16 + 12 * index;
    groups.push({ start: read.u32(at), end: read.u32(at + 4), glyph: read.u32(at + 8) });
  }
  return (codePoint: number): number | undefined => {
    const group = bySearch(groups, codePoint);
    const glyph = group === undefined ? 0 : group.glyph + (codePoint - group.start);
    return glyph === 0 ? undefined : glyph;
  };
};

interface Selector {
  readonly selector: number;
  readonly defaults: readonly { readonly start: number; readonly end: number }[];
  readonly mappings: ReadonlyMap<number, number>;
}

// Format 14: numVarSelectorRecords at 6, then 11-byte records of varSelector (24-bit), defaultUVSOffset and nonDefaultUVSOffset, each offset from the subtable's start.
const format14 = (table: Uint8Array): Selector[] => {
  const read = reader(table);
  const count = read.u32(6);
  if (10 + 11 * count > Math.min(read.u32(2), table.length)) throw new ParseError('the format 14 record count does not fit the subtable', 0);
  const selectors: Selector[] = [];
  for (let index = 0; index < count; index++) {
    const at = 10 + 11 * index;
    const defaultOffset = read.u32(at + 3);
    const mappingOffset = read.u32(at + 7);
    const defaults: { start: number; end: number }[] = [];
    const mappings = new Map<number, number>();
    const ranges = defaultOffset === 0 ? 0 : read.u32(defaultOffset);
    if (defaultOffset !== 0 && defaultOffset + 4 + 4 * ranges > table.length) throw new ParseError('a default UVS table does not fit the subtable', 0);
    for (let range = 0; range < ranges; range++) {
      const start = read.u24(defaultOffset + 4 + 4 * range);
      defaults.push({ start, end: start + read.u8(defaultOffset + 7 + 4 * range) });
    }
    const pairs = mappingOffset === 0 ? 0 : read.u32(mappingOffset);
    if (mappingOffset !== 0 && mappingOffset + 4 + 5 * pairs > table.length) throw new ParseError('a non-default UVS table does not fit the subtable', 0);
    for (let pair = 0; pair < pairs; pair++) mappings.set(read.u24(mappingOffset + 4 + 5 * pair), read.u16(mappingOffset + 7 + 5 * pair));
    selectors.push({ selector: read.u24(at), defaults, mappings });
  }
  return selectors;
};

interface Subtable {
  readonly platform: number;
  readonly encoding: number;
  readonly offset: number;
  readonly format: number;
}

// Unicode subtables in order of preference: full-repertoire format 12 before BMP format 4, Windows before Unicode platform.
const RANK: readonly (readonly [number, number, number])[] = [
  [3, 10, 12],
  [0, 6, 12],
  [0, 4, 12],
  [3, 1, 4],
  [0, 3, 4],
  [0, 2, 4],
  [0, 1, 4],
  [0, 0, 4],
];

const rank = (subtable: Subtable): number =>
  RANK.findIndex(([platform, encoding, format]) => platform === subtable.platform && encoding === subtable.encoding && format === subtable.format);

const buildCmap = (table: Uint8Array): CmapReading => {
  const read = reader(table);
  const count = read.u16(2);
  const subtables: Subtable[] = [];
  for (let index = 0; index < count; index++) {
    const record = 4 + 8 * index;
    const offset = read.u32(record + 4);
    subtables.push({ platform: read.u16(record), encoding: read.u16(record + 2), offset, format: read.u16(offset) });
  }
  const unicode = subtables.filter(subtable => rank(subtable) >= 0).toSorted((left, right) => rank(left) - rank(right));
  const [chosen] = unicode;
  if (chosen === undefined) return { kind: 'absent' };
  const body = table.subarray(chosen.offset);
  const glyph = chosen.format === 12 ? format12(body) : format4(body);
  const variations = subtables.find(subtable => subtable.platform === 0 && subtable.encoding === 5 && subtable.format === 14);
  const selectors = variations === undefined ? [] : format14(table.subarray(variations.offset));
  return {
    kind: 'cmap',
    cmap: {
      platform: chosen.platform,
      encoding: chosen.encoding,
      format: chosen.format === 12 ? 12 : 4,
      glyph,
      variant: (codePoint: number, selector: number): number | 'default' | undefined => {
        const record = selectors.find(item => item.selector === selector);
        if (record === undefined) return undefined;
        if (record.defaults.some(range => codePoint >= range.start && codePoint <= range.end)) return 'default';
        return record.mappings.get(codePoint);
      },
    },
  };
};

/** Reads the Unicode `cmap` subtable of a TrueType or OpenType program: `absent` when the program has no `cmap` table or no format 4 or 12 Unicode subtable, `unreadable` with a reason when the bytes are damaged. */
export const readTrueTypeCmap = (program: Uint8Array): CmapReading => {
  try {
    const table = findTable(reader(program), program, 'cmap');
    return table === undefined ? { kind: 'absent' } : buildCmap(table);
  } catch (error) {
    if (error instanceof ParseError) return { kind: 'unreadable', reason: error.message };
    throw error;
  }
};

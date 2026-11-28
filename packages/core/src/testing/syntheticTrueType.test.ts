import type { CmapReading, TrueTypeCmap } from '../font/trueType/cmapTable.ts';

import { describe, expect, it } from 'vitest';

import { readTrueTypeCmap } from '../font/trueType/cmapTable.ts';

import { syntheticTrueType } from './syntheticTrueType.ts';

const FONT = syntheticTrueType({
  name: 'PdfwrightTest',
  glyphs: [
    { advance: 500, box: [50, 0, 450, 700] },
    { advance: 600, box: [0, -200, 600, 800], vertical: { advance: 900, topSideBearing: 50 } },
    { advance: 400, box: [100, 0, 300, 500] },
    { advance: 250 },
  ],
  characters: [
    [0x41, 1],
    [0x42, 2],
    [0x20, 3],
    [0x2_0b_b7, 2],
  ],
  variations: [{ selector: 0xe_01_00, defaults: [0x41], glyphs: [[0x42, 1]] }],
});

const u16 = (bytes: Uint8Array, offset: number): number => (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
const u32 = (bytes: Uint8Array, offset: number): number => u16(bytes, offset) * 65_536 + u16(bytes, offset + 2);
const i16 = (bytes: Uint8Array, offset: number): number => {
  const value = u16(bytes, offset);
  return value >= 32_768 ? value - 65_536 : value;
};

const checksum = (bytes: Uint8Array): number => {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    sum = (sum + u32(bytes, offset)) % 4_294_967_296;
  }
  return sum;
};

// The tables of the program by tag, from its table directory.
const tables = (bytes: Uint8Array): Map<string, { readonly data: Uint8Array; readonly checksum: number }> => {
  const found = new Map<string, { readonly data: Uint8Array; readonly checksum: number }>();
  for (let index = 0; index < u16(bytes, 4); index++) {
    const record = 12 + 16 * index;
    const tag = String.fromCodePoint(...bytes.subarray(record, record + 4));
    found.set(tag, { data: bytes.subarray(u32(bytes, record + 8), u32(bytes, record + 8) + u32(bytes, record + 12)), checksum: u32(bytes, record + 4) });
  }
  return found;
};

const cmapOf = (reading: CmapReading): TrueTypeCmap => {
  if (reading.kind !== 'cmap') {
    throw new Error(`the cmap table does not read: ${reading.kind}`);
  }
  return reading.cmap;
};

const tableData = (found: ReturnType<typeof tables>, tag: string): Uint8Array => {
  const table = found.get(tag);
  if (table === undefined) {
    throw new Error(`the program has no ${tag} table`);
  }
  return table.data;
};

// The platform, encoding and format of each cmap subtable, in record order.
const cmapRecords = (cmap: Uint8Array): Array<readonly [number, number, number]> =>
  Array.from({ length: u16(cmap, 2) }, (_, index) => {
    const record = 4 + 8 * index;
    return [u16(cmap, record), u16(cmap, record + 2), u16(cmap, u32(cmap, record + 4))] as const;
  });

const nameRecord = (name: Uint8Array, platform: number, encoding: number, language: number, id: number): Uint8Array => {
  const storage = u16(name, 4);
  for (let index = 0; index < u16(name, 2); index++) {
    const record = 6 + 12 * index;
    if (u16(name, record) === platform && u16(name, record + 2) === encoding && u16(name, record + 4) === language && u16(name, record + 6) === id) {
      const start = storage + u16(name, record + 10);
      return name.subarray(start, start + u16(name, record + 8));
    }
  }
  throw new Error(`the name table has no record ${String(id)} for platform ${String(platform)}`);
};

describe('synthetic TrueType programs', () => {
  it('writes every table the embedded-font readers expect, each with its checksum', () => {
    const found = tables(FONT);
    expect([...found.keys()]).toStrictEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post', 'vhea', 'vmtx']);
    const headData = tableData(found, 'head');
    // The head checksum is recorded with checkSumAdjustment counted as 0.
    expect(found.get('head')?.checksum).toBe((checksum(headData) - u32(headData, 8) + 4_294_967_296) % 4_294_967_296);
    found.delete('head');
    expect([...found].filter(([, table]) => table.checksum !== checksum(table.data))).toStrictEqual([]);
  });

  it('sets checkSumAdjustment so that the whole program sums to 0xB1B0AFBA', () => {
    expect(checksum(FONT)).toBe(0xb1_b0_af_ba);
  });

  it('writes the glyph count, advance widths and vertical advances it was given', () => {
    const found = tables(FONT);
    const advances = tableData(found, 'hmtx');
    const verticals = tableData(found, 'vmtx');
    expect(u16(tableData(found, 'maxp'), 4)).toBe(4);
    expect([0, 1, 2, 3].map(glyph => u16(advances, 4 * glyph))).toStrictEqual([500, 600, 400, 250]);
    expect([0, 1, 2, 3].map(glyph => [u16(verticals, 4 * glyph), u16(verticals, 4 * glyph + 2)])).toStrictEqual([
      [1000, 0],
      [900, 50],
      [1000, 0],
      [1000, 0],
    ]);
  });

  it('maps characters and variation sequences through its cmap table', () => {
    const cmap = cmapOf(readTrueTypeCmap(FONT));
    expect([cmap.format, cmap.glyph(0x41), cmap.glyph(0x42), cmap.glyph(0x2_0b_b7), cmap.glyph(0x43)]).toStrictEqual([12, 1, 2, 2, undefined]);
    expect([cmap.variant(0x41, 0xe_01_00), cmap.variant(0x42, 0xe_01_00)]).toStrictEqual(['default', 1]);
  });

  it('writes each fixed-size table at its fixed length and each per-glyph table at its glyph count', () => {
    const found = tables(FONT);
    const lengths = ['head', 'hhea', 'maxp', 'post', 'OS/2', 'vhea', 'hmtx', 'vmtx', 'loca'].map(tag => [tag, tableData(found, tag).length]);
    expect(lengths).toStrictEqual([
      ['head', 54],
      ['hhea', 36],
      ['maxp', 32],
      ['post', 32],
      ['OS/2', 96],
      ['vhea', 36],
      ['hmtx', 16],
      ['vmtx', 16],
      ['loca', 20],
    ]);
  });

  it('writes a format 4 subtable for BMP characters, read when no character is astral', () => {
    expect(cmapRecords(tableData(tables(FONT), 'cmap'))).toStrictEqual([
      [0, 5, 14],
      [3, 1, 4],
      [3, 10, 12],
    ]);
    const bmp = syntheticTrueType({
      name: 'T',
      glyphs: [{ advance: 500 }, { advance: 500 }, { advance: 500 }, { advance: 500 }],
      characters: [
        [0x41, 1],
        [0x20, 3],
        [0xff_08, 2],
      ],
    });
    const cmap = cmapOf(readTrueTypeCmap(bmp));
    expect([cmap.platform, cmap.encoding, cmap.format]).toStrictEqual([3, 1, 4]);
    expect([cmap.glyph(0x20), cmap.glyph(0x41), cmap.glyph(0xff_08), cmap.glyph(0x42)]).toStrictEqual([3, 1, 2, undefined]);
  });

  it('writes each glyph box minimum x as its left side bearing and the union of the boxes as the font box', () => {
    const found = tables(FONT);
    const metrics = tableData(found, 'hmtx');
    expect([0, 1, 2, 3].map(glyph => i16(metrics, 4 * glyph + 2))).toStrictEqual([50, 0, 100, 0]);
    expect([36, 38, 40, 42].map(offset => i16(tableData(found, 'head'), offset))).toStrictEqual([0, -200, 600, 800]);
    const empty = tables(syntheticTrueType({ name: 'T', glyphs: [{ advance: 500 }, { advance: 300 }], characters: [[0x41, 1]] }));
    expect([36, 38, 40, 42].map(offset => i16(tableData(empty, 'head'), offset))).toStrictEqual([0, 0, 0, 0]);
  });

  it('writes the ascender and descender it is given to hhea and OS/2', () => {
    const found = tables(syntheticTrueType({ name: 'T', glyphs: [{ advance: 500 }], characters: [], ascender: 900, descender: -300 }));
    expect([4, 6].map(offset => i16(tableData(found, 'hhea'), offset))).toStrictEqual([900, -300]);
    const os2 = tableData(found, 'OS/2');
    expect([i16(os2, 68), i16(os2, 70), u16(os2, 74), u16(os2, 76)]).toStrictEqual([900, -300, 900, 300]);
  });

  it('writes the PostScript name for the Macintosh and Windows platforms', () => {
    const name = tableData(tables(FONT), 'name');
    const windows = nameRecord(name, 3, 1, 0x4_09, 6);
    expect(String.fromCodePoint(...Array.from({ length: windows.length / 2 }, (_, index) => u16(windows, 2 * index)))).toBe('PdfwrightTest');
    expect(String.fromCodePoint(...nameRecord(name, 1, 0, 0, 6))).toBe('PdfwrightTest');
  });

  it('writes variation selector records in ascending selector order, whatever order they are given in', () => {
    const font = syntheticTrueType({
      name: 'T',
      glyphs: [{ advance: 500 }, { advance: 500 }],
      characters: [
        [0x41, 1],
        [0x42, 1],
      ],
      variations: [
        { selector: 0xe_01_00, defaults: [], glyphs: [[0x42, 1]] },
        { selector: 0xfe_0f, defaults: [0x41], glyphs: [] },
      ],
    });
    const cmap = tableData(tables(font), 'cmap');
    const subtable = u32(cmap, 4 + 4);
    // OpenType cmap format 14: each VariationSelector record is a uint24 selector followed by two Offset32 values.
    const selectors = Array.from(
      { length: u32(cmap, subtable + 6) },
      (_, index) => u16(cmap, subtable + 10 + 11 * index) * 256 + (cmap[subtable + 12 + 11 * index] ?? 0),
    );
    expect(selectors).toStrictEqual([0xfe_0f, 0xe_01_00]);
    const read = cmapOf(readTrueTypeCmap(font));
    expect([read.variant(0x41, 0xfe_0f), read.variant(0x42, 0xe_01_00), read.variant(0x41, 0xe_01_00)]).toStrictEqual(['default', 1, undefined]);
  });

  it.each([
    ['an advance above uint16', { glyphs: [{ advance: 65_536 }] }],
    ['a negative advance', { glyphs: [{ advance: -1 }] }],
    ['a fractional advance', { glyphs: [{ advance: 500.5 }] }],
    ['a box coordinate above int16', { glyphs: [{ advance: 500, box: [0, 0, 32_768, 10] }] }],
    ['a box whose minimum exceeds its maximum', { glyphs: [{ advance: 500, box: [10, 0, 5, 10] }] }],
    ['a box too wide for an int16 delta', { glyphs: [{ advance: 500, box: [-20_000, 0, 20_000, 10] }] }],
    ['a negative vertical advance', { glyphs: [{ advance: 500, vertical: { advance: -1, topSideBearing: 0 } }] }],
    ['a vertical advance above uint16', { glyphs: [{ advance: 500, vertical: { advance: 70_000, topSideBearing: 0 } }] }],
    ['a top side bearing above int16', { glyphs: [{ advance: 500, vertical: { advance: 1000, topSideBearing: 40_000 } }] }],
    ['a character mapped to a missing glyph', { characters: [[0x41, 1]] }],
    [
      'a character listed twice',
      {
        glyphs: [{ advance: 500 }, { advance: 500 }],
        characters: [
          [0x41, 1],
          [0x41, 0],
        ],
      },
    ],
    ['a code point above U+10FFFF', { characters: [[0x11_00_00, 0]] }],
    [
      'a variation selector listed twice',
      {
        variations: [
          { selector: 0xfe_00, defaults: [0x41], glyphs: [] },
          { selector: 0xfe_00, defaults: [0x42], glyphs: [] },
        ],
      },
    ],
    ['a variation mapped to a missing glyph', { variations: [{ selector: 0xfe_00, defaults: [], glyphs: [[0x41, 3]] }] }],
    ['a base character listed twice under one selector', { variations: [{ selector: 0xfe_00, defaults: [0x41], glyphs: [[0x41, 0]] }] }],
    ['an odd unitsPerEm', { unitsPerEm: 1001 }],
    ['a unitsPerEm above 16384', { unitsPerEm: 16_386 }],
    ['a positive descender', { descender: 10 }],
    ['an ascender above int16', { ascender: 32_768 }],
    ['a name outside printable ASCII', { name: 'Caf\u00E9' }],
  ] as const)('refuses %s', (_, options) => {
    expect(() => syntheticTrueType({ name: 'T', glyphs: [{ advance: 500 }], characters: [], ...options })).toThrow(RangeError);
  });

  it('refuses more BMP characters than one format 4 subtable can hold, rather than wrapping its length', () => {
    const characters = Array.from({ length: 8200 }, (_, index) => [0x4e_00 + index, 1] as const);
    expect(() => syntheticTrueType({ name: 'T', glyphs: [{ advance: 500 }, { advance: 500 }], characters })).toThrow(RangeError);
  });

  it('accepts the extremes of each field', () => {
    const font = syntheticTrueType({
      name: 'T',
      glyphs: [{ advance: 0 }, { advance: 65_535, box: [-16_383, -16_383, 16_383, 16_383], vertical: { advance: 0, topSideBearing: -32_767 } }],
      characters: [[0x10_ff_ff, 1]],
      unitsPerEm: 16_384,
      ascender: 32_767,
      descender: -32_767,
    });
    expect(cmapOf(readTrueTypeCmap(font)).glyph(0x10_ff_ff)).toBe(1);
    expect([u16(tableData(tables(font), 'hmtx'), 4), i16(tableData(tables(font), 'vmtx'), 6)]).toStrictEqual([65_535, -32_767]);
  });
});

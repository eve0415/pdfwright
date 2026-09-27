import type { CmapReading, TrueTypeCmap } from '../font/trueType/cmapTable.ts';

import { describe, expect, it } from 'vitest';

import { readTrueTypeCmap } from '../font/trueType/cmapTable.ts';

import { syntheticTrueType } from './syntheticTrueType.ts';

const FONT = syntheticTrueType({
  name: 'PdfwrightTest',
  glyphs: [
    { advance: 500, box: [50, 0, 450, 700] },
    { advance: 600, box: [0, -200, 600, 800], vertical: { advance: 1000, topSideBearing: 0 } },
    { advance: 400, box: [100, 0, 300, 500] },
    { advance: 250 },
  ],
  characters: [
    [0x41, 1],
    [0x42, 2],
    [0x20, 3],
    [0x20bb7, 2],
  ],
  variations: [{ selector: 0xe0100, defaults: [0x41], glyphs: [[0x42, 1]] }],
});

const u16 = (bytes: Uint8Array, offset: number): number => (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
const u32 = (bytes: Uint8Array, offset: number): number => u16(bytes, offset) * 65_536 + u16(bytes, offset + 2);

const checksum = (bytes: Uint8Array): number => {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) sum = (sum + u32(bytes, offset)) % 4_294_967_296;
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
  if (reading.kind !== 'cmap') throw new Error(`the cmap table does not read: ${reading.kind}`);
  return reading.cmap;
};

const tableData = (found: ReturnType<typeof tables>, tag: string): Uint8Array => {
  const table = found.get(tag);
  if (table === undefined) throw new Error(`the program has no ${tag} table`);
  return table.data;
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
    expect(checksum(FONT)).toBe(0xb1b0afba);
  });

  it('writes the glyph count, advance widths and vertical advances it was given', () => {
    const found = tables(FONT);
    const advances = tableData(found, 'hmtx');
    const verticals = tableData(found, 'vmtx');
    expect(u16(tableData(found, 'maxp'), 4)).toBe(4);
    expect([0, 1, 2, 3].map(glyph => u16(advances, 4 * glyph))).toStrictEqual([500, 600, 400, 250]);
    expect([0, 1].map(glyph => u16(verticals, 4 * glyph))).toStrictEqual([1000, 1000]);
  });

  it('maps characters and variation sequences through its cmap table', () => {
    const cmap = cmapOf(readTrueTypeCmap(FONT));
    expect([cmap.format, cmap.glyph(0x41), cmap.glyph(0x42), cmap.glyph(0x20bb7), cmap.glyph(0x43)]).toStrictEqual([12, 1, 2, 2, undefined]);
    expect([cmap.variant(0x41, 0xe0100), cmap.variant(0x42, 0xe0100)]).toStrictEqual(['default', 1]);
  });
});

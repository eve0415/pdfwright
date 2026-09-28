import type { CmapReading, TrueTypeCmap } from './cmapTable.ts';

import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../../error/resourceLimitError.ts';

import { readTrueTypeCmap } from './cmapTable.ts';

// Big-endian bytes of unsigned integers of the given byte widths.
const bytes = (...fields: readonly (readonly [number, number])[]): number[] =>
  fields.flatMap(([value, width]) => Array.from({ length: width }, (_, index) => Math.floor(value / 256 ** (width - 1 - index)) % 256));

const u16 = (...values: readonly number[]): number[] => bytes(...values.map(value => [value, 2] as const));
const u32 = (...values: readonly number[]): number[] => bytes(...values.map(value => [value, 4] as const));
const u24 = (value: number): number[] => bytes([value, 3]);

// A font program holding only a table directory and the given tables, each at a 4-byte aligned offset.
const program = (tables: readonly (readonly [string, readonly number[]])[]): Uint8Array => {
  const header = [...u32(0x00010000), ...u16(tables.length, 0, 0, 0)];
  let offset = header.length + 16 * tables.length;
  const directory: number[] = [];
  const bodies: number[] = [];
  for (const [tag, body] of tables) {
    directory.push(...Array.from(tag, character => character.codePointAt(0) ?? 0), ...u32(0, offset, body.length));
    const padded = [...body, ...Array.from({ length: (4 - (body.length % 4)) % 4 }, () => 0)];
    bodies.push(...padded);
    offset += padded.length;
  }
  return Uint8Array.from([...header, ...directory, ...bodies]);
};

// A cmap table with the given subtables, as [platform, encoding, subtable bytes].
const cmapTable = (subtables: readonly (readonly [number, number, readonly number[]])[]): number[] => {
  let offset = 4 + 8 * subtables.length;
  const records: number[] = [];
  const bodies: number[] = [];
  for (const [platform, encoding, body] of subtables) {
    records.push(...u16(platform, encoding), ...u32(offset));
    bodies.push(...body);
    offset += body.length;
  }
  return [...u16(0, subtables.length), ...records, ...bodies];
};

// Format 4 with the given segments: `glyphs`, when given, are read through idRangeOffset instead of the delta.
interface TestSegment {
  readonly start: number;
  readonly end: number;
  readonly delta: number;
  readonly glyphs?: readonly number[];
}

const format4 = (segments: readonly TestSegment[]): number[] => {
  const all: readonly TestSegment[] = [...segments, { start: 0xffff, end: 0xffff, delta: 1 }];
  const count = all.length;
  const glyphArrays: number[] = [];
  const rangeOffsets = all.map(({ glyphs }, index) => {
    if (glyphs === undefined) return 0;
    // idRangeOffset counts bytes from its own position to the glyph in glyphIdArray.
    const offset = 2 * (count - index) + 2 * glyphArrays.length;
    glyphArrays.push(...glyphs);
    return offset;
  });
  const body = [
    ...u16(...all.map(({ end }) => end)),
    ...u16(0),
    ...u16(...all.map(({ start }) => start)),
    ...u16(...all.map(({ delta }) => (delta + 65_536) % 65_536)),
    ...u16(...rangeOffsets),
    ...u16(...glyphArrays),
  ];
  return [...u16(4, 14 + body.length, 0, 2 * count, 0, 0, 0), ...body];
};

const format12 = (groups: readonly (readonly [number, number, number])[]): number[] => [
  ...u16(12, 0),
  ...u32(16 + 12 * groups.length, 0, groups.length),
  ...groups.flatMap(([start, end, glyph]) => u32(start, end, glyph)),
];

// Format 14 with one selector record: a default UVS range [start, additional count] and non-default mappings [code point, glyph].
const format14 = (selector: number, ranges: readonly (readonly [number, number])[], mappings: readonly (readonly [number, number])[]): number[] => {
  const defaultTable = [...u32(ranges.length), ...ranges.flatMap(([start, count]) => [...u24(start), count])];
  const mappingTable = [...u32(mappings.length), ...mappings.flatMap(([codePoint, glyph]) => [...u24(codePoint), ...u16(glyph)])];
  const header = 10 + 11;
  return [
    ...u16(14),
    ...u32(header + defaultTable.length + mappingTable.length, 1),
    ...u24(selector),
    ...u32(header, header + defaultTable.length),
    ...defaultTable,
    ...mappingTable,
  ];
};

const cmapOf = (reading: CmapReading): TrueTypeCmap => {
  if (reading.kind !== 'cmap') throw new Error(`expected a cmap, got ${reading.kind}`);
  return reading.cmap;
};

// A program with one cmap table of the given subtables.
const programWith = (subtables: readonly (readonly [number, number, readonly number[]])[]): Uint8Array => program([['cmap', cmapTable(subtables)]]);

describe('embedded TrueType cmap tables', () => {
  it('refuses unsorted or overlapping format 4 segments and format 12 groups', () => {
    const cases = [
      programWith([
        [
          3,
          10,
          format12([
            [100, 100, 7],
            [65, 65, 3],
          ]),
        ],
      ]),
      programWith([
        [
          3,
          10,
          format12([
            [65, 100, 3],
            [100, 120, 7],
          ]),
        ],
      ]),
      programWith([
        [
          3,
          1,
          format4([
            { start: 100, end: 100, delta: 1 },
            { start: 65, end: 65, delta: 1 },
          ]),
        ],
      ]),
      programWith([
        [
          3,
          1,
          format4([
            { start: 65, end: 100, delta: 1 },
            { start: 100, end: 120, delta: 1 },
          ]),
        ],
      ]),
    ];
    expect(cases.map(input => readTrueTypeCmap(input).kind)).toStrictEqual(['unreadable', 'unreadable', 'unreadable', 'unreadable']);
  });

  it('maps characters through format 4 deltas and glyph arrays, and nothing outside its segments', () => {
    const subtable = format4([
      { start: 0x41, end: 0x43, delta: -0x3f },
      { start: 0x3000, end: 0x3002, delta: 0, glyphs: [9, 0, 11] },
    ]);
    const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 1, subtable]])));
    expect([cmap.platform, cmap.encoding, cmap.format]).toStrictEqual([3, 1, 4]);
    expect([0x41, 0x43, 0x44, 0x3000, 0x3001, 0x3002, 0x10000].map(codePoint => cmap.glyph(codePoint))).toStrictEqual([
      2,
      4,
      undefined,
      9,
      undefined,
      11,
      undefined,
    ]);
    expect([cmap.characters(2), cmap.characters(9), cmap.characters(10)]).toStrictEqual([[0x41], [0x3000], []]);
  });

  it('prefers a (3, 10) format 12 subtable, which reaches beyond the Basic Multilingual Plane', () => {
    const table = cmapTable([
      [3, 1, format4([{ start: 0x41, end: 0x41, delta: 1 }])],
      [
        3,
        10,
        format12([
          [0x41, 0x41, 7],
          [0x20bb7, 0x20bb8, 100],
        ]),
      ],
    ]);
    const input = program([
      ['head', u32(0, 0, 0)],
      ['cmap', table],
    ]);
    const cmap = cmapOf(readTrueTypeCmap(input));
    expect([cmap.format, cmap.glyph(0x41), cmap.glyph(0x20bb8), cmap.glyph(0x20bb9)]).toStrictEqual([12, 7, 101, undefined]);
    expect([cmap.characters(7), cmap.characters(101), cmap.characters(102)]).toStrictEqual([[0x41], [0x20bb8], []]);
  });

  it('reads format 14 variation sequences as default or as a glyph of their own', () => {
    const base = format4([{ start: 0x845b, end: 0x845b, delta: 0 }]);
    const variations = format14(0xe0100, [[0x845b, 0]], [[0x845c, 77]]);
    const cmap = cmapOf(
      readTrueTypeCmap(
        programWith([
          [0, 3, base],
          [0, 5, variations],
        ]),
      ),
    );
    expect([cmap.variant(0x845b, 0xe0100), cmap.variant(0x845c, 0xe0100), cmap.variant(0x845d, 0xe0100), cmap.variant(0x845b, 0xe0101)]).toStrictEqual([
      'default',
      77,
      undefined,
      undefined,
    ]);
  });

  it('limits decoded format 14 mappings before building a large map', () => {
    const base = format4([{ start: 0x41, end: 0x41, delta: 1 }]);
    const mappings = Array.from({ length: 16_385 }, (_, index) => [0x1000 + index, 1] as const);
    const variations = format14(0xfe0f, [], mappings);
    expect(() =>
      readTrueTypeCmap(
        programWith([
          [3, 1, base],
          [0, 5, variations],
        ]),
      ),
    ).toThrow(ResourceLimitError);
  });

  it('reports a program without a cmap table or without a Unicode subtable', () => {
    const withoutCmap = program([['head', u32(0)]]);
    const withoutUnicode = programWith([[1, 0, u16(6, 10, 0, 0, 0)]]);
    expect([readTrueTypeCmap(withoutCmap), readTrueTypeCmap(withoutUnicode)]).toStrictEqual([{ kind: 'absent' }, { kind: 'absent' }]);
  });

  it('reports truncated and inconsistent tables without throwing', () => {
    const good = programWith([[3, 1, format4([{ start: 0x41, end: 0x43, delta: 1 }])]]);
    const truncated = good.slice(0, -6);
    const bigCount = Uint8Array.from(good);
    // segCountX2 sits 6 bytes into the format 4 subtable, which follows the 12-byte header, one 16-byte table record and the 12-byte cmap header.
    bigCount[12 + 16 + 12 + 6] = 0xff;
    const collection = Uint8Array.of(0x74, 0x74, 0x63, 0x66, 0, 1);
    const kinds = [truncated, bigCount, collection, new Uint8Array(3)].map(input => readTrueTypeCmap(input).kind);
    expect(kinds).toStrictEqual(['unreadable', 'unreadable', 'unreadable', 'unreadable']);
  });
});

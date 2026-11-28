import type { CmapReading, TrueTypeCmap } from './cmapTable.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../../error/resourceLimitError.ts';

import { readTrueTypeCmap } from './cmapTable.ts';

// Big-endian bytes of unsigned integers of the given byte widths.
const bytes = (...fields: ReadonlyArray<readonly [number, number]>): Array<number> =>
  fields.flatMap(([value, width]) => Array.from({ length: width }, (_, index) => Math.floor(value / 256 ** (width - 1 - index)) % 256));

const u16 = (...values: ReadonlyArray<number>): Array<number> => bytes(...values.map(value => [value, 2] as const));
const u32 = (...values: ReadonlyArray<number>): Array<number> => bytes(...values.map(value => [value, 4] as const));
const u24 = (value: number): Array<number> => bytes([value, 3]);

// A font program holding only a table directory and the given tables, each at a 4-byte aligned offset.
const program = (tables: ReadonlyArray<readonly [string, ReadonlyArray<number>]>): Uint8Array => {
  const header = [...u32(0x00_01_00_00), ...u16(tables.length, 0, 0, 0)];
  let offset = header.length + 16 * tables.length;
  const directory: Array<number> = [];
  const bodies: Array<number> = [];
  for (const [tag, body] of tables) {
    directory.push(...Array.from(tag, character => character.codePointAt(0) ?? 0), ...u32(0, offset, body.length));
    const padded = [...body, ...Array.from({ length: (4 - (body.length % 4)) % 4 }, () => 0)];
    // A loop rather than a spread call, which runs out of stack for tables of a few hundred kilobytes.
    for (const byte of padded) {
      bodies.push(byte);
    }
    offset += padded.length;
  }
  return Uint8Array.from([...header, ...directory, ...bodies]);
};

// A cmap table with the given subtables, as [platform, encoding, subtable bytes].
const cmapTable = (subtables: ReadonlyArray<readonly [number, number, ReadonlyArray<number>]>): Array<number> => {
  let offset = 4 + 8 * subtables.length;
  const records: Array<number> = [];
  const bodies: Array<number> = [];
  for (const [platform, encoding, body] of subtables) {
    records.push(...u16(platform, encoding), ...u32(offset));
    for (const byte of body) {
      bodies.push(byte);
    }
    offset += body.length;
  }
  return [...u16(0, subtables.length), ...records, ...bodies];
};

// Format 4 with the given segments: `glyphs`, when given, are read through idRangeOffset instead of the delta.
interface TestSegment {
  readonly start: number;
  readonly end: number;
  readonly delta: number;
  readonly glyphs?: ReadonlyArray<number>;
}

const format4 = (segments: ReadonlyArray<TestSegment>): Array<number> => {
  const all: ReadonlyArray<TestSegment> = [...segments, { start: 0xff_ff, end: 0xff_ff, delta: 1 }];
  const count = all.length;
  const glyphArrays: Array<number> = [];
  const rangeOffsets = all.map(({ glyphs }, index) => {
    if (glyphs === undefined) {
      return 0;
    }
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

const format12 = (groups: ReadonlyArray<readonly [number, number, number]>): Array<number> => [
  ...u16(12, 0),
  ...u32(16 + 12 * groups.length, 0, groups.length),
  ...groups.flatMap(([start, end, glyph]) => u32(start, end, glyph)),
];

// Format 14 with one selector record: a default UVS range [start, additional count] and non-default mappings [code point, glyph].
const format14 = (selector: number, ranges: ReadonlyArray<readonly [number, number]>, mappings: ReadonlyArray<readonly [number, number]>): Array<number> => {
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
  if (reading.kind !== 'cmap') {
    throw new Error(`expected a cmap, got ${reading.kind}`);
  }
  return reading.cmap;
};

// A program with one cmap table of the given subtables.
const programWith = (subtables: ReadonlyArray<readonly [number, number, ReadonlyArray<number>]>): Uint8Array => program([['cmap', cmapTable(subtables)]]);

// Count byte reads through every subarray of the same font program.
const countReads = (input: Uint8Array) => {
  let reads = 0;
  const counted = (data: Uint8Array): Uint8Array =>
    new Proxy(data, {
      get(target, property): number | Uint8Array['subarray'] | undefined {
        if (property === 'subarray') {
          return (start?: number, end?: number): Uint8Array => counted(target.subarray(start, end));
        }
        if (property === 'length') {
          return target.length;
        }
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          reads++;
          return target[Number(property)];
        }
        throw new Error('unexpected font byte access');
      },
    });
  return { program: counted(input), reads: () => reads };
};

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
      { start: 0x30_00, end: 0x30_02, delta: 0, glyphs: [9, 0, 11] },
    ]);
    const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 1, subtable]])));
    expect([cmap.platform, cmap.encoding, cmap.format]).toStrictEqual([3, 1, 4]);
    expect([0x41, 0x43, 0x44, 0x30_00, 0x30_01, 0x30_02, 0x1_00_00].map(codePoint => cmap.glyph(codePoint))).toStrictEqual([
      2,
      4,
      undefined,
      9,
      undefined,
      11,
      undefined,
    ]);
    expect([cmap.characters(2), cmap.characters(9), cmap.characters(10)]).toStrictEqual([[0x41], [0x30_00], []]);
  });

  it.each([
    {
      format: 4,
      encoding: 1,
      subtable: format4([{ start: 0x41, end: 0x60, delta: 0, glyphs: Array.from({ length: 32 }, (_, index) => index + 1) }]),
      characters: Array.from({ length: 32 }, (_, index) => 0x41 + index),
    },
    {
      format: 12,
      encoding: 10,
      subtable: format12(Array.from({ length: 32 }, (_, index) => [0x1_00_00 + 2 * index, 0x1_00_00 + 2 * index, index + 1] as const)),
      characters: Array.from({ length: 32 }, (_, index) => 0x1_00_00 + 2 * index),
    },
  ])('builds the format $format reverse index once across distinct glyphs', ({ encoding, subtable, characters }) => {
    const input = programWith([[3, encoding, subtable]]);
    const counted = countReads(input);
    const cmap = cmapOf(readTrueTypeCmap(counted.program));
    const [first] = characters;
    expect(cmap.characters(1)).toStrictEqual([first]);
    const indexedReads = counted.reads();
    expect(indexedReads).toBeLessThanOrEqual(4 * input.length);
    for (const [index, character] of characters.entries()) {
      expect(cmap.characters(index + 1)).toStrictEqual([character]);
    }
    for (let glyph = characters.length + 1; glyph <= 4 * characters.length; glyph++) {
      expect(cmap.characters(glyph)).toStrictEqual([]);
    }
    expect(cmap.characters(1)).toStrictEqual([first]);
    expect(counted.reads()).toBe(indexedReads);
  });

  it('reverses format 4 aliases, glyph arrays and wrapped deltas', () => {
    const subtable = format4([
      { start: 0x41, end: 0x43, delta: -0x3f },
      { start: 0x1_00, end: 0x1_02, delta: 2, glyphs: [0xff_ff, 0, 2] },
      { start: 0x2_00, end: 0x2_00, delta: -0x1_fe },
      { start: 0xff_fd, end: 0xff_fe, delta: 2 },
    ]);
    const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 1, subtable]])));
    expect([0, 1, 2, 3, 4, 5, 0xff_ff].map(glyph => cmap.characters(glyph))).toStrictEqual([
      [],
      [0x1_00],
      [0x41, 0x2_00],
      [0x42],
      [0x43, 0x1_02],
      [],
      [0xff_fd],
    ]);
  });

  it('reverses format 12 aliases across groups and supplementary planes', () => {
    const subtable = format12([
      [0x41, 0x43, 7],
      [0x1_00_00, 0x1_00_02, 8],
      [0x10_ff_ff, 0x10_ff_ff, 7],
    ]);
    const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 10, subtable]])));
    expect([7, 8, 9, 10, 11].map(glyph => cmap.characters(glyph))).toStrictEqual([[0x41, 0x10_ff_ff], [0x42, 0x1_00_00], [0x43, 0x1_00_01], [0x1_00_02], []]);
  });

  it('prefers a (3, 10) format 12 subtable, which reaches beyond the Basic Multilingual Plane', () => {
    const table = cmapTable([
      [3, 1, format4([{ start: 0x41, end: 0x41, delta: 1 }])],
      [
        3,
        10,
        format12([
          [0x41, 0x41, 7],
          [0x2_0b_b7, 0x2_0b_b8, 100],
        ]),
      ],
    ]);
    const input = program([
      ['head', u32(0, 0, 0)],
      ['cmap', table],
    ]);
    const cmap = cmapOf(readTrueTypeCmap(input));
    expect([cmap.format, cmap.glyph(0x41), cmap.glyph(0x2_0b_b8), cmap.glyph(0x2_0b_b9)]).toStrictEqual([12, 7, 101, undefined]);
    expect([cmap.characters(7), cmap.characters(101), cmap.characters(102)]).toStrictEqual([[0x41], [0x2_0b_b8], []]);
  });

  it('reads format 14 variation sequences as default or as a glyph of their own', () => {
    const base = format4([{ start: 0x84_5b, end: 0x84_5b, delta: 0 }]);
    // The default UVS range starts at U+845B with additionalCount 2, so it covers U+845B to U+845D.
    const variations = format14(0xe_01_00, [[0x84_5b, 2]], [[0x84_60, 77]]);
    const cmap = cmapOf(
      readTrueTypeCmap(
        programWith([
          [0, 3, base],
          [0, 5, variations],
        ]),
      ),
    );
    expect([
      cmap.variant(0x84_5b, 0xe_01_00),
      cmap.variant(0x84_5d, 0xe_01_00),
      cmap.variant(0x84_5e, 0xe_01_00),
      cmap.variant(0x84_60, 0xe_01_00),
      cmap.variant(0x84_5b, 0xe_01_01),
    ]).toStrictEqual(['default', 'default', undefined, 77, undefined]);
  });

  it('limits decoded format 14 mappings before building a large map', () => {
    const base = format4([{ start: 0x41, end: 0x41, delta: 1 }]);
    const mappings = Array.from({ length: 16_385 }, (_, index) => [0x10_00 + index, 1] as const);
    const variations = format14(0xfe_0f, [], mappings);
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

// A program with a format 4 subtable and the given format 14 subtable.
const withVariations = (variations: ReadonlyArray<number>): Uint8Array =>
  programWith([
    [3, 1, format4([{ start: 0x41, end: 0x41, delta: 1 }])],
    [0, 5, variations],
  ]);

// Format 14 with `count` selector records that list no sequences.
const emptySelectors = (count: number): Array<number> => [
  ...u16(14),
  ...u32(10 + 11 * count, count),
  ...Array.from({ length: count }, (_, index) => [...u24(0xfe_00 + index), ...u32(0, 0)]).flat(),
];

// `count` non-default variation mappings, each to glyph 1.
const variationMappings = (count: number): Array<readonly [number, number]> => Array.from({ length: count }, (_, index) => [0x10_00 + index, 1] as const);

// What breaks the inverse of a cmap over some code points: mapped code points missing from their glyph's characters, characters that map to another glyph, and how many characters the mapped glyphs list against how many code points map.
interface InverseFaults {
  readonly missing: Array<number>;
  readonly stray: Array<number>;
  readonly listed: number;
  readonly mapped: number;
}

const inverseFaults = (cmap: TrueTypeCmap, codePoints: ReadonlyArray<number>): InverseFaults => {
  const mapped = codePoints.flatMap(codePoint => {
    const glyph = cmap.glyph(codePoint);
    return glyph === undefined ? [] : [[codePoint, glyph] as const];
  });
  const glyphs = [...new Set(mapped.map(([, glyph]) => glyph))];
  return {
    missing: mapped.flatMap(([codePoint, glyph]) => (cmap.characters(glyph).includes(codePoint) ? [] : [codePoint])),
    stray: glyphs.flatMap(glyph => cmap.characters(glyph).filter(codePoint => cmap.glyph(codePoint) !== glyph)),
    listed: glyphs.flatMap(glyph => cmap.characters(glyph)).length,
    mapped: mapped.length,
  };
};

describe('embedded TrueType cmap tables, damaged or at their limits', () => {
  it.each([
    { label: 'a format 4 segment that starts after its end', subtable: (): Array<number> => format4([{ start: 0x50, end: 0x41, delta: 1 }]), encoding: 1 },
    { label: 'a format 12 group past U+10FFFF', subtable: (): Array<number> => format12([[0x10_ff_f0, 0x11_00_00, 1]]), encoding: 10 },
    {
      label: 'an odd segCountX2',
      subtable: (): Array<number> => {
        const subtable = format4([{ start: 0x41, end: 0x43, delta: 1 }]);
        // segCountX2 is the fourth 16-bit field of the format 4 header; 5 is odd, and its half rounded down is the true segment count, so only its oddness is wrong.
        subtable.splice(6, 2, ...u16(5));
        return subtable;
      },
      encoding: 1,
    },
  ])('reports $label as unreadable', ({ subtable, encoding }) => {
    expect(readTrueTypeCmap(programWith([[3, encoding, subtable()]])).kind).toBe('unreadable');
  });

  it('reads a format 12 group that ends at U+10FFFF', () => {
    const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 10, format12([[0x10_ff_f0, 0x10_ff_ff, 1]])]])));
    expect(cmap.glyph(0x10_ff_ff)).toBe(16);
  });

  it('gives no glyph for a glyphIdArray entry the subtable length does not cover, and reads the entry it does', () => {
    const segments = [
      { start: 0x41, end: 0x42, delta: 0, glyphs: [5, 6] },
      { start: 0x61, end: 0x61, delta: 1 },
    ];
    // Three segments with the closing one: the 16-byte header and arrays are followed by glyphIdArray.
    const lengthOf = (covered: number): Array<number> => {
      const subtable = format4(segments);
      subtable.splice(2, 2, ...u16(16 + 8 * 3 + 2 * covered));
      return subtable;
    };
    const glyphs = [0, 1].map(covered => {
      const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 1, lengthOf(covered)]])));
      return [cmap.glyph(0x41), cmap.glyph(0x42), cmap.glyph(0x61)];
    });
    expect(glyphs).toStrictEqual([
      [undefined, undefined, 0x62],
      [5, undefined, 0x62],
    ]);
  });

  it.each([
    {
      label: '(3, 1) format 4 over (0, 3) format 4',
      subtables: [
        [0, 3, format4([{ start: 0x41, end: 0x41, delta: 6 }])],
        [3, 1, format4([{ start: 0x41, end: 0x41, delta: 7 }])],
      ],
      chosen: [3, 1, 4, 0x48],
    },
    {
      label: '(0, 4) format 12 over (3, 1) format 4',
      subtables: [
        [3, 1, format4([{ start: 0x41, end: 0x41, delta: 7 }])],
        [0, 4, format12([[0x41, 0x41, 9]])],
      ],
      chosen: [0, 4, 12, 9],
    },
  ] as const)('prefers $label', ({ subtables, chosen }) => {
    const cmap = cmapOf(readTrueTypeCmap(programWith(subtables)));
    expect([cmap.platform, cmap.encoding, cmap.format, cmap.glyph(0x41)]).toStrictEqual(chosen);
  });

  it('reads no Unicode subtable from a (3, 10) subtable in format 4', () => {
    expect(readTrueTypeCmap(programWith([[3, 10, format4([{ start: 0x41, end: 0x41, delta: 1 }])]]))).toStrictEqual({ kind: 'absent' });
  });

  it('reports a subtable record whose offset lies past the cmap table as unreadable', () => {
    const table = cmapTable([[3, 1, format4([{ start: 0x41, end: 0x41, delta: 1 }])]]);
    // The record's offset is the last 32-bit field of the 8-byte record after the 4-byte cmap header.
    table.splice(8, 4, ...u32(0xff_ff));
    expect(readTrueTypeCmap(program([['cmap', table]])).kind).toBe('unreadable');
  });

  it('accepts 16,384 format 14 selector records and throws ResourceLimitError for one more', () => {
    expect(readTrueTypeCmap(withVariations(emptySelectors(16_384))).kind).toBe('cmap');
    expect(() => readTrueTypeCmap(withVariations(emptySelectors(16_385)))).toThrow(ResourceLimitError);
  });

  it('accepts 16,384 format 14 entries counting its record and throws ResourceLimitError for one more', () => {
    expect(readTrueTypeCmap(withVariations(format14(0xfe_0f, [], variationMappings(16_383)))).kind).toBe('cmap');
    expect(() => readTrueTypeCmap(withVariations(format14(0xfe_0f, [], variationMappings(16_384))))).toThrow(ResourceLimitError);
  });

  it('reports a default UVS table that runs past the subtable as unreadable', () => {
    const variations = format14(0xfe_0f, [[0x41, 0]], []);
    // The default UVS table follows the 21-byte header and record; its numUnicodeValueRanges claims five ranges where one is present.
    variations.splice(21, 4, ...u32(5));
    expect(readTrueTypeCmap(withVariations(variations)).kind).toBe('unreadable');
  });
});

describe('properties', () => {
  // Disjoint segments below U+FF00, each mapped by a delta or through glyphIdArray, and disjoint format 12 groups across the planes.
  const segment = fc.record({
    gap: fc.integer({ min: 1, max: 40 }),
    span: fc.integer({ min: 0, max: 8 }),
    delta: fc.integer({ min: 0, max: 65_535 }),
    glyphs: fc.option(fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 9, maxLength: 9 }), { nil: undefined }),
  });
  const group = fc.record({ gap: fc.integer({ min: 1, max: 30_000 }), span: fc.integer({ min: 0, max: 8 }), glyph: fc.integer({ min: 0, max: 60 }) });

  it('inverts format 4 segments exactly', () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 40 }), items => {
        let next = 0;
        const segments = items.map(({ gap, span, delta, glyphs }): TestSegment => {
          const start = next + gap;
          next = start + span;
          return glyphs === undefined ? { start, end: start + span, delta } : { start, end: start + span, delta, glyphs: glyphs.slice(0, span + 1) };
        });
        const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 1, format4(segments)]])));
        const faults = inverseFaults(
          cmap,
          Array.from({ length: next + 2 }, (_, index) => index),
        );
        expect(faults).toStrictEqual({ missing: [], stray: [], listed: faults.mapped, mapped: faults.mapped });
      }),
    );
  });

  it('inverts format 12 groups exactly', () => {
    fc.assert(
      fc.property(fc.array(group, { minLength: 1, maxLength: 30 }), items => {
        let next = 0;
        const groups = items.map(({ gap, span, glyph }) => {
          const start = next + gap;
          next = start + span;
          return [start, start + span, glyph] as const;
        });
        const cmap = cmapOf(readTrueTypeCmap(programWith([[3, 10, format12(groups)]])));
        const faults = inverseFaults(cmap, [
          ...new Set(groups.flatMap(([start, end]) => Array.from({ length: end - start + 3 }, (_, index) => start - 1 + index))),
        ]);
        expect(faults).toStrictEqual({ missing: [], stray: [], listed: faults.mapped, mapped: faults.mapped });
      }),
    );
  });
});

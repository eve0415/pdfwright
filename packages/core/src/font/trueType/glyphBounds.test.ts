import type { Rectangle } from '../fontModel.ts';
import type { GlyphBoundsReading } from './glyphBounds.ts';

import { describe, expect, it } from 'vitest';

import { syntheticTrueType } from '../../testing/syntheticTrueType.ts';

import { readTrueTypeGlyphBounds } from './glyphBounds.ts';

// Big-endian bytes of unsigned 16-bit and 32-bit integers.
const u16 = (...values: readonly number[]): number[] => values.flatMap(value => [Math.floor(value / 256) % 256, value % 256]);
const u32 = (...values: readonly number[]): number[] => values.flatMap(value => u16(Math.floor(value / 65_536), value % 65_536));

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

const zeros = (length: number): number[] => Array.from({ length }, () => 0);

// head with unitsPerEm at byte 18 and indexToLocFormat at byte 50; maxp with numGlyphs at byte 4.
const head = (unitsPerEm: number, format: number): number[] => [...zeros(18), ...u16(unitsPerEm), ...zeros(30), ...u16(format, 0)];
const maxp = (glyphs: number): number[] => [...u32(0x00005000), ...u16(glyphs)];

// A glyf header: numberOfContours, xMin, yMin, xMax, yMax, as 16-bit two's complement.
const glyph = (...box: readonly number[]): number[] => u16(1, ...box.map(value => (value < 0 ? value + 65_536 : value)));

// The boxes the program gives the glyphs, or the kind of reading when it gives none.
const boundsOf = (font: Uint8Array, glyphs: readonly number[]): readonly (Rectangle | 'empty' | undefined)[] | GlyphBoundsReading['kind'] => {
  const reading = readTrueTypeGlyphBounds(font);
  return reading.kind === 'bounds' ? glyphs.map(index => reading.bounds.bounds(index)) : reading.kind;
};

describe('glyph bounds of TrueType programs', () => {
  it('reads each glyph box from its glyf header in ems, and marks glyphs without outlines empty', () => {
    const font = syntheticTrueType({
      name: 'Test',
      glyphs: [{ advance: 1000 }, { advance: 1000, box: [500, -120, 900, 700] }],
      characters: [],
      unitsPerEm: 2000,
    });
    expect(boundsOf(font, [1, 0, 2, -1])).toStrictEqual([[0.25, -0.06, 0.45, 0.35], 'empty', undefined, undefined]);
  });

  it('reads long loca offsets', () => {
    const glyf = glyph(-100, -200, 300, 400);
    const font = program([
      ['head', head(1000, 1)],
      ['maxp', maxp(1)],
      ['loca', u32(0, glyf.length)],
      ['glyf', glyf],
    ]);
    expect(boundsOf(font, [0])).toStrictEqual([[-0.1, -0.2, 0.3, 0.4]]);
  });

  it('does not classify equal loca offsets beyond glyf as an empty glyph', () => {
    const font = program([
      ['head', head(1000, 1)],
      ['maxp', maxp(1)],
      ['loca', u32(0xffffffff, 0xffffffff)],
      ['glyf', []],
    ]);
    expect(boundsOf(font, [0])).toStrictEqual([undefined]);
  });

  it('gives no box for entries the tables do not hold, reversed boxes and boxes larger than 16 ems', () => {
    const glyf = [...glyph(0, 0, 100, 100), ...glyph(100, 100, 0, 0), ...glyph(0, 0, 17_000, 100)];
    const font = program([
      ['head', head(1000, 0)],
      ['maxp', maxp(5)],
      // Short offsets are halved: glyph 3 runs past glyf, and glyph 4 has its offsets reversed.
      ['loca', u16(0, 5, 10, 15, 100, 50)],
      ['glyf', glyf],
    ]);
    expect(boundsOf(font, [0, 1, 2, 3, 4])).toStrictEqual([[0, 0, 0.1, 0.1], undefined, undefined, undefined, undefined]);
  });

  it('reports a program without glyf outlines as absent and damaged tables as unreadable', () => {
    const outlines = [
      ['loca', u16(0)],
      ['glyf', []],
    ] as const;
    const noUnits = program([['head', head(0, 0)], ['maxp', maxp(0)], ...outlines]);
    const shortHead = program([['head', [0, 1]], ['maxp', maxp(0)], ...outlines]);
    const headOnly = program([['head', head(1000, 0)]]);
    expect([boundsOf(headOnly, [0]), boundsOf(noUnits, [0]), boundsOf(shortHead, [0]), boundsOf(Uint8Array.of(1, 2, 3), [0])]).toStrictEqual([
      'absent',
      'unreadable',
      'unreadable',
      'unreadable',
    ]);
  });
});

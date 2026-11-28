import { describe, expect, it } from 'vitest';

import { ParseError } from '../../error/parseError.ts';

import { findTable } from './sfnt.ts';

// Big-endian bytes of unsigned 16-bit and 32-bit integers.
const u16 = (...values: ReadonlyArray<number>): Array<number> => values.flatMap(value => [Math.floor(value / 256) % 256, value % 256]);
const u32 = (...values: ReadonlyArray<number>): Array<number> => values.flatMap(value => u16(Math.floor(value / 65_536), value % 65_536));
const tag = (text: string): Array<number> => Array.from(text, character => character.codePointAt(0) ?? 0);

// A program with the given sfntVersion and one `test` table record of the given length at offset 28, followed by `present` bytes.
const programOf = (version: number, length: number, present: number): Uint8Array =>
  Uint8Array.from([...u32(version), ...u16(1, 0, 0, 0), ...tag('test'), ...u32(0, 28, length), ...Array.from({ length: present }, (_, index) => index + 1)]);

describe('sfnt table directories', () => {
  it.each([
    { label: 'TrueType 1.0', version: 0x00_01_00_00 },
    { label: "Apple's true", version: 0x74_72_75_65 },
    { label: 'OpenType OTTO', version: 0x4f_54_54_4f },
  ])('finds a table of a $label program', ({ version }) => {
    // The OpenType specification's font file chapter: sfntVersion is 0x00010000 for TrueType outlines and 'OTTO' for CFF data, and Apple's specification for TrueType fonts also allows 'true'.
    expect(findTable(programOf(version, 3, 3), 'test')).toStrictEqual(Uint8Array.of(1, 2, 3));
  });

  it('refuses a program of another sfntVersion', () => {
    expect(() => findTable(programOf(0x74_74_63_66, 3, 3), 'test')).toThrow(ParseError);
  });

  it('accepts a table that ends at the end of the program and refuses one a byte longer', () => {
    expect(findTable(programOf(0x00_01_00_00, 3, 3), 'test')).toHaveLength(3);
    expect(() => findTable(programOf(0x00_01_00_00, 4, 3), 'test')).toThrow(ParseError);
  });

  it('gives no table for a tag the directory does not list', () => {
    expect(findTable(programOf(0x00_01_00_00, 3, 3), 'cmap')).toBeUndefined();
  });
});

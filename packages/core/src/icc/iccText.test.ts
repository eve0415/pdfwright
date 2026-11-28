import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { readIccText } from './iccText.ts';

const START = 4;

// The tag placed four bytes into a buffer with four bytes after it, so an offset reported relative to the buffer differs from one relative to the tag.
interface Embedded {
  readonly bytes: Uint8Array;
  readonly end: number;
}

const embedded = (tag: Uint8Array): Embedded => {
  const bytes = new Uint8Array(START + tag.length + 4).fill(0xee);
  bytes.set(tag, START);
  return { bytes, end: START + tag.length };
};

// Reads the tag, or only its first `length` bytes, so that the bytes after the range still belong to the tag.
const read = (tag: Uint8Array, length = tag.length): string => readIccText(embedded(tag).bytes, START, START + length);

// Returns the reason and offset of an InvalidProfileError, and lets any other outcome fail the test.
interface Failure {
  readonly reason: string;
  readonly offset: number;
}

const failure = (tag: Uint8Array, length = tag.length): Failure => {
  try {
    read(tag, length);
  } catch (error) {
    if (error instanceof InvalidProfileError) {
      return { reason: error.reason, offset: error.offset };
    }
    throw error;
  }
  throw new Error('the tag was accepted');
};

// A textDescriptionType whose invariant ASCII part has the given count and bytes, padded to the given length.
const descTag = (count: number, text: ReadonlyArray<number>, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode('desc'));
  new DataView(bytes.buffer).setUint32(8, count);
  bytes.set(text, 12);
  return bytes;
};

interface LocalizedRecord {
  readonly locale: string;
  readonly units: ReadonlyArray<number>;
  readonly length?: number;
  readonly offset?: number;
}

// A multiLocalizedUnicodeType with one record per entry and the strings after the record table, unless a record overrides its length or offset.
const mlucTag = (records: ReadonlyArray<LocalizedRecord>, options: { count?: number; recordSize?: number } = {}): Uint8Array => {
  const tableEnd = 16 + records.length * 12;
  const total = records.reduce((sum, record) => sum + record.units.length * 2, 0);
  const bytes = new Uint8Array(Math.max(28, tableEnd + total));
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('mluc'));
  view.setUint32(8, options.count ?? records.length);
  view.setUint32(12, options.recordSize ?? 12);
  let cursor = tableEnd;
  for (const [index, record] of records.entries()) {
    const at = 16 + index * 12;
    bytes.set(new TextEncoder().encode(record.locale), at);
    view.setUint32(at + 4, record.length ?? record.units.length * 2);
    view.setUint32(at + 8, record.offset ?? cursor);
    for (const [position, unit] of record.units.entries()) {
      view.setUint16(cursor + position * 2, unit);
    }
    cursor += record.units.length * 2;
  }
  return bytes;
};

const units = (text: string): Array<number> => Array.from(text, character => character.codePointAt(0) ?? 0);

describe('icc text tags', () => {
  it('reads the invariant ASCII part of v2 desc and null-terminated text', () => {
    const desc = new Uint8Array(20);
    const view = new DataView(desc.buffer);
    desc.set(new TextEncoder().encode('desc'));
    view.setUint32(8, 5);
    desc.set(new TextEncoder().encode('Press'), 12);
    desc[16] = 0;
    expect(readIccText(desc, 0, desc.length)).toBe('Pres');
    const text = new Uint8Array(14);
    text.set(new TextEncoder().encode('text'));
    text.set(new TextEncoder().encode('Hello'), 8);
    expect(readIccText(text, 0, text.length)).toBe('Hello');
  });

  // ICC.1:2022, 10.15 leaves the choice of record to the reader; this reader takes en-US, then the first other English record, then the first record.
  it.each([
    { name: 'en-US among four records', locales: ['frFR', 'enGB', 'enUS', 'deDE'], expected: 'enUS' },
    { name: 'en-GB when there is no en-US', locales: ['frFR', 'enGB', 'deDE'], expected: 'enGB' },
    { name: 'the first English record of two', locales: ['frFR', 'enGB', 'enAU'], expected: 'enGB' },
    { name: 'the first record when none is English', locales: ['frFR', 'deDE'], expected: 'frFR' },
  ])('prefers $name in a v4 mluc tag', ({ locales, expected }) => {
    expect(read(mlucTag(locales.map(locale => ({ locale, units: units(locale) }))))).toBe(expected);
  });

  it('checks mluc string bounds', () => {
    const tag = mlucTag([{ locale: 'enUS', units: units('Test') }]);
    expect(read(tag)).toBe('Test');
    expect(() => read(mlucTag([{ locale: 'enUS', units: units('Test'), offset: 30 }]))).toThrow(InvalidProfileError);
    expect(failure(mlucTag([{ locale: 'enUS', units: units('Test'), offset: 30 }]))).toStrictEqual({ reason: 'bad-tag-data', offset: START + 16 });
  });

  // Each row uses a tag type whose own length checks would not catch the range, so only the range check can reject it.
  it.each([
    { name: 'a range shorter than a type header', tag: new TextEncoder().encode('XYZ \0\0\0\0\0\0\0\0'), start: START, end: START + 7 },
    { name: 'a negative start', tag: new TextEncoder().encode('text\0\0\0\0Hi\0'), start: -1, end: START + 11 },
    { name: 'an end past the bytes', tag: mlucTag([{ locale: 'enUS', units: units('Hi') }]), start: START, end: START + 37 },
  ])('rejects $name', ({ tag, start, end }) => {
    const { bytes } = embedded(tag);
    expect(() => readIccText(bytes, start, end)).toThrow(expect.objectContaining({ reason: 'bad-tag-data', offset: start }));
  });

  it('rejects a tag of another type', () => {
    const tag = new Uint8Array(20);
    tag.set(new TextEncoder().encode('XYZ '));
    expect(() => read(tag)).toThrow(InvalidProfileError);
    expect(() => read(tag)).toThrow(expect.objectContaining({ reason: 'tag-type-mismatch', offset: START }));
  });

  // ICC.1:2001-04, 6.5.17 Table 68: the ASCII count includes the terminating zero and must fit in the tag.
  it.each([
    { name: 'a 12-byte tag', tag: descTag(1, [], 12), length: 12, offset: START },
    { name: 'a count of 0', tag: descTag(0, [0], 13), length: 13, offset: START + 8 },
    // The terminating zero lies one byte past the range, so only the count check rejects it.
    { name: 'a count past the tag', tag: descTag(3, [65, 66, 0], 15), length: 14, offset: START + 8 },
    { name: 'a last counted byte that is not zero', tag: descTag(2, [65, 66, 0], 16), length: 16, offset: START + 8 },
  ])('rejects a desc tag with $name', ({ tag, length, offset }) => {
    expect(failure(tag, length)).toStrictEqual({ reason: 'bad-tag-data', offset });
  });

  it('reads a desc tag whose count exactly fills it', () => {
    expect(read(descTag(3, [65, 66, 0], 15))).toBe('AB');
    expect(read(descTag(1, [0], 13))).toBe('');
  });

  it('reads an empty text tag and rejects one without its terminating zero', () => {
    // ICC.1:2001-04, 6.5.18 Table 70: the text ends with 00h.
    expect(read(new TextEncoder().encode('text\0\0\0\0\0'))).toBe('');
    expect(failure(new TextEncoder().encode('text\0\0\0\0Hi'))).toStrictEqual({ reason: 'bad-tag-data', offset: START });
  });

  // ICC.1:2022, 10.15 Table 54: records are 12 bytes, lengths count UTF-16BE bytes, and strings lie after the record table.
  it.each([
    { name: 'a count of 0', tag: mlucTag([{ locale: 'enUS', units: units('Hi') }], { count: 0 }), offset: START + 8 },
    { name: 'a record size of 11', tag: mlucTag([{ locale: 'enUS', units: units('Hi') }], { recordSize: 11 }), offset: START + 8 },
    { name: 'a record size of 13', tag: mlucTag([{ locale: 'enUS', units: units('Hi') }], { recordSize: 13 }), offset: START + 8 },
    { name: 'a count past the tag', tag: mlucTag([{ locale: 'enUS', units: units('Hi') }], { count: 2 }), offset: START + 8 },
    { name: 'an odd string length', tag: mlucTag([{ locale: 'enUS', units: units('Hi'), length: 3 }]), offset: START + 16 },
    // The odd length belongs to a record the reader does not choose, so decoding the chosen string cannot reject it.
    {
      name: 'an odd string length in a record it does not choose',
      tag: mlucTag([
        { locale: 'enUS', units: units('Hi') },
        { locale: 'frFR', units: units('Fr'), length: 3 },
      ]),
      offset: START + 28,
    },
    { name: 'a string inside the record table', tag: mlucTag([{ locale: 'enUS', units: units('Hi'), offset: 24 }]), offset: START + 16 },
    { name: 'a lone surrogate', tag: mlucTag([{ locale: 'enUS', units: [0xd8_00] }]), offset: START + 16 },
    { name: 'a length of 27 bytes', tag: mlucTag([{ locale: 'enUS', units: [] }]).subarray(0, 27), offset: START },
  ])('rejects an mluc tag with $name', ({ tag, offset }) => {
    expect(failure(tag)).toStrictEqual({ reason: 'bad-tag-data', offset });
  });

  it('reads an mluc string that starts right after the record table and one of zero length', () => {
    expect(read(mlucTag([{ locale: 'enUS', units: units('Hi'), offset: 28 }]))).toBe('Hi');
    // A single record with an empty string is the shortest mluc tag, 28 bytes.
    expect(read(mlucTag([{ locale: 'enUS', units: [] }]))).toBe('');
  });
});

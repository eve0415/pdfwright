import type { MatchSequence } from './matchFinder.ts';

import { InvalidArgumentError } from '@pdfwright/core';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeCompressedBlock } from './compressBlock.ts';
import { createMatchFinder } from './matchFinder.ts';

const frameWithBlock = (body: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(9 + body.length);
  frame.set([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]);
  const header = (body.length << 3) | 5;
  frame[6] = header & 255;
  frame[7] = (header >>> 8) & 255;
  frame[8] = (header >>> 16) & 255;
  frame.set(body, 9);
  return frame;
};

const manySequences = () => {
  const sequences = Array.from({ length: 128 }, (_, index) => ({ literalLength: index === 0 ? 5000 : 0, matchLength: 4, offset: 4 }));
  const literals = new Uint8Array(5000);
  for (let index = 0; index < literals.length; index++) {
    literals[index] = (index * 37) % 256;
  }
  const input = new Uint8Array(5000 + 128 * 4);
  input.set(literals);
  for (let index = 5000; index < input.length; index++) {
    input[index] = input[index - 4] ?? 0;
  }
  return { sequences, literals, input };
};
const sizeFormat = (body: Uint8Array): number => (body[0] ?? 0) & 12;

const encodeLiteralsOnly = (size: number): Uint8Array => encodeCompressedBlock({ literals: new Uint8Array(size), sequences: [], trailingLiterals: size });

const pseudoRandom = (length: number): Uint8Array => {
  const output = new Uint8Array(length);
  let state = 2_463_534_242;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = state >>> 24;
  }
  return output;
};

/** Builds a parse whose sequences copy at an offset equal to their own literal length, and the content it describes. */
const parseOf = (lengths: ReadonlyArray<{ readonly literalLength: number; readonly matchLength: number }>) => {
  const literals = pseudoRandom(lengths.reduce((sum, { literalLength }) => sum + literalLength, 0));
  const sequences: Array<MatchSequence> = lengths.map(({ literalLength, matchLength }) => ({ literalLength, matchLength, offset: literalLength }));
  const content = new Uint8Array(literals.length + lengths.reduce((sum, { matchLength }) => sum + matchLength, 0));
  let literalPosition = 0;
  let position = 0;
  for (const { literalLength, matchLength, offset } of sequences) {
    content.set(literals.subarray(literalPosition, literalPosition + literalLength), position);
    literalPosition += literalLength;
    position += literalLength;
    for (let index = 0; index < matchLength; index++, position++) {
      content[position] = content[position - offset] ?? 0;
    }
  }
  return { parse: { literals, sequences, trailingLiterals: 0 }, content };
};

describe('predefined-table Zstandard blocks', () => {
  it('encodes repeated text with raw literals and predefined FSE sequences', () => {
    const input = new TextEncoder().encode(`${'abcd'.repeat(400)}--${'WXYZ'.repeat(700)}`);
    const parse = createMatchFinder(input).parseBlock(0, input.length);
    const body = encodeCompressedBlock(parse);
    expect(parse.sequences.length).toBeGreaterThan(1);
    expect(body.length).toBeLessThan(input.length / 4);
    expect(decompress(frameWithBlock(body))).toStrictEqual(input);
  });

  // RFC 8878, 3.1.1.3.2.1.1, Tables 16 and 17: literal lengths from 16 and match lengths from 35 carry extra bits.
  // Literal length codes 32-35 and match length codes 46-52 have probability -1 in the predefined distributions (3.1.1.3.2.2).
  it.each([
    {
      name: 'literal length 16 and 17',
      lengths: [
        { literalLength: 16, matchLength: 3 },
        { literalLength: 17, matchLength: 3 },
      ],
    },
    { name: 'literal length 41 and match length 999', lengths: [{ literalLength: 41, matchLength: 999 }] },
    { name: 'match lengths 35 to 515', lengths: [35, 36, 131, 258, 515].map(matchLength => ({ literalLength: 1, matchLength })) },
    { name: 'literal lengths 8192 to 65536', lengths: [8192, 16_384, 32_768, 65_536].map(literalLength => ({ literalLength, matchLength: 4 })) },
    {
      name: 'literal lengths 16383 and 4096',
      lengths: [
        { literalLength: 16_383, matchLength: 4 },
        { literalLength: 4096, matchLength: 4 },
      ],
    },
    { name: 'literal length 131068', lengths: [{ literalLength: 131_068, matchLength: 4 }] },
    { name: 'match lengths 1027 to 65539', lengths: [1027, 2051, 4099, 8195, 16_387, 32_771, 65_539].map(matchLength => ({ literalLength: 1, matchLength })) },
    { name: 'match length 131071', lengths: [{ literalLength: 1, matchLength: 131_071 }] },
  ])('encodes long literal and match lengths: $name', ({ lengths }) => {
    const { parse, content } = parseOf(lengths);
    expect(decompress(frameWithBlock(encodeCompressedBlock(parse)))).toStrictEqual(content);
  });

  it('encodes a two-byte sequence count and a three-byte raw-literals header', () => {
    const { sequences, literals, input } = manySequences();
    const body = encodeCompressedBlock({ literals, sequences, trailingLiterals: 0 });
    expect(sizeFormat(body)).toBe(12);
    expect(decompress(frameWithBlock(body))).toStrictEqual(input);
  });

  it('writes no symbol compression modes byte for a block without sequences', () => {
    const literals = new TextEncoder().encode('abc');
    const body = encodeCompressedBlock({ literals, sequences: [], trailingLiterals: 3 });
    // RFC 8878, 3.1.1.3.2.1: Number_of_Sequences 0 ends the sequences section.
    expect(body).toStrictEqual(new Uint8Array([3 << 3, ...literals, 0]));
    expect(decompress(frameWithBlock(body))).toStrictEqual(literals);
  });

  // RFC 8878, 3.1.1.3.1.1: Raw_Literals_Block sizes use 5, 12 or 20 bits, chosen by Size_Format in bits 2-3.
  it.each([
    { size: 31, header: [31 << 3] },
    { size: 32, header: [0x04, 0x02] },
    { size: 4095, header: [0xf4, 0xff] },
    { size: 4096, header: [0x0c, 0x00, 0x01] },
  ])('writes a $header.length-byte literals header for $size literals', ({ size, header }) => {
    const literals = pseudoRandom(size);
    const body = encodeCompressedBlock({ literals, sequences: [], trailingLiterals: size });
    expect(body).toStrictEqual(new Uint8Array([...header, ...literals, 0]));
    expect(decompress(frameWithBlock(body))).toStrictEqual(literals);
  });

  it('writes a three-byte literals header up to 1,048,575 literals and refuses more', () => {
    expect(encodeLiteralsOnly(1_048_575).subarray(0, 3)).toStrictEqual(new Uint8Array([0xfc, 0xff, 0xff]));
    expect(() => encodeLiteralsOnly(1_048_576)).toThrow(InvalidArgumentError);
    expect(() => encodeLiteralsOnly(1_048_576)).toThrow(/raw literals exceed/u);
  });

  // RFC 8878, 3.1.1.3.2.1: Number_of_Sequences takes one byte below 128, two below 0x7F00, and otherwise 255 followed by count - 0x7F00.
  it.each([
    { count: 127, bytes: [127] },
    { count: 128, bytes: [0x80, 0x80] },
    { count: 32_511, bytes: [0xfe, 0xff] },
    { count: 32_512, bytes: [0xff, 0x00, 0x00] },
    { count: 32_513, bytes: [0xff, 0x01, 0x00] },
  ])('writes $count sequences as a $bytes.length-byte count', ({ count, bytes }) => {
    const { parse, content } = parseOf([{ literalLength: 4, matchLength: 4 }]);
    const sequences = Array.from({ length: count }, (_, index) => ({ literalLength: index === 0 ? 4 : 0, matchLength: 4, offset: 4 }));
    const body = encodeCompressedBlock({ ...parse, sequences });
    const expected = new Uint8Array(4 + 4 * count);
    for (let index = 0; index < expected.length; index++) {
      expected[index] = content[index % 4] ?? 0;
    }
    // One header byte and four literals precede the count.
    expect(body.subarray(5, 5 + bytes.length)).toStrictEqual(new Uint8Array(bytes));
    expect(body[5 + bytes.length]).toBe(0);
    expect(decompress(frameWithBlock(body))).toStrictEqual(expected);
  });

  // RFC 8878, 3.1.1.3.2.1.1: the largest codes cover literal lengths up to 131,071 and match lengths up to 131,074.
  it.each([
    { name: 'literal length 131,071', sequence: { literalLength: 131_071, matchLength: 4, offset: 1 } },
    { name: 'match length 131,074', sequence: { literalLength: 1, matchLength: 131_074, offset: 1 } },
  ])('encodes the largest $name', ({ sequence }) => {
    expect(() => encodeCompressedBlock({ literals: new Uint8Array(sequence.literalLength), sequences: [sequence], trailingLiterals: 0 })).not.toThrow();
  });

  it.each([
    { name: 'literal length 131,072', sequence: { literalLength: 131_072, matchLength: 4, offset: 1 } },
    { name: 'match length 131,075', sequence: { literalLength: 1, matchLength: 131_075, offset: 1 } },
  ])('refuses $name, which no predefined code covers', ({ sequence }) => {
    const encode = () => encodeCompressedBlock({ literals: new Uint8Array(sequence.literalLength), sequences: [sequence], trailingLiterals: 0 });
    expect(encode).toThrow(InvalidArgumentError);
    expect(encode).toThrow(/exceeds predefined code range/u);
  });
});

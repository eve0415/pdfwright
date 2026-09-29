import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { encodeCompressedBlock } from './compressBlock.ts';
import { buildFseTable } from './fseEncoder.ts';
import { createMatchFinder } from './matchFinder.ts';
import { LITERAL_DISTRIBUTION } from './predefinedTables.ts';

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
  for (let index = 0; index < literals.length; index++) literals[index] = (index * 37) % 256;
  const input = new Uint8Array(5000 + 128 * 4);
  input.set(literals);
  for (let index = 5000; index < input.length; index++) input[index] = input[index - 4] ?? 0;
  return { sequences, literals, input };
};
const sizeFormat = (body: Uint8Array): number => (body[0] ?? 0) & 12;

describe('predefined-table Zstandard blocks', () => {
  it('encodes repeated text with raw literals and predefined FSE sequences', () => {
    const input = new TextEncoder().encode(`${'abcd'.repeat(400)}--${'WXYZ'.repeat(700)}`);
    const parse = createMatchFinder(input).parseBlock(0, input.length);
    const body = encodeCompressedBlock(parse);
    expect(parse.sequences.length).toBeGreaterThan(1);
    expect(body.length).toBeLessThan(input.length / 4);
    expect(decompress(frameWithBlock(body))).toStrictEqual(input);
  });

  it('encodes long literal and match lengths', () => {
    const input = new TextEncoder().encode(`${'a'.repeat(80)}${'different'.repeat(30)}${'a'.repeat(1000)}`);
    const parse = createMatchFinder(input).parseBlock(0, input.length);
    const body = encodeCompressedBlock(parse);
    expect(decompress(frameWithBlock(body))).toStrictEqual(input);
  });

  it('matches the RFC predefined literal table states', () => {
    const table = buildFseTable(LITERAL_DISTRIBUTION, 6);
    expect(table.cells.slice(0, 3)).toStrictEqual([
      { symbol: 0, bits: 4, base: 0 },
      { symbol: 0, bits: 4, base: 16 },
      { symbol: 1, bits: 5, base: 32 },
    ]);
  });

  it('encodes a two-byte sequence count and a three-byte raw-literals header', () => {
    const { sequences, literals, input } = manySequences();
    const body = encodeCompressedBlock({ literals, sequences, trailingLiterals: 0 });
    expect(sizeFormat(body)).toBe(12);
    expect(decompress(frameWithBlock(body))).toStrictEqual(input);
  });
});

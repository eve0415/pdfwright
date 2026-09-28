import type { MatchParse } from './matchFinder.ts';

import { describe, expect, it } from 'vitest';

import { createMatchFinder } from './matchFinder.ts';

const reconstruct = (parse: MatchParse, history: Uint8Array = new Uint8Array()): Uint8Array => {
  const { literals, sequences, trailingLiterals } = parse;
  const output: number[] = [...history];
  let literalPosition = 0;
  for (const sequence of sequences) {
    for (let index = 0; index < sequence.literalLength; index++) output.push(literals[literalPosition++] ?? 0);
    for (let index = 0; index < sequence.matchLength; index++) output.push(output[output.length - sequence.offset] ?? 0);
  }
  for (let index = 0; index < trailingLiterals; index++) output.push(literals[literalPosition++] ?? 0);
  return new Uint8Array(output.slice(history.length));
};

describe('zstandard match finder', () => {
  it('finds four-byte matches and reconstructs a repeated block', () => {
    const input = new TextEncoder().encode('abcdabcdabcd---abcdabcd');
    const parsed = createMatchFinder(input).parseBlock(0, input.length);
    expect(parsed.sequences[0]).toMatchObject({ literalLength: 4, offset: 4, matchLength: 8 });
    expect(reconstruct(parsed)).toStrictEqual(input);
  });

  it('uses previous block history without exceeding the two-megabyte window', () => {
    const input = new Uint8Array(131072 + 128);
    let state = 123456789;
    for (let index = 0; index < 131072; index++) {
      state = (state * 1664525 + 1013904223) % 4294967296;
      input[index] = state % 256;
    }
    input.set(input.subarray(131072 - 128, 131072), 131072);
    const finder = createMatchFinder(input);
    finder.parseBlock(0, 131072);
    const second = finder.parseBlock(131072, input.length);
    expect(second.sequences[0]).toMatchObject({ literalLength: 0, offset: 128, matchLength: 128 });
    expect(reconstruct(second, input.subarray(0, 131072))).toStrictEqual(input.subarray(131072));
  });
});

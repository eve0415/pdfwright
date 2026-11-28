import type { MatchParse } from './matchFinder.ts';

import { InvalidArgumentError } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createMatchFinder } from './matchFinder.ts';

const reconstruct = (parse: MatchParse, history: Uint8Array = new Uint8Array()): Uint8Array => {
  const { literals, sequences, trailingLiterals } = parse;
  const output: Array<number> = [...history];
  let literalPosition = 0;
  for (const sequence of sequences) {
    for (let index = 0; index < sequence.literalLength; index++) {
      output.push(literals[literalPosition++] ?? 0);
    }
    for (let index = 0; index < sequence.matchLength; index++) {
      output.push(output[output.length - sequence.offset] ?? 0);
    }
  }
  for (let index = 0; index < trailingLiterals; index++) {
    output.push(literals[literalPosition++] ?? 0);
  }
  return new Uint8Array(output.slice(history.length));
};

/** Replays consecutive parses into one buffer, each sequence copying from everything decoded before it. */
const reconstructAll = (parses: ReadonlyArray<MatchParse>, length: number): Uint8Array => {
  const output = new Uint8Array(length);
  let position = 0;
  for (const { literals, sequences, trailingLiterals } of parses) {
    let literalPosition = 0;
    for (const { literalLength, matchLength, offset } of sequences) {
      output.set(literals.subarray(literalPosition, literalPosition + literalLength), position);
      literalPosition += literalLength;
      position += literalLength;
      for (let index = 0; index < matchLength; index++, position++) {
        output[position] = output[position - offset] ?? 0;
      }
    }
    output.set(literals.subarray(literalPosition, literalPosition + trailingLiterals), position);
    position += trailingLiterals;
  }
  return output.subarray(0, position);
};

/** Parses the whole input in consecutive blocks of at most 128 KiB. */
const parseAll = (input: Uint8Array, blockSizes: ReadonlyArray<number> = []): Array<MatchParse> => {
  const finder = createMatchFinder(input);
  const parses: Array<MatchParse> = [];
  for (let start = 0, index = 0; start < input.length; index++) {
    const end = Math.min(input.length, start + (blockSizes[index] ?? 131_072));
    parses.push(finder.parseBlock(start, end));
    start = end;
  }
  return parses;
};

const pseudoRandom = (length: number, seed: number, alphabet = 256): Uint8Array => {
  const output = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = (state >>> 24) % alphabet;
  }
  return output;
};

/** Zero filler with one 32-byte pattern written twice, `distance` bytes apart. */
const repeatedPattern = (distance: number): Uint8Array => {
  const pattern = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const input = new Uint8Array(1000 + distance + 32 + 1000);
  input.set(pattern, 1000);
  input.set(pattern, 1000 + distance);
  return input;
};

describe('zstandard match finder', () => {
  it('finds four-byte matches and reconstructs a repeated block', () => {
    const input = new TextEncoder().encode('abcdabcdabcd---abcdabcd');
    const parsed = createMatchFinder(input).parseBlock(0, input.length);
    expect(parsed.sequences[0]).toMatchObject({ literalLength: 4, offset: 4, matchLength: 8 });
    expect(reconstruct(parsed)).toStrictEqual(input);
  });

  it('uses previous block history', () => {
    const input = new Uint8Array(131_072 + 128);
    let state = 123_456_789;
    for (let index = 0; index < 131_072; index++) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      input[index] = state % 256;
    }
    input.set(input.subarray(131_072 - 128, 131_072), 131_072);
    const finder = createMatchFinder(input);
    finder.parseBlock(0, 131_072);
    const second = finder.parseBlock(131_072, input.length);
    expect(second.sequences[0]).toMatchObject({ literalLength: 0, offset: 128, matchLength: 128 });
    expect(reconstruct(second, input.subarray(0, 131_072))).toStrictEqual(input.subarray(131_072));
  });

  // RFC 8878, 3.1.1.1.2: the frame header's window descriptor 0x58 allows 2 MiB, so a match reaches back at most 2,097,151 bytes here.
  it('reuses a pattern 2,097,151 bytes back', () => {
    const input = repeatedPattern(2_097_151);
    const parses = parseAll(input);
    const sequences = parses.flatMap(parse => parse.sequences);
    expect(sequences.filter(sequence => sequence.offset === 2_097_151 && sequence.matchLength >= 32)).toHaveLength(1);
    expect(reconstructAll(parses, input.length)).toStrictEqual(input);
  });

  it('does not reuse a pattern 2,097,152 bytes back', () => {
    const input = repeatedPattern(2_097_152);
    const parses = parseAll(input);
    const offsets = parses.flatMap(parse => parse.sequences.map(sequence => sequence.offset));
    expect(Math.max(...offsets)).toBeLessThanOrEqual(2_097_151);
    expect(reconstructAll(parses, input.length)).toStrictEqual(input);
  });

  it('emits a four-byte match but not three bytes at the block end', () => {
    const input = new TextEncoder().encode('abcdabcd');
    expect(createMatchFinder(input).parseBlock(0, 7)).toStrictEqual({ literals: input.subarray(0, 7), sequences: [], trailingLiterals: 7 });
    expect(createMatchFinder(input).parseBlock(0, 8)).toStrictEqual({
      literals: input.subarray(0, 4),
      sequences: [{ literalLength: 4, matchLength: 4, offset: 4 }],
      trailingLiterals: 0,
    });
  });

  it('finds a match that starts in the last three bytes of the previous block', () => {
    const input = new TextEncoder().encode('0123456ABCDqrsABCDqrs');
    const finder = createMatchFinder(input);
    finder.parseBlock(0, 10);
    expect(finder.parseBlock(10, input.length)).toStrictEqual({
      literals: new TextEncoder().encode('Dqrs'),
      sequences: [{ literalLength: 4, matchLength: 7, offset: 7 }],
      trailingLiterals: 0,
    });
  });

  it('parses an empty block and continues after it', () => {
    const input = new TextEncoder().encode('abcdabcd');
    const finder = createMatchFinder(input);
    expect(finder.parseBlock(0, 0)).toStrictEqual({ literals: new Uint8Array(), sequences: [], trailingLiterals: 0 });
    expect(finder.parseBlock(0, 8).sequences).toStrictEqual([{ literalLength: 4, matchLength: 4, offset: 4 }]);
  });

  it('searches only the 16 most recent candidates for a hash', () => {
    // Seventeen earlier copies of `ABCD` precede the last one; the oldest matches 44 bytes, the 16th most recent 24, and the others fewer.
    const continuation = Uint8Array.from({ length: 40 }, (_, index) => 100 + index);
    const prefixLengths = [40, 20, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const parts: Array<Uint8Array> = [];
    const starts: Array<number> = [];
    let length = 0;
    const push = (part: Uint8Array) => {
      parts.push(part);
      length += part.length;
    };
    for (const [index, prefixLength] of prefixLengths.entries()) {
      starts.push(length);
      push(new Uint8Array([65, 66, 67, 68, ...continuation.subarray(0, prefixLength), 250]));
      push(pseudoRandom(30, index + 1, 64));
    }
    const target = length;
    push(new Uint8Array([65, 66, 67, 68, ...continuation]));
    const input = new Uint8Array(length);
    parts.reduce((offset, part) => {
      input.set(part, offset);
      return offset + part.length;
    }, 0);
    const parse = createMatchFinder(input).parseBlock(0, input.length);
    let position = 0;
    const matchStarts = parse.sequences.map(({ literalLength, matchLength, offset }) => {
      position += literalLength;
      const start = position;
      position += matchLength;
      return { start, matchLength, offset };
    });
    expect(matchStarts.filter(({ start }) => start === target)).toStrictEqual([{ start: target, matchLength: 24, offset: target - (starts[1] ?? 0) }]);
    expect(reconstruct(parse)).toStrictEqual(input);
  });

  it.each([
    { name: 'a first block that does not start at 0', blocks: [[1, 10]] },
    {
      name: 'a block that does not start at the previous end',
      blocks: [
        [0, 10],
        [11, 20],
      ],
    },
    {
      name: 'a block parsed twice',
      blocks: [
        [0, 10],
        [0, 10],
      ],
    },
    {
      name: 'an end before the start',
      blocks: [
        [0, 10],
        [10, 9],
      ],
    },
    {
      name: 'an end past the input',
      blocks: [
        [0, 131_072],
        [131_072, 131_074],
      ],
    },
    { name: 'a 131,073-byte block', blocks: [[0, 131_073]] },
  ])('refuses $name', ({ blocks }) => {
    const finder = createMatchFinder(new Uint8Array(131_073));
    const parse = () => {
      for (const [start = 0, end = 0] of blocks) {
        finder.parseBlock(start, end);
      }
    };
    expect(parse).toThrow(InvalidArgumentError);
    expect(parse).toThrow(/sequential and at most 128 KiB/u);
  });

  it('parses a 131,072-byte block and then the last byte of the input', () => {
    const input = new Uint8Array(131_073);
    const finder = createMatchFinder(input);
    expect(finder.parseBlock(0, 131_072).sequences).toStrictEqual([{ literalLength: 1, matchLength: 131_071, offset: 1 }]);
    expect(finder.parseBlock(131_072, 131_073)).toStrictEqual({ literals: new Uint8Array(1), sequences: [], trailingLiterals: 1 });
  });
});

describe('properties', () => {
  // Short inputs cut into small blocks, so that most draws span several blocks; the tests above cover the 128 KiB block and the 2 MiB window.
  const input = fc
    .tuple(fc.integer({ min: 0, max: 2048 }), fc.integer(), fc.constantFrom(2, 4, 16, 256))
    .map(([length, seed, alphabet]) => pseudoRandom(length, seed, alphabet));
  const blockSizes = fc.array(fc.oneof(fc.integer({ min: 0, max: 64 }), fc.integer({ min: 1, max: 512 })), { maxLength: 8 });

  it('reconstructs every block from bounded sequences', () => {
    fc.assert(
      fc.property(input, blockSizes, (bytes, sizes) => {
        const parses = parseAll(bytes, sizes);
        expect(reconstructAll(parses, bytes.length)).toStrictEqual(bytes);
        for (const { literals, sequences, trailingLiterals } of parses) {
          expect(literals.length).toBe(sequences.reduce((sum, sequence) => sum + sequence.literalLength, trailingLiterals));
          for (const { matchLength, offset } of sequences) {
            expect([matchLength >= 4 && matchLength <= 131_074, offset >= 1 && offset <= 2_097_151]).toStrictEqual([true, true]);
          }
        }
      }),
    );
  });
});

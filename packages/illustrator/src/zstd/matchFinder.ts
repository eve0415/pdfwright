import { InvalidArgumentError } from '@pdfwright/core';

export interface MatchSequence {
  readonly literalLength: number;
  readonly matchLength: number;
  readonly offset: number;
}

export interface MatchParse {
  readonly literals: Uint8Array;
  readonly sequences: readonly MatchSequence[];
  readonly trailingLiterals: number;
}

export interface MatchFinder {
  /** Parses blocks in input order, carrying hash-chain history across calls. */
  parseBlock: (start: number, end: number) => MatchParse;
}

const WINDOW = 2_097_151;
const BLOCK_SIZE = 128 * 1024;
const MAX_CHAIN = 16;
const MIN_MATCH = 4;
const MAX_MATCH = 131_074;

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

/** Greedily finds LZ matches with a 2 MiB window and a fixed 16-entry hash-chain search. */
export const createMatchFinder = (input: Uint8Array): MatchFinder => {
  const head = new Int32Array(65536).fill(-1);
  const previous = new Int32Array(input.length).fill(-1);
  let nextStart = 0;
  const hashAt = (position: number): number => {
    const word = ((input[position] ?? 0) << 24) | ((input[position + 1] ?? 0) << 16) | ((input[position + 2] ?? 0) << 8) | (input[position + 3] ?? 0);
    return (Math.imul(word, 0x9e3779b1) >>> 16) & 0xffff;
  };
  const insert = (position: number): void => {
    if (position + MIN_MATCH > input.length) return;
    const hash = hashAt(position);
    previous[position] = head[hash] ?? -1;
    head[hash] = position;
  };
  const bestMatch = (position: number, end: number) => {
    let candidate = head[hashAt(position)] ?? -1;
    let bestLength = 0;
    let bestOffset = 0;
    let steps = 0;
    const limit = Math.min(end - position, MAX_MATCH);
    while (candidate >= 0 && position - candidate <= WINDOW && steps < MAX_CHAIN) {
      let length = 0;
      while (length < limit && input[candidate + length] === input[position + length]) length++;
      if (length > bestLength) {
        bestLength = length;
        bestOffset = position - candidate;
        if (length === limit) break;
      }
      candidate = previous[candidate] ?? -1;
      steps++;
    }
    return { length: bestLength, offset: bestOffset };
  };
  return {
    parseBlock: (start, end) => {
      if (start !== nextStart || end < start || end > input.length || end - start > BLOCK_SIZE) {
        throw new InvalidArgumentError('match blocks must be sequential and at most 128 KiB');
      }
      const parts: Uint8Array[] = [];
      const sequences: MatchSequence[] = [];
      let position = start;
      let literalStart = start;
      while (position + MIN_MATCH <= end) {
        const match = bestMatch(position, end);
        if (match.length >= MIN_MATCH) {
          parts.push(input.subarray(literalStart, position));
          sequences.push({ literalLength: position - literalStart, matchLength: match.length, offset: match.offset });
          const matchEnd = position + match.length;
          while (position < matchEnd) insert(position++);
          literalStart = position;
        } else {
          insert(position++);
        }
      }
      while (position < end) insert(position++);
      parts.push(input.subarray(literalStart, end));
      nextStart = end;
      return { literals: join(parts), sequences, trailingLiterals: end - literalStart };
    },
  };
};

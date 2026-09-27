import type { BitWriter } from './bitWriter.ts';
import type { Token } from './lz77.ts';

import { buildCodeLengths, canonicalCodes } from './huffmanEncoder.ts';

interface Codebook {
  lengths: number[];
  codes: number[];
}

interface CodedValue {
  symbol: number;
  extra: number;
  extraBits: number;
}

interface ValueTable {
  bases: readonly number[];
  extras: readonly number[];
  offset: number;
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12_289, 16_385, 24_577,
];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_TABLE: ValueTable = { bases: LENGTH_BASE, extras: LENGTH_EXTRA, offset: 257 };
const DISTANCE_TABLE: ValueTable = { bases: DISTANCE_BASE, extras: DISTANCE_EXTRA, offset: 0 };

const encodeValue = (value: number, table: ValueTable): CodedValue => {
  for (let index = table.bases.length - 1; index >= 0; index--) {
    const base = table.bases[index] ?? 0;
    if (value >= base) return { symbol: index + table.offset, extra: value - base, extraBits: table.extras[index] ?? 0 };
  }
  throw new RangeError('invalid length or distance');
};

const makeCodebook = (lengths: number[]): Codebook => ({ lengths, codes: canonicalCodes(lengths) });

const fixedCodebooks = (): [Codebook, Codebook] => {
  // RFC 1951, 3.2.6 gives the fixed literal widths and five-bit distance codes.
  const literal = Array.from({ length: 288 }, (_, symbol) => {
    if (symbol < 144) return 8;
    if (symbol < 256) return 9;
    if (symbol < 280) return 7;
    return 8;
  });
  return [makeCodebook(literal), makeCodebook(Array.from({ length: 32 }, () => 5))];
};

const FIXED = fixedCodebooks();

const runLengthCodes = (lengths: readonly number[]): CodedValue[] => {
  // RFC 1951, 3.2.7 defines repeat codes 16, 17 and 18 for code-length sequences.
  const runs: CodedValue[] = [];
  let position = 0;
  while (position < lengths.length) {
    const value = lengths[position] ?? 0;
    let remaining = 1;
    while (position + remaining < lengths.length && lengths[position + remaining] === value) remaining++;
    position += remaining;
    if (value === 0) {
      while (remaining >= 11) {
        const count = Math.min(remaining, 138);
        runs.push({ symbol: 18, extra: count - 11, extraBits: 7 });
        remaining -= count;
      }
      while (remaining >= 3) {
        const count = Math.min(remaining, 10);
        runs.push({ symbol: 17, extra: count - 3, extraBits: 3 });
        remaining -= count;
      }
      while (remaining > 0) {
        runs.push({ symbol: 0, extra: 0, extraBits: 0 });
        remaining--;
      }
    } else {
      runs.push({ symbol: value, extra: 0, extraBits: 0 });
      remaining--;
      while (remaining >= 3) {
        const count = Math.min(remaining, 6);
        runs.push({ symbol: 16, extra: count - 3, extraBits: 2 });
        remaining -= count;
      }
      while (remaining > 0) {
        runs.push({ symbol: value, extra: 0, extraBits: 0 });
        remaining--;
      }
    }
  }
  return runs;
};

const frequencies = (tokens: readonly Token[]): [number[], number[]] => {
  const literal = Array.from({ length: 286 }, () => 0);
  const distance = Array.from({ length: 30 }, () => 0);
  literal[256] = 1;
  for (const token of tokens) {
    if (token.kind === 'literal') literal[token.byte] = (literal[token.byte] ?? 0) + 1;
    else {
      const length = encodeValue(token.length, LENGTH_TABLE);
      const backward = encodeValue(token.distance, DISTANCE_TABLE);
      literal[length.symbol] = (literal[length.symbol] ?? 0) + 1;
      distance[backward.symbol] = (distance[backward.symbol] ?? 0) + 1;
    }
  }
  if (!tokens.some(token => token.kind === 'match')) distance[0] = 1;
  return [literal, distance];
};

const tokenBitCost = (tokens: readonly Token[], literal: Codebook, distance: Codebook): number => {
  let bits = literal.lengths[256] ?? 0;
  for (const token of tokens) {
    if (token.kind === 'literal') bits += literal.lengths[token.byte] ?? 0;
    else {
      const length = encodeValue(token.length, LENGTH_TABLE);
      const backward = encodeValue(token.distance, DISTANCE_TABLE);
      bits += (literal.lengths[length.symbol] ?? 0) + length.extraBits + (distance.lengths[backward.symbol] ?? 0) + backward.extraBits;
    }
  }
  return bits;
};

const writeSymbol = (writer: BitWriter, codes: Codebook, symbol: number): void => {
  writer.writeBits(codes.codes[symbol] ?? 0, codes.lengths[symbol] ?? 0);
};

const writeTokens = (writer: BitWriter, tokens: readonly Token[], books: readonly [Codebook, Codebook]): void => {
  for (const token of tokens) {
    if (token.kind === 'literal') writeSymbol(writer, books[0], token.byte);
    else {
      const length = encodeValue(token.length, LENGTH_TABLE);
      const backward = encodeValue(token.distance, DISTANCE_TABLE);
      writeSymbol(writer, books[0], length.symbol);
      writer.writeBits(length.extra, length.extraBits);
      writeSymbol(writer, books[1], backward.symbol);
      writer.writeBits(backward.extra, backward.extraBits);
    }
  }
  writeSymbol(writer, books[0], 256);
};

export const writeCompressedBlock = (writer: BitWriter, tokens: readonly Token[], final: boolean): void => {
  const counts = frequencies(tokens);
  const literalLengths = buildCodeLengths(counts[0], 15);
  const distanceLengths = buildCodeLengths(counts[1], 15);
  let literalCount = literalLengths.length;
  while (literalCount > 257 && literalLengths[literalCount - 1] === 0) literalCount--;
  let distanceCount = distanceLengths.length;
  while (distanceCount > 1 && distanceLengths[distanceCount - 1] === 0) distanceCount--;
  const books: [Codebook, Codebook] = [makeCodebook(literalLengths), makeCodebook(distanceLengths)];
  const runs = runLengthCodes([...literalLengths.slice(0, literalCount), ...distanceLengths.slice(0, distanceCount)]);
  const codeFrequencies = Array.from({ length: 19 }, () => 0);
  for (const run of runs) codeFrequencies[run.symbol] = (codeFrequencies[run.symbol] ?? 0) + 1;
  const codeLengths = buildCodeLengths(codeFrequencies, 7);
  const codeBook = makeCodebook(codeLengths);
  let codeCount = CODE_ORDER.length;
  while (codeCount > 4 && codeLengths[CODE_ORDER[codeCount - 1] ?? 0] === 0) codeCount--;
  let dynamicBits = 3 + 5 + 5 + 4 + codeCount * 3 + tokenBitCost(tokens, books[0], books[1]);
  for (const run of runs) dynamicBits += (codeLengths[run.symbol] ?? 0) + run.extraBits;
  const fixedBits = 3 + tokenBitCost(tokens, FIXED[0], FIXED[1]);
  if (fixedBits <= dynamicBits) {
    writer.writeBits((final ? 1 : 0) | 2, 3);
    writeTokens(writer, tokens, FIXED);
    return;
  }
  writer.writeBits((final ? 1 : 0) | 4, 3);
  writer.writeBits(literalCount - 257, 5);
  writer.writeBits(distanceCount - 1, 5);
  writer.writeBits(codeCount - 4, 4);
  for (let index = 0; index < codeCount; index++) writer.writeBits(codeLengths[CODE_ORDER[index] ?? 0] ?? 0, 3);
  for (const run of runs) {
    writeSymbol(writer, codeBook, run.symbol);
    writer.writeBits(run.extra, run.extraBits);
  }
  writeTokens(writer, tokens, books);
};

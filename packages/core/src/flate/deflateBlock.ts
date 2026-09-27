import type { BitWriter } from './bitWriter.ts';
import type { TokenList } from './lz77.ts';

import { buildCodeLengths, canonicalCodes } from './huffmanEncoder.ts';
import { CODE_LENGTH_ORDER, DISTANCE_EXTRA, FIXED_DISTANCE_LENGTHS, FIXED_LITERAL_LENGTHS, LENGTH_EXTRA } from './tables.ts';

interface Codebook {
  lengths: readonly number[];
  codes: readonly number[];
}

interface CodedValue {
  symbol: number;
  extra: number;
  extraBits: number;
}

const makeCodebook = (lengths: readonly number[]): Codebook => ({ lengths, codes: canonicalCodes(lengths) });

const FIXED: [Codebook, Codebook] = [makeCodebook(FIXED_LITERAL_LENGTHS), makeCodebook(FIXED_DISTANCE_LENGTHS)];

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

// Token layout: see matchToken in lz77.ts.
const frequencies = (tokens: TokenList): [number[], number[]] => {
  const literal = Array.from({ length: 286 }, () => 0);
  const distance = Array.from({ length: 30 }, () => 0);
  literal[256] = 1;
  let matches = false;
  for (let index = 0; index < tokens.count; index++) {
    const token = tokens.words[index] ?? 0;
    const symbol = token & 511;
    literal[symbol] = (literal[symbol] ?? 0) + 1;
    if (symbol > 256) {
      const distanceSymbol = (token >>> 9) & 31;
      distance[distanceSymbol] = (distance[distanceSymbol] ?? 0) + 1;
      matches = true;
    }
  }
  if (!matches) distance[0] = 1;
  return [literal, distance];
};

const tokenBitCost = (tokens: TokenList, literal: Codebook, distance: Codebook): number => {
  let bits = literal.lengths[256] ?? 0;
  for (let index = 0; index < tokens.count; index++) {
    const token = tokens.words[index] ?? 0;
    const symbol = token & 511;
    bits += literal.lengths[symbol] ?? 0;
    if (symbol > 256) {
      const distanceSymbol = (token >>> 9) & 31;
      bits += (LENGTH_EXTRA[symbol - 257] ?? 0) + (distance.lengths[distanceSymbol] ?? 0) + (DISTANCE_EXTRA[distanceSymbol] ?? 0);
    }
  }
  return bits;
};

const writeSymbol = (writer: BitWriter, codes: Codebook, symbol: number): void => {
  writer.writeBits(codes.codes[symbol] ?? 0, codes.lengths[symbol] ?? 0);
};

const writeTokens = (writer: BitWriter, tokens: TokenList, books: readonly [Codebook, Codebook]): void => {
  for (let index = 0; index < tokens.count; index++) {
    const token = tokens.words[index] ?? 0;
    const symbol = token & 511;
    writeSymbol(writer, books[0], symbol);
    if (symbol > 256) {
      const distanceSymbol = (token >>> 9) & 31;
      writer.writeBits((token >>> 14) & 31, LENGTH_EXTRA[symbol - 257] ?? 0);
      writeSymbol(writer, books[1], distanceSymbol);
      writer.writeBits(token >>> 19, DISTANCE_EXTRA[distanceSymbol] ?? 0);
    }
  }
  writeSymbol(writer, books[0], 256);
};

export const writeCompressedBlock = (writer: BitWriter, tokens: TokenList, final: boolean): void => {
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
  let codeCount = CODE_LENGTH_ORDER.length;
  while (codeCount > 4 && codeLengths[CODE_LENGTH_ORDER[codeCount - 1] ?? 0] === 0) codeCount--;
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
  for (let index = 0; index < codeCount; index++) writer.writeBits(codeLengths[CODE_LENGTH_ORDER[index] ?? 0] ?? 0, 3);
  for (const run of runs) {
    writeSymbol(writer, codeBook, run.symbol);
    writer.writeBits(run.extra, run.extraBits);
  }
  writeTokens(writer, tokens, books);
};

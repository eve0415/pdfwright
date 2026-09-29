import type { MatchParse } from './matchFinder.ts';

import { InvalidArgumentError } from '@pdfwright/core';

import { createBackwardBitWriter } from './backwardBitWriter.ts';
import { buildFseTable } from './fseEncoder.ts';
import { LITERAL_BASE, LITERAL_BITS, LITERAL_DISTRIBUTION, MATCH_BASE, MATCH_BITS, MATCH_DISTRIBUTION, OFFSET_DISTRIBUTION } from './predefinedTables.ts';

interface Code {
  readonly symbol: number;
  readonly extra: number;
  readonly bits: number;
}

interface SequenceCodes {
  readonly literal: Code;
  readonly match: Code;
  readonly offset: Code;
}

const LITERAL_TABLE = buildFseTable(LITERAL_DISTRIBUTION, 6);
const MATCH_TABLE = buildFseTable(MATCH_DISTRIBUTION, 6);
const OFFSET_TABLE = buildFseTable(OFFSET_DISTRIBUTION, 5);

const lengthCode = (length: number, bases: readonly number[], bits: readonly number[]): Code => {
  for (let symbol = 0; symbol < bases.length; symbol++) {
    const base = bases[symbol] ?? 0;
    const extraBits = bits[symbol] ?? 0;
    if (length >= base && length < base + 2 ** extraBits) return { symbol, extra: length - base, bits: extraBits };
  }
  throw new InvalidArgumentError('sequence length exceeds predefined code range');
};

const sequenceCodes = (parse: MatchParse): SequenceCodes[] =>
  parse.sequences.map(sequence => {
    // RFC 8878, 3.1.1.3.2.1.1: new offsets use Offset_Value = offset + 3, above the repeat-code range.
    const offsetValue = sequence.offset + 3;
    const symbol = Math.floor(Math.log2(offsetValue));
    return {
      literal: lengthCode(sequence.literalLength, LITERAL_BASE, LITERAL_BITS),
      match: lengthCode(sequence.matchLength, MATCH_BASE, MATCH_BITS),
      offset: { symbol, extra: offsetValue - 2 ** symbol, bits: symbol },
    };
  });

const sequenceBits = (codes: readonly SequenceCodes[]): Uint8Array => {
  const last = codes.at(-1);
  if (last === undefined) return new Uint8Array();
  const writer = createBackwardBitWriter();
  let literalState = LITERAL_TABLE.initialState(last.literal.symbol);
  let matchState = MATCH_TABLE.initialState(last.match.symbol);
  let offsetState = OFFSET_TABLE.initialState(last.offset.symbol);
  for (let index = codes.length - 1; index >= 0; index--) {
    const code = codes[index];
    if (code === undefined) throw new InvalidArgumentError('sequence code is missing');
    // RFC 8878, 3.1.1.3.2.1.2: decode reads offset, match and literal extra bits, so encode emits their reverse order.
    writer.write(code.literal.extra, code.literal.bits);
    writer.write(code.match.extra, code.match.bits);
    writer.write(code.offset.extra, code.offset.bits);
    const previous = codes[index - 1];
    if (previous !== undefined) {
      // Decoder state updates are read LL, ML, OF; the backward writer emits OF, ML, LL.
      const offset = OFFSET_TABLE.invert(previous.offset.symbol, offsetState);
      writer.write(offset.value, offset.bits);
      offsetState = offset.state;
      const match = MATCH_TABLE.invert(previous.match.symbol, matchState);
      writer.write(match.value, match.bits);
      matchState = match.state;
      const literal = LITERAL_TABLE.invert(previous.literal.symbol, literalState);
      writer.write(literal.value, literal.bits);
      literalState = literal.state;
    }
  }
  writer.write(matchState, MATCH_TABLE.accuracy);
  writer.write(offsetState, OFFSET_TABLE.accuracy);
  writer.write(literalState, LITERAL_TABLE.accuracy);
  return writer.finish();
};

const literalHeader = (size: number): Uint8Array => {
  // RFC 8878, 3.1.1.3.1.1: Raw_Literals_Block has one-, two- or three-byte regenerated-size headers.
  if (size <= 31) return Uint8Array.of(size << 3);
  if (size <= 4095) {
    const value = (size << 4) | 4;
    return Uint8Array.of(value & 255, (value >>> 8) & 255);
  }
  if (size <= 1_048_575) {
    const value = (size << 4) | 12;
    return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255);
  }
  throw new InvalidArgumentError('raw literals exceed a Zstandard block');
};

const sequenceCount = (count: number): Uint8Array => {
  // RFC 8878, 3.1.1.3.2.1: Number_of_Sequences uses one, two or three bytes.
  if (count < 128) return Uint8Array.of(count);
  if (count < 0x7f00) return Uint8Array.of(128 + (count >>> 8), count & 255);
  const value = count - 0x7f00;
  return Uint8Array.of(255, value & 255, (value >>> 8) & 255);
};

/** Encodes one compressed block with raw literals and all three predefined FSE sequence tables. */
export const encodeCompressedBlock = (parse: MatchParse): Uint8Array => {
  const codes = sequenceCodes(parse);
  const bits = sequenceBits(codes);
  const literals = literalHeader(parse.literals.length);
  const count = sequenceCount(codes.length);
  const size = literals.length + parse.literals.length + count.length + (codes.length === 0 ? 0 : 1 + bits.length);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of [literals, parse.literals, count]) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  if (codes.length > 0) {
    // RFC 8878, 3.1.1.3.2.1, Table 14: modes byte 0 means Predefined_Mode for LL, OF and ML.
    output[offset++] = 0;
    output.set(bits, offset);
  }
  return output;
};

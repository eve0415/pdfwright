import type { BitReader } from './bitReader.ts';

import { ParseError } from '../error/parseError.ts';

const reverseBits = (code: number, length: number): number => {
  let reversed = 0;
  let remaining = code;
  for (let bit = 0; bit < length; bit++) {
    reversed = (reversed << 1) | (remaining & 1);
    remaining >>>= 1;
  }
  return reversed;
};

export class Huffman {
  private readonly symbols: Int16Array;
  private readonly lengths: Uint8Array;
  private readonly maxBits: number;

  constructor(codeLengths: readonly number[], offset: number) {
    // RFC 1951, 3.2.2 assigns canonical codes by length and symbol order.
    const counts = new Uint16Array(16);
    let maxBits = 0;
    for (const length of codeLengths) {
      if (length < 0 || length > 15) throw new ParseError('invalid Huffman code length', offset);
      if (length > 0) {
        counts[length] = (counts[length] ?? 0) + 1;
        maxBits = Math.max(maxBits, length);
      }
    }
    let space = 1;
    for (let bits = 1; bits <= 15; bits++) {
      space = space * 2 - (counts[bits] ?? 0);
      if (space < 0) throw new ParseError('oversubscribed Huffman tree', offset);
    }
    this.maxBits = maxBits;
    this.symbols = new Int16Array(1 << maxBits);
    this.lengths = new Uint8Array(1 << maxBits);
    const nextCodes = new Uint16Array(16);
    let code = 0;
    for (let bits = 1; bits <= 15; bits++) {
      code = (code + (counts[bits - 1] ?? 0)) << 1;
      nextCodes[bits] = code;
    }
    for (let symbol = 0; symbol < codeLengths.length; symbol++) {
      const length = codeLengths[symbol] ?? 0;
      if (length === 0) continue;
      const reversed = reverseBits(nextCodes[length] ?? 0, length);
      nextCodes[length] = (nextCodes[length] ?? 0) + 1;
      for (let index = reversed; index < this.symbols.length; index += 1 << length) {
        this.symbols[index] = symbol;
        this.lengths[index] = length;
      }
    }
  }

  read(reader: BitReader): number {
    const available = Math.min(this.maxBits, reader.availableBits);
    if (available === 0) throw new ParseError('truncated Huffman code', Math.ceil(reader.bitPosition / 8));
    const index = reader.peekBits(available);
    const length = this.lengths[index] ?? 0;
    if (length === 0) throw new ParseError('invalid Huffman code', Math.ceil(reader.bitPosition / 8));
    if (length > available) throw new ParseError('truncated Huffman code', Math.ceil(reader.bitPosition / 8));
    reader.skipBits(length);
    return this.symbols[index] ?? 0;
  }
}

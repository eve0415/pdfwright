import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BitReader } from './bitReader.ts';
import { BitWriter } from './bitWriter.ts';
import { Huffman } from './huffman.ts';
import { buildCodeLengths, canonicalCodes } from './huffmanEncoder.ts';

const fibonacci = (count: number): Array<number> => {
  const values = [1, 1];
  while (values.length < count) {
    values.push((values.at(-1) ?? 0) + (values.at(-2) ?? 0));
  }
  return values;
};

const kraftSum = (lengths: ReadonlyArray<number>, maxBits: number): number =>
  lengths.reduce((sum, length) => sum + (length === 0 ? 0 : 2 ** (maxBits - length)), 0);

// Pairs of symbols where the less frequent one has the shorter code, which an optimal prefix code never has.
const inversions = (frequencies: ReadonlyArray<number>, lengths: ReadonlyArray<number>): Array<[number, number]> => {
  const found: Array<[number, number]> = [];
  for (const [low, lowFrequency] of frequencies.entries()) {
    for (const [high, highFrequency] of frequencies.entries()) {
      if (lowFrequency > 0 && lowFrequency < highFrequency && (lengths[low] ?? 0) < (lengths[high] ?? 0)) {
        found.push([low, high]);
      }
    }
  }
  return found;
};

describe('bounded Huffman code lengths', () => {
  it('limits pathological Fibonacci frequencies to fifteen bits', () => {
    const lengths = buildCodeLengths(fibonacci(29), 15);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(15);
    const used = lengths.filter(length => length > 0);
    expect(used).toHaveLength(29);
    expect(used.reduce((sum, length) => sum + 2 ** (15 - length), 0)).toBe(2 ** 15);
  });

  it('keeps longer codes on less frequent symbols after limiting Fibonacci frequencies', () => {
    const frequencies = fibonacci(29);
    expect(inversions(frequencies, buildCodeLengths(frequencies, 15))).toStrictEqual([]);
  });

  it.each([
    ['no symbols', [], []],
    ['no used symbols', [0, 0], [0, 0]],
    ['one used symbol', [0, 5, 0], [0, 1, 0]],
    ['two used symbols of different frequency', [3, 0, 7], [1, 0, 1]],
    ['three used symbols', [1, 1, 2], [2, 2, 1]],
  ])('gives %s the lengths of a complete code', (_, frequencies, expected) => {
    expect(buildCodeLengths(frequencies, 15)).toStrictEqual(expected);
  });
});

describe('canonical Huffman codes', () => {
  it('assigns the codes of the RFC 1951, 3.2.2 example, bit-reversed for least-significant-bit-first packing', () => {
    // RFC 1951, 3.2.2: lengths (3, 3, 3, 3, 3, 2, 4, 4) give the codes 010, 011, 100, 101, 110, 00, 1110 and 1111, written most-significant bit first.
    expect(canonicalCodes([3, 3, 3, 3, 3, 2, 4, 4])).toStrictEqual([0b010, 0b110, 0b001, 0b101, 0b011, 0b00, 0b0111, 0b1111]);
  });
});

describe('properties', () => {
  // The literal/length alphabet has 286 symbols and a 15-bit limit; the code-length alphabet has 19 and a 7-bit limit (RFC 1951, 3.2.7).
  // Frequencies that are powers of two make an unbounded Huffman tree deeper than the limit, so the limiting step runs too.
  const frequency = fc.oneof(
    fc.nat({ max: 100_000 }),
    fc.integer({ min: 0, max: 40 }).map(exponent => 2 ** exponent),
  );
  const alphabet = fc.oneof(
    fc.tuple(fc.array(frequency, { minLength: 1, maxLength: 286, size: 'max' }), fc.constant(15)),
    fc.tuple(fc.array(frequency, { minLength: 1, maxLength: 19, size: 'max' }), fc.constant(7)),
  );

  it('gives used symbols lengths within the limit that form a complete code, longer for rarer symbols', () => {
    fc.assert(
      fc.property(alphabet, ([frequencies, maxBits]) => {
        const lengths = buildCodeLengths(frequencies, maxBits);
        const used = frequencies.filter(frequency => frequency > 0).length;
        expect({
          zeros: lengths.map((length, symbol) => (length === 0) === ((frequencies[symbol] ?? 0) === 0)),
          withinLimit: lengths.every(length => length <= maxBits),
          kraft: kraftSum(lengths, maxBits),
          inversions: inversions(frequencies, lengths),
        }).toStrictEqual({
          zeros: frequencies.map(() => true),
          withinLimit: true,
          kraft: used === 0 ? 0 : used === 1 ? 2 ** (maxBits - 1) : 2 ** maxBits,
          inversions: [],
        });
      }),
    );
  });

  it('writes symbols that the decoder reads back through the same code lengths', () => {
    const coded = fc.array(fc.nat({ max: 100_000 }), { minLength: 1, maxLength: 286, size: 'max' }).chain(frequencies => {
      const used = frequencies.flatMap((frequency, symbol) => (frequency > 0 ? [symbol] : []));
      return fc.tuple(fc.constant(frequencies), used.length === 0 ? fc.constant([]) : fc.array(fc.constantFrom(...used), { maxLength: 200, size: 'max' }));
    });
    fc.assert(
      fc.property(coded, ([frequencies, symbols]) => {
        const lengths = buildCodeLengths(frequencies, 15);
        const codes = canonicalCodes(lengths);
        const writer = new BitWriter();
        for (const symbol of symbols) {
          writer.writeBits(codes[symbol] ?? 0, lengths[symbol] ?? 0);
        }
        const reader = new BitReader(writer.finish());
        const tree = new Huffman(lengths, 0);
        expect(symbols.map(() => tree.read(reader))).toStrictEqual(symbols);
      }),
    );
  });
});

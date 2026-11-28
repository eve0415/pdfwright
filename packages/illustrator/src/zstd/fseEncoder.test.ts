import { InvalidArgumentError } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildFseTable } from './fseEncoder.ts';
import { LITERAL_DISTRIBUTION, MATCH_DISTRIBUTION, OFFSET_DISTRIBUTION } from './predefinedTables.ts';

// RFC 8878, Appendix A.1-A.3: the predefined decoding tables, one column per array, indexed by state.
const LITERAL_SYMBOLS = [
  0, 0, 1, 3, 4, 6, 7, 9, 10, 12, 14, 16, 18, 19, 21, 22, 24, 25, 26, 27, 29, 31, 0, 1, 2, 4, 5, 7, 8, 10, 11, 13, 16, 17, 19, 20, 22, 23, 25, 25, 26, 28, 30,
  0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 15, 17, 18, 20, 21, 23, 24, 35, 34, 33, 32,
];
const LITERAL_BITS = [
  4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 4, 4, 5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 5, 5, 4, 4, 5, 6, 6, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6,
];
const LITERAL_BASES = [
  0, 16, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 32, 0, 0, 32, 0, 32, 0, 32, 0, 0, 32, 0, 32, 0, 32, 0, 0, 16, 32, 0, 0, 48, 16, 32, 32,
  32, 32, 32, 32, 32, 32, 0, 32, 32, 32, 32, 32, 32, 0, 0, 0, 0,
];
const MATCH_SYMBOLS = [
  0, 1, 2, 3, 5, 6, 8, 10, 13, 16, 19, 22, 25, 28, 31, 33, 35, 37, 39, 41, 43, 45, 1, 2, 3, 4, 6, 7, 9, 12, 15, 18, 21, 24, 27, 30, 32, 34, 36, 38, 40, 42, 44,
  1, 1, 2, 4, 5, 7, 8, 11, 14, 17, 20, 23, 26, 29, 52, 51, 50, 49, 48, 47, 46,
];
const MATCH_BITS = [
  6, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
];
const MATCH_BASES = [
  0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 32, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 48, 16, 32, 32, 32,
  32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const OFFSET_SYMBOLS = [0, 6, 9, 15, 21, 3, 7, 12, 18, 23, 5, 8, 14, 20, 2, 7, 11, 17, 22, 4, 8, 13, 19, 1, 6, 10, 16, 28, 27, 26, 25, 24];
const OFFSET_BITS = [5, 4, 5, 5, 5, 5, 4, 5, 5, 5, 5, 4, 5, 5, 5, 4, 5, 5, 5, 5, 4, 5, 5, 5, 4, 5, 5, 5, 5, 5, 5, 5];
const OFFSET_BASES = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0];

const cells = (symbols: ReadonlyArray<number>, bits: ReadonlyArray<number>, bases: ReadonlyArray<number>) =>
  symbols.map((symbol, state) => ({ symbol, bits: bits[state], base: bases[state] }));

const TABLES = [
  { name: 'literal length', distribution: LITERAL_DISTRIBUTION, accuracy: 6, cells: cells(LITERAL_SYMBOLS, LITERAL_BITS, LITERAL_BASES) },
  { name: 'match length', distribution: MATCH_DISTRIBUTION, accuracy: 6, cells: cells(MATCH_SYMBOLS, MATCH_BITS, MATCH_BASES) },
  { name: 'offset', distribution: OFFSET_DISTRIBUTION, accuracy: 5, cells: cells(OFFSET_SYMBOLS, OFFSET_BITS, OFFSET_BASES) },
] as const;

describe('predefined FSE tables', () => {
  it.each(TABLES)('builds the RFC $name decoding table', ({ distribution, accuracy, cells: expected }) => {
    expect(buildFseTable(distribution, accuracy).cells).toStrictEqual(expected);
  });

  it('refuses the initial state of a symbol the table lacks', () => {
    const table = buildFseTable(LITERAL_DISTRIBUTION, 6);
    expect(table.initialState(35)).toBe(60);
    expect(() => table.initialState(36)).toThrow(InvalidArgumentError);
    expect(() => table.initialState(36)).toThrow(/symbol absent/u);
  });

  it('refuses a transition to a state outside the table', () => {
    const table = buildFseTable(LITERAL_DISTRIBUTION, 6);
    // Cells 0, 1, 22 and 43 hold symbol 0 and cover the states from their bases.
    expect(table.invert(0, 63)).toStrictEqual({ state: 43, bits: 4, value: 15 });
    expect(() => table.invert(0, 64)).toThrow(InvalidArgumentError);
    expect(() => table.invert(0, 64)).toThrow(/transition is unavailable/u);
    expect(() => table.invert(36, 0)).toThrow(/transition is unavailable/u);
  });

  // RFC 8878, 4.1.1: the probabilities, with each -1 counting as one cell, sum to the table size 2 ** accuracy.
  it.each([
    { distribution: [1, 1, 1], accuracy: 2 },
    { distribution: [2, 2, 1], accuracy: 2 },
    { distribution: [1, 1, -1], accuracy: 2 },
  ])('refuses distribution $distribution for a table of size 2 ** $accuracy', ({ distribution, accuracy }) => {
    expect(() => buildFseTable(distribution, accuracy)).toThrow(InvalidArgumentError);
    expect(() => buildFseTable(distribution, accuracy)).toThrow(/invalid predefined FSE distribution/u);
  });

  it.each([
    { distribution: [1, 1, 1, 1], accuracy: 2 },
    { distribution: [2, 1, -1], accuracy: 2 },
  ])('accepts distribution $distribution for a table of size 2 ** $accuracy', ({ distribution, accuracy }) => {
    expect(
      buildFseTable(distribution, accuracy)
        .cells.map(cell => cell.symbol)
        .toSorted((left, right) => left - right),
    ).toStrictEqual(distribution.flatMap((probability, symbol) => Array.from({ length: probability === -1 ? 1 : probability }, () => symbol)));
  });
});

describe('properties', () => {
  // RFC 8878, 4.1: a decoder emits its state's symbol, then moves to Baseline plus Number_of_Bits read from the stream.
  it.each(TABLES)('decodes with the RFC $name table what initialState and invert encode', ({ distribution, accuracy, cells: rfcCells }) => {
    const table = buildFseTable(distribution, accuracy);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: distribution.length - 1 }), { minLength: 1, maxLength: 200 }), symbols => {
        let state = table.initialState(symbols.at(-1) ?? 0);
        const transitions: Array<{ readonly bits: number; readonly value: number }> = [];
        for (let index = symbols.length - 2; index >= 0; index--) {
          const step = table.invert(symbols[index] ?? 0, state);
          transitions.push({ bits: step.bits, value: step.value });
          state = step.state;
        }
        const decoded = [rfcCells[state]?.symbol];
        for (const { bits, value } of transitions.toReversed()) {
          const cell = rfcCells[state];
          expect(bits).toBe(cell?.bits);
          expect(value).toBeLessThan(2 ** bits);
          state = (cell?.base ?? 0) + value;
          decoded.push(rfcCells[state]?.symbol);
        }
        expect(decoded).toStrictEqual(symbols);
      }),
    );
  });
});

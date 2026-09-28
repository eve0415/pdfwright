import { InvalidArgumentError } from '@pdfwright/core';

export interface FseCell {
  readonly symbol: number;
  readonly bits: number;
  readonly base: number;
}

export interface FseTable {
  readonly accuracy: number;
  readonly cells: readonly FseCell[];
  initialState: (symbol: number) => number;
  invert: (symbol: number, nextState: number) => { readonly state: number; readonly bits: number; readonly value: number };
}

/** Builds the RFC 8878, 4.1.1 decoding table and inverts its transitions for encoding. */
export const buildFseTable = (distribution: readonly number[], accuracy: number): FseTable => {
  const size = 2 ** accuracy;
  const symbols = new Int16Array(size).fill(-1);
  const next = new Int16Array(distribution.length);
  let high = size - 1;
  for (const [symbol, probability] of distribution.entries()) {
    if (probability === -1) {
      symbols[high--] = symbol;
      next[symbol] = 1;
    } else next[symbol] = probability;
  }
  const step = (size >> 1) + (size >> 3) + 3;
  let position = 0;
  for (const [symbol, probability] of distribution.entries()) {
    for (let count = 0; count < probability; count++) {
      symbols[position] = symbol;
      position = (position + step) & (size - 1);
      while (position > high) position = (position + step) & (size - 1);
    }
  }
  if (position !== 0) throw new InvalidArgumentError('invalid predefined FSE distribution');
  const cells: FseCell[] = [];
  for (const symbol of symbols) {
    if (symbol < 0) throw new InvalidArgumentError('incomplete predefined FSE table');
    const nextNumber = next[symbol] ?? 0;
    next[symbol] = nextNumber + 1;
    const bits = accuracy - Math.floor(Math.log2(nextNumber));
    cells.push({ symbol, bits, base: nextNumber * 2 ** bits - size });
  }
  return {
    accuracy,
    cells,
    initialState: symbol => {
      const state = cells.findIndex(cell => cell.symbol === symbol);
      if (state === -1) throw new InvalidArgumentError('symbol absent from predefined FSE table');
      return state;
    },
    invert: (symbol, nextState) => {
      const state = cells.findIndex(cell => cell.symbol === symbol && nextState >= cell.base && nextState < cell.base + 2 ** cell.bits);
      if (state === -1) throw new InvalidArgumentError('FSE state transition is unavailable');
      const cell = cells[state];
      if (cell === undefined) throw new InvalidArgumentError('FSE cell is missing');
      return { state, bits: cell.bits, value: nextState - cell.base };
    },
  };
};

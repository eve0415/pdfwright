import { describe, expect, it } from 'vitest';

import { createCalculatorFunction } from './calculatorFunction.ts';

const calculator = (body: string): ((input: readonly number[]) => number[]) => createCalculatorFunction(new TextEncoder().encode(body), 0, 1);

describe('calculator operators', () => {
  it('rounds negative halves toward positive infinity', () => {
    expect(calculator('{ -2.5 round }')([])).toStrictEqual([-2]);
    expect(calculator('{ -1.5 round }')([])).toStrictEqual([-1]);
  });

  it('compares boolean operands in eq and ne', () => {
    expect(calculator('{ true true eq { 1 } { 0 } ifelse }')([])).toStrictEqual([1]);
    expect(calculator('{ true false ne { 1 } { 0 } ifelse }')([])).toStrictEqual([1]);
    expect(calculator('{ true false eq { 1 } { 0 } ifelse }')([])).toStrictEqual([0]);
  });
});

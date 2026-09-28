import { describe, expect, it } from 'vitest';

import { createCalculatorFunction } from './calculatorFunction.ts';

const calculator = (body: string): ((input: readonly number[]) => number[]) => createCalculatorFunction(new TextEncoder().encode(body), 0, 1);

describe('calculator operators', () => {
  it('rounds negative halves toward positive infinity', () => {
    expect(calculator('{ -2.5 round }')([])).toStrictEqual([-2]);
    expect(calculator('{ -1.5 round }')([])).toStrictEqual([-1]);
  });
});

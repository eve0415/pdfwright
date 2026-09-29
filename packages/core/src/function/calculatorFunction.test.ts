import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

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

  it('keeps transcendental calculator outputs identical across runtimes', () => {
    const functions = ['{ 720 mul sin }', '{ 720 mul cos }', '{ ln }', '{ log }', '{ 0.5 exch atan }', '{ 0.7 exch exp }'].map(body =>
      createCalculatorFunction(new TextEncoder().encode(body), 1, 1),
    );
    const bytes = new Uint8Array(4096 * functions.length * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 4096; index++) {
      const input = (index + 0.5) / 4096;
      for (const [channel, evaluate] of functions.entries()) view.setFloat64((index * functions.length + channel) * 8, Number(evaluate([input])[0]), true);
    }
    const digest = [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('886dc811f48572f70702244c2ff18ab3');
  });
});

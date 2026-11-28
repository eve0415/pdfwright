import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { md5 } from '../hash/md5.ts';

import { createCalculatorFunction } from './calculatorFunction.ts';
import { deterministicAtanDegrees, deterministicCosDegrees, deterministicLog, deterministicLog10, deterministicSinDegrees } from './deterministicMath.ts';

const calculator = (body: string, inputs = 0, outputs = 1): ((input: ReadonlyArray<number>) => Array<number>) =>
  createCalculatorFunction(new TextEncoder().encode(body), inputs, outputs);

// Pushes the procedure { 2 } and runs it from the innermost of levels nested if procedures, so that it executes deeper than its own braces sit.
const runNested = (levels: number): string => {
  let body = 'true exch if';
  for (let level = 0; level < levels; level++) {
    body = `true { ${body} } if`;
  }
  return `{ { 2 } ${body} }`;
};

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

  it('shifts 32-bit integers with zero fill in bitshift', () => {
    const cases: Array<[string, number]> = [
      ['7 3', 56],
      ['142 -3', 17],
      ['-1 -1', 2_147_483_647],
      ['-8 -1', 2_147_483_644],
      ['-1 0', -1],
      ['1073741824 1', -2_147_483_648],
      ['3 31', -2_147_483_648],
      ['1 32', 0],
      ['-1 -32', 0],
    ];
    expect(cases.map(([operands]) => calculator(`{ ${operands} bitshift }`)([])[0])).toStrictEqual(cases.map(([, expected]) => expected));
  });

  it('limits the operand stack to 100 values', () => {
    const atLimit = calculator(`{ ${'0 '.repeat(100)}${'pop '.repeat(99)}}`);
    const pastLimit = calculator(`{ ${'0 '.repeat(101)}${'pop '.repeat(100)}}`);
    expect(atLimit([])).toStrictEqual([0]);
    expect(() => pastLimit([])).toThrow(ResourceLimitError);
  });

  it('keeps transcendental calculator outputs identical across runtimes', () => {
    const functions = ['{ 720 mul sin }', '{ 720 mul cos }', '{ ln }', '{ log }', '{ 0.5 exch atan }', '{ 0.7 exch exp }'].map(body =>
      createCalculatorFunction(new TextEncoder().encode(body), 1, 1),
    );
    const bytes = new Uint8Array(4096 * functions.length * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 4096; index++) {
      const input = (index + 0.5) / 4096;
      for (const [channel, evaluate] of functions.entries()) {
        view.setFloat64((index * functions.length + channel) * 8, Number(evaluate([input])[0]), true);
      }
    }
    const digest = [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('886dc811f48572f70702244c2ff18ab3');
  });
});

// An outer procedure holding levels nested empty procedures, which it pushes and pops.
const nestedBraces = (levels: number): string => `{ ${'{ '.repeat(levels)}${'} '.repeat(levels)}pop 1 }`;

// 1, the procedure and the final pop are three steps, and each of the 1,666 runs of the procedure is six (dup true exch if, then 0 pop), so one cvr of padding makes 10,000 steps.
const stepProgram = (padding: string) => calculator(`{ 1 { 0 pop } ${'dup true exch if '.repeat(1666)}pop ${padding}}`);

describe('calculator programs', () => {
  // ISO 32000-1:2008, 7.10.5.1: the program is one procedure in braces; PostScript comments run to the end of the line, and numbers use the PostScript integer and real syntax.
  it.each([
    ['{ }', 1, [0.3], [0.3]],
    ['{ 1 % 2 add\n }', 0, [], [1]],
    ['{ .5 }', 0, [], [0.5]],
    ['{ 5. }', 0, [], [5]],
    ['{ -.5 }', 0, [], [-0.5]],
    ['{ +1 }', 0, [], [1]],
    ['{ 1e2 }', 0, [], [100]],
    ['{ 1E-2 }', 0, [], [0.01]],
  ])('runs %j', (body, inputs, input, expected) => {
    expect(calculator(body, inputs)(input)).toStrictEqual(expected);
  });

  it.each([
    ['1 2 add', /one outer/],
    ['{ } { }', /one outer/],
    ['5', /outer braces/],
    ['{ 1', /unclosed brace/],
    ['{ 1 } }', /unmatched brace/],
  ])('rejects the program %j', (body, pattern) => {
    expect(() => calculator(body)).toThrow(ParseError);
    expect(() => calculator(body)).toThrow(pattern);
  });

  it('builds 16 levels of braces and rejects 17', () => {
    expect(calculator(nestedBraces(15))([])).toStrictEqual([1]);
    expect(() => calculator(nestedBraces(16))).toThrow(ResourceLimitError);
  });

  it('builds 10,000 tokens and rejects 10,001', () => {
    // The braces and 1 are three tokens, and each 0 add is two more.
    expect(calculator(`{ 1 ${'0 add '.repeat(4998)}cvr }`)([])).toStrictEqual([1]);
    expect(() => calculator(`{ 1 ${'0 add '.repeat(4999)}}`)).toThrow(ResourceLimitError);
  });

  it('runs 10,000 steps and rejects 10,001', () => {
    const atLimit = stepProgram('cvr ');
    const pastLimit = stepProgram('cvr cvr ');
    expect(atLimit([])).toStrictEqual([1]);
    expect(() => pastLimit([])).toThrow(ResourceLimitError);
  });

  it('runs procedures 16 levels deep and rejects 17', () => {
    const atLimit = calculator(runNested(14));
    const pastLimit = calculator(runNested(15));
    const sequential = calculator(`{ ${'true { 1 pop } if '.repeat(20)}1 }`);
    expect([atLimit([]), sequential([])]).toStrictEqual([[2], [1]]);
    expect(() => pastLimit([])).toThrow(ResourceLimitError);
  });

  // ISO 32000-1:2008, 7.10.5.1, Table 42 lists the operators, whose meaning PostScript defines.
  it.each([
    ['1 2 add', [3]],
    ['5 2 sub', [3]],
    ['3 4 mul', [12]],
    ['1 4 div', [0.25]],
    ['7 -2 idiv', [-3]],
    ['-7 2 mod', [-1]],
    ['2 3 exp', [8]],
    ['2.25 sqrt', [1.5]],
    ['2.5 round', [3]],
    ['-1.5 abs', [1.5]],
    ['1.5 abs', [1.5]],
    ['2 neg', [-2]],
    ['-1.5 ceiling', [-1]],
    ['1.5 ceiling', [2]],
    ['-1.5 floor', [-2]],
    ['-1.5 truncate', [-1]],
    ['1.5 truncate', [1]],
    ['-1.5 cvi', [-1]],
    ['1.5 cvi', [1]],
    ['-1.5 cvr', [-1.5]],
    ['10 ln', [deterministicLog(10)]],
    ['10 log', [deterministicLog10(10)]],
    ['30 sin', [deterministicSinDegrees(30)]],
    ['30 cos', [deterministicCosDegrees(30)]],
    ['1 2 atan', [deterministicAtanDegrees(1, 2)]],
    ['2 2 le { 1 } { 0 } ifelse', [1]],
    ['3 2 le { 1 } { 0 } ifelse', [0]],
    ['2 2 lt { 1 } { 0 } ifelse', [0]],
    ['2 2 ge { 1 } { 0 } ifelse', [1]],
    ['1 2 ge { 1 } { 0 } ifelse', [0]],
    ['2 2 gt { 1 } { 0 } ifelse', [0]],
    ['3 2 gt { 1 } { 0 } ifelse', [1]],
    ['12 10 and', [8]],
    ['12 10 or', [14]],
    ['12 10 xor', [6]],
    ['true false and { 1 } { 0 } ifelse', [0]],
    ['true false or { 1 } { 0 } ifelse', [1]],
    ['true false xor { 1 } { 0 } ifelse', [1]],
    ['true true xor { 1 } { 0 } ifelse', [0]],
    ['5 not', [-6]],
    ['true not { 1 } { 0 } ifelse', [0]],
    ['1 2 pop', [1]],
    ['1 2 exch', [2, 1]],
    ['1 2 3 2 copy', [1, 2, 3, 2, 3]],
    ['1 2 0 copy', [1, 2]],
    ['1 2 3 2 index', [1, 2, 3, 1]],
    ['1 2 3 0 index', [1, 2, 3, 3]],
    ['1 2 3 3 1 roll', [3, 1, 2]],
    ['1 2 3 3 -1 roll', [2, 3, 1]],
    ['1 2 3 2 1 roll', [1, 3, 2]],
    ['1 false { 2 } if', [1]],
    ['1 true { 2 } if', [1, 2]],
  ])('evaluates %j', (body, expected) => {
    expect(calculator(`{ ${body} }`, 0, expected.length)([])).toStrictEqual(expected);
  });

  it.each([
    ['foo', /unknown operator foo/],
    ['1.2.3', /unknown operator 1\.2\.3/],
    ['add', /underflow/],
    ['true 1 add', /expected number/],
    ['1 { 1 } if', /expected boolean/],
    ['true 1 if', /expected procedure/],
    ['1 true and', /boolean operands/],
    ['{ } not', /not operand/],
    ['1 0 div', /arithmetic/],
    ['-1 sqrt', /arithmetic/],
    ['0 ln', /arithmetic/],
    ['1 0 mod', /arithmetic/],
    ['1 0 idiv', /non-finite integer/],
    ['1 2 copy', /copy count/],
    ['1 -1 copy', /copy count/],
    ['1 1 index', /invalid index/],
    ['1 -1 index', /invalid index/],
    ['1 2 1 roll', /roll count/],
    ['true', /output dimension/],
    ['1 2', /output dimension/],
  ])('rejects %j when it runs', (body, pattern) => {
    const evaluate = calculator(`{ ${body} }`);
    expect(() => evaluate([])).toThrow(ParseError);
    expect(() => evaluate([])).toThrow(pattern);
  });

  it('rejects an input array of the wrong length', () => {
    const evaluate = calculator('{ }', 1);
    expect(() => evaluate([])).toThrow(ParseError);
    expect(() => evaluate([1, 2])).toThrow(/input dimension mismatch/);
  });
});

describe('properties', () => {
  const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 });

  it('agrees with 32-bit and, or and xor', () => {
    fc.assert(
      fc.property(int32, int32, (a, b) => {
        const operands = `${String(a)} ${String(b)}`;
        expect(['and', 'or', 'xor'].map(operator => calculator(`{ ${operands} ${operator} }`)([])[0])).toStrictEqual([a & b, a | b, a ^ b]);
      }),
    );
  });

  it('agrees with a zero-filling 32-bit shift in bitshift', () => {
    fc.assert(
      fc.property(int32, fc.integer({ min: -40, max: 40 }), (a, shift) => {
        const expected = shift >= 32 || shift <= -32 ? 0 : shift >= 0 ? (a << shift) | 0 : (a >>> -shift) | 0;
        expect(calculator(`{ ${String(a)} ${String(shift)} bitshift }`)([])).toStrictEqual([expected]);
      }),
    );
  });

  it('rolls the top n values cyclically by j positions toward the top', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 10 }), fc.integer({ min: -25, max: 25 }), (values, shift) => {
        const count = values.length;
        const expected = values.map((_, index) => values[(((index - shift) % count) + count) % count]);
        expect(calculator(`{ ${values.map(String).join(' ')} ${String(count)} ${String(shift)} roll }`, 0, count)([])).toStrictEqual(expected);
      }),
    );
  });
});

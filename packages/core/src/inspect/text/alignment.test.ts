import type { AlignmentStep } from './alignment.ts';

import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../../error/resourceLimitError.ts';

import { align } from './alignment.ts';

// The length of a longest common subsequence, by the quadratic dynamic programme.
const lcsLength = (a: string, b: string): number => {
  let previous: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (const left of a) {
    const row = [0];
    for (let index = 0; index < b.length; index++) {
      row.push(left === b[index] ? (previous[index] ?? 0) + 1 : Math.max(previous[index + 1] ?? 0, row[index] ?? 0));
    }
    previous = row;
  }
  return previous.at(-1) ?? 0;
};

// A deterministic sequence of pseudo-random strings over a small alphabet.
const strings = (count: number): string[] => {
  let seed = 12_345;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  return Array.from({ length: count }, () => Array.from({ length: next() % 12 }, () => 'abc'.charAt(next() % 3)).join(''));
};

const run = (a: string, b: string): readonly AlignmentStep[] => align(a.length, b.length, (i, j) => a[i] === b[j]);

const positions = (length: number): number[] => Array.from({ length }, (_, index) => index);

// What an alignment of two strings covers: the intended and found positions in the order listed, the number of matches, and whether every match pairs equal items.
const coverage = (a: string, b: string): unknown[] => {
  const steps = run(a, b);
  const intended = steps.flatMap(step => (step.kind === 'extra' ? [] : [step.intended]));
  const found = steps.flatMap(step => (step.kind === 'missing' ? [] : [step.found]));
  const equal = steps.filter(step => step.kind === 'equal');
  return [intended, found, equal.length, equal.every(step => a[step.intended] === b[step.found])];
};

describe('alignment', () => {
  it('bounds mismatched alignment work', () => {
    expect(() => run('A'.repeat(4000), 'Z'.repeat(4000))).toThrow(ResourceLimitError);
  });

  it('matches a longest common subsequence and lists every item once, in order', () => {
    const inputs = strings(400);
    for (let index = 0; index + 1 < inputs.length; index += 2) {
      const [a = '', b = ''] = [inputs[index], inputs[index + 1]];
      expect(coverage(a, b)).toStrictEqual([positions(a.length), positions(b.length), lcsLength(a, b), true]);
    }
  });

  it('reports unmatched items of either side', () => {
    expect(run('abc', 'axc')).toStrictEqual([
      { kind: 'equal', intended: 0, found: 0 },
      { kind: 'missing', intended: 1 },
      { kind: 'extra', found: 1 },
      { kind: 'equal', intended: 2, found: 2 },
    ]);
  });
});

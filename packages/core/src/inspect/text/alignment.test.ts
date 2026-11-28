import type { AlignmentStep } from './alignment.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../../error/resourceLimitError.ts';

import { align } from './alignment.ts';

// The length of a longest common subsequence, by the quadratic dynamic programme.
const lcsLength = (a: string, b: string): number => {
  let previous: Array<number> = Array.from({ length: b.length + 1 }, () => 0);
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
const strings = (count: number): Array<string> => {
  let seed = 12_345;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  return Array.from({ length: count }, () => Array.from({ length: next() % 12 }, () => 'abc'.charAt(next() % 3)).join(''));
};

const run = (a: string, b: string): ReadonlyArray<AlignmentStep> => align(a.length, b.length, (i, j) => a[i] === b[j]);

const positions = (length: number): Array<number> => Array.from({ length }, (_, index) => index);

// What an alignment of two strings covers: the intended and found positions in the order listed, the number of matches, and whether every match pairs equal items.
const coverage = (a: string, b: string): Array<unknown> => {
  const steps = run(a, b);
  const intended = steps.flatMap(step => (step.kind === 'extra' ? [] : [step.intended]));
  const found = steps.flatMap(step => (step.kind === 'missing' ? [] : [step.found]));
  const equal = steps.filter(step => step.kind === 'equal');
  return [intended, found, equal.length, equal.every(step => a[step.intended] === b[step.found])];
};

// The steps with each run of unmatched steps between two matches put in one canonical order, since `align` promises the order of each side's items but not how the two sides interleave inside a gap.
const canonical = (steps: ReadonlyArray<AlignmentStep>): Array<unknown> => {
  const result: Array<unknown> = [];
  let gap: Array<string> = [];
  const flush = (): void => {
    if (gap.length > 0) {
      result.push(gap.toSorted());
    }
    gap = [];
  };
  for (const step of steps) {
    if (step.kind === 'equal') {
      flush();
      result.push(step);
    } else {
      gap.push(step.kind === 'missing' ? `missing ${String(step.intended)}` : `extra ${String(step.found)}`);
    }
  }
  flush();
  return result;
};

const never = (): boolean => {
  throw new Error('no comparison is needed');
};

const differ = (): boolean => false;

describe('alignment', () => {
  it('bounds mismatched alignment work', () => {
    expect(() => run('A'.repeat(4000), 'Z'.repeat(4000))).toThrow(ResourceLimitError);
  });

  it('allows alignment work of exactly 2,000,000 steps and refuses one item more', () => {
    // Aligning four items against 200,000 wholly different ones takes exactly 2,000,000 steps, and against 200,001 takes 2,000,020.
    expect(align(4, 200_000, differ)).toHaveLength(200_004);
    expect(() => align(4, 200_001, differ)).toThrow(ResourceLimitError);
  });

  it('aligns empty sequences without comparing anything', () => {
    expect([align(0, 0, never), align(0, 3, never), align(3, 0, never)]).toStrictEqual([
      [],
      [
        { kind: 'extra', found: 0 },
        { kind: 'extra', found: 1 },
        { kind: 'extra', found: 2 },
      ],
      [
        { kind: 'missing', intended: 0 },
        { kind: 'missing', intended: 1 },
        { kind: 'missing', intended: 2 },
      ],
    ]);
  });

  it('matches a longest common subsequence and lists every item once, in order', () => {
    const inputs = strings(400);
    for (let index = 0; index + 1 < inputs.length; index += 2) {
      const [a = '', b = ''] = [inputs[index], inputs[index + 1]];
      expect(coverage(a, b)).toStrictEqual([positions(a.length), positions(b.length), lcsLength(a, b), true]);
    }
  });

  it('reports unmatched items of either side', () => {
    expect([canonical(run('abc', 'axc')), canonical(run('abcd', 'xbyz'))]).toStrictEqual([
      [{ kind: 'equal', intended: 0, found: 0 }, ['extra 1', 'missing 1'], { kind: 'equal', intended: 2, found: 2 }],
      [['extra 0', 'missing 0'], { kind: 'equal', intended: 1, found: 1 }, ['extra 2', 'extra 3', 'missing 2', 'missing 3']],
    ]);
  });
});

describe('properties', () => {
  // Long sequences over two or four symbols, so that the searches from both ends prune diagonals and meet with either parity of the length difference; fast-check keeps a string to about ten units unless its size is raised.
  const sequence = fc.oneof(
    fc.string({ unit: fc.constantFrom('a', 'b'), maxLength: 300, size: 'max' }),
    fc.string({ unit: fc.constantFrom('a', 'b', 'c', 'd'), maxLength: 300, size: 'max' }),
  );

  it('matches a longest common subsequence of long sequences and lists every item once, in order', () => {
    fc.assert(
      fc.property(sequence, sequence, (a, b) => {
        expect(coverage(a, b)).toStrictEqual([positions(a.length), positions(b.length), lcsLength(a, b), true]);
      }),
    );
  });
});

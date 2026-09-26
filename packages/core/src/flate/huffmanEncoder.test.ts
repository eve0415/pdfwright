import { describe, expect, it } from 'vitest';

import { buildCodeLengths } from './huffmanEncoder.ts';

const fibonacci = (count: number): number[] => {
  const values = [1, 1];
  while (values.length < count) values.push((values.at(-1) ?? 0) + (values.at(-2) ?? 0));
  return values;
};

describe('bounded Huffman code lengths', () => {
  it('limits pathological Fibonacci frequencies to fifteen bits', () => {
    const lengths = buildCodeLengths(fibonacci(29), 15);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(15);
    const used = lengths.filter(length => length > 0);
    expect(used).toHaveLength(29);
    expect(used.reduce((sum, length) => sum + 2 ** (15 - length), 0)).toBe(2 ** 15);
  });
});

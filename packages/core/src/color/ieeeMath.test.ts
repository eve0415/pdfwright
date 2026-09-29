import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { deterministicCbrt, deterministicPow } from './ieeeMath.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

describe('deterministic ICC math', () => {
  it('evaluates standard roots and powers', () => {
    expect(deterministicCbrt(8)).toBe(2);
    expect(deterministicCbrt(-27)).toBe(-3);
    expect(deterministicPow(0.5, 2)).toBe(0.25);
    expect(deterministicPow(0, 2.4)).toBe(0);
    for (let index = 1; index < 4096; index++) {
      const base = index / 4096;
      expect(Math.abs(deterministicPow(base, 1 / 2.4) - base ** (1 / 2.4))).toBeLessThan(1e-12);
    }
  });

  it('keeps the same float64 digest in every runtime', () => {
    const bytes = new Uint8Array(8192 * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 4096; index++) {
      const value = (index + 0.5) / 4096;
      view.setFloat64(index * 16, deterministicCbrt(value), true);
      view.setFloat64(index * 16 + 8, deterministicPow(value, 1 / 2.4), true);
    }
    expect(hex(md5(bytes))).toBe('42fc2516cd3af7b55a1e3b0431d11c91');
  });
});

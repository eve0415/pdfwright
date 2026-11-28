import { InvalidArgumentError, mm, pt } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { formatNativeNumber } from './formatNativeNumber.ts';

describe('native number formatting', () => {
  it('writes fixed-point tokens within the observed 15-digit budget', () => {
    let state = 123_456_789;
    for (let index = 0; index < 100_000; index++) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      const value = ((state / 4_294_967_296) * 32_766 - 16_383) / 10 ** (index % 12);
      const output = formatNativeNumber(value);
      const [integer = '', fraction = ''] = output.replace('-', '').split('.');
      expect(output).not.toMatch(/[eE]/u);
      expect(integer.replace(/^0$/u, '').length + fraction.length).toBeLessThanOrEqual(15);
      expect(fraction.length).toBeLessThanOrEqual(10);
    }
  });

  it('rounds numbers and exact lengths with core formatting', () => {
    expect(formatNativeNumber(-0)).toBe('0');
    expect(formatNativeNumber(99_999.99999999999)).toBe('100000');
    expect(formatNativeNumber(1e-12)).toBe('0');
    expect(formatNativeNumber(mm(100))).toBe('283.4645669291');
    expect(formatNativeNumber(pt(0.5))).toBe('0.5');
  });

  it('rejects non-finite and over-budget values', () => {
    for (const value of [Number.NaN, Infinity, -Infinity, 1e15, 999_999_999_999_999.9]) {
      expect(() => formatNativeNumber(value)).toThrow(InvalidArgumentError);
    }
  });
});

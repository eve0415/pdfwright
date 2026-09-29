import { describe, expect, it } from 'vitest';

import {
  deterministicAtanDegrees,
  deterministicCosDegrees,
  deterministicExp,
  deterministicLog,
  deterministicLog10,
  deterministicSinDegrees,
} from './deterministicMath.ts';

describe('deterministic calculator math', () => {
  it('approximates logarithms across the positive finite range', () => {
    for (const value of [Number.MIN_VALUE, 1e-100, 0.001, 0.5, 1, 2, 10, 1e100, Number.MAX_VALUE]) {
      expect(Math.abs(deterministicLog(value) - Math.log(value))).toBeLessThan(2e-12);
      expect(Math.abs(deterministicLog10(value) - Math.log10(value))).toBeLessThan(2e-12);
    }
  });

  it('evaluates degree trigonometry and all arctangent quadrants', () => {
    for (let degrees = -720; degrees <= 720; degrees += 7) {
      expect(Math.abs(deterministicSinDegrees(degrees) - Math.sin((degrees * Math.PI) / 180))).toBeLessThan(2e-14);
      expect(Math.abs(deterministicCosDegrees(degrees) - Math.cos((degrees * Math.PI) / 180))).toBeLessThan(2e-14);
    }
    for (const numerator of [-10, -1, 0, 1, 10]) {
      for (const denominator of [-10, -1, 0, 1, 10]) {
        const expected = ((Math.atan2(numerator, denominator) * 180) / Math.PI + 360) % 360;
        expect(Math.abs(deterministicAtanDegrees(numerator, denominator) - expected)).toBeLessThan(2e-12);
      }
    }
  });

  it('raises negative bases to integer powers', () => {
    expect(deterministicExp(-2, 3)).toBe(-8);
    expect(deterministicExp(-2, 4)).toBe(16);
    expect(deterministicExp(-2, 0.5)).toBeNaN();
  });
});

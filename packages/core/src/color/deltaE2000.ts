import { deterministicAtanDegrees, deterministicCosDegrees, deterministicSinDegrees } from '../function/deterministicMath.ts';

import { deterministicPow } from './ieeeMath.ts';

// Engines differ in the last bits of Math.atan2, Math.cos, Math.sin, Math.exp, Math.hypot and **, so ΔE00 uses only correctly rounded operations and the fdlibm kernels.
const TWENTY_FIVE_TO_THE_SEVENTH = 6_103_515_625;

const seventhPower = (value: number): number => {
  const square = value * value;
  return square * square * square * value;
};

const hueDifference = (first: number, second: number, chromaProduct: number): number => {
  if (chromaProduct === 0) {
    return 0;
  }
  const difference = second - first;
  if (difference > 180) {
    return difference - 360;
  }
  if (difference < -180) {
    return difference + 360;
  }
  return difference;
};

const meanHue = (first: number, second: number, chromaProduct: number): number => {
  if (chromaProduct === 0) {
    return first + second;
  }
  if (Math.abs(first - second) <= 180) {
    return (first + second) / 2;
  }
  const sum = first + second;
  if (sum < 360) {
    return (sum + 360) / 2;
  }
  return (sum - 360) / 2;
};

/** CIEDE2000 for two L*a*b* triples, with unit parametric factors. */
export const deltaE2000 = (first: ReadonlyArray<number>, second: ReadonlyArray<number>): number => {
  const [l1 = 0, a1 = 0, b1 = 0] = first;
  const [l2 = 0, a2 = 0, b2 = 0] = second;
  const c1 = Math.sqrt(a1 * a1 + b1 * b1);
  const c2 = Math.sqrt(a2 * a2 + b2 * b2);
  const meanC = (c1 + c2) / 2;
  const meanC7 = seventhPower(meanC);
  const g = (1 - Math.sqrt(meanC7 / (meanC7 + TWENTY_FIVE_TO_THE_SEVENTH))) / 2;
  const ap1 = a1 * (1 + g);
  const ap2 = a2 * (1 + g);
  const cp1 = Math.sqrt(ap1 * ap1 + b1 * b1);
  const cp2 = Math.sqrt(ap2 * ap2 + b2 * b2);
  const h1 = deterministicAtanDegrees(b1, ap1);
  const h2 = deterministicAtanDegrees(b2, ap2);
  const deltaH = hueDifference(h1, h2, cp1 * cp2);
  const meanH = meanHue(h1, h2, cp1 * cp2);
  const meanCp = (cp1 + cp2) / 2;
  const t =
    1 -
    0.17 * deterministicCosDegrees(meanH - 30) +
    0.24 * deterministicCosDegrees(2 * meanH) +
    0.32 * deterministicCosDegrees(3 * meanH + 6) -
    0.2 * deterministicCosDegrees(4 * meanH - 63);
  const hueOffset = (meanH - 275) / 25;
  const deltaTheta = 30 * deterministicPow(Math.E, -(hueOffset * hueOffset));
  const meanCp7 = seventhPower(meanCp);
  const rc = 2 * Math.sqrt(meanCp7 / (meanCp7 + TWENTY_FIVE_TO_THE_SEVENTH));
  const lightnessOffset = (l1 + l2) / 2 - 50;
  const sl = 1 + (0.015 * lightnessOffset * lightnessOffset) / Math.sqrt(20 + lightnessOffset * lightnessOffset);
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const dl = (l2 - l1) / sl;
  const dc = (cp2 - cp1) / sc;
  const dh = (2 * Math.sqrt(cp1 * cp2) * deterministicSinDegrees(deltaH / 2)) / sh;
  return Math.sqrt(dl * dl + dc * dc + dh * dh - rc * deterministicSinDegrees(2 * deltaTheta) * dc * dh);
};

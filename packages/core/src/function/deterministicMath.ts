/*
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */

import { deterministicPow } from '../color/ieeeMath.ts';

// ISO 32000-1:2008, 7.10.5 and Annex B use PostScript calculator operators; these kernels follow fdlibm e_log.c, k_sin.c, k_cos.c and s_atan.c.
const bits = new DataView(new ArrayBuffer(8));
const high = (value: number): number => {
  bits.setFloat64(0, value);
  return bits.getUint32(0);
};
const withHigh = (value: number, word: number): number => {
  bits.setFloat64(0, value);
  bits.setUint32(0, word);
  return bits.getFloat64(0);
};

const LOG_COEFFICIENTS = [
  6.66666666666673513e-1, 3.999999999940941908e-1, 2.857142874366239149e-1, 2.222219843214978396e-1, 1.818357216161805012e-1, 1.531383769920937332e-1,
  1.479819860511658591e-1,
] as const;
const LN2_HIGH = 6.9314718036912381649e-1;
const LN2_LOW = 1.90821492927058770002e-10;

export const deterministicLog = (value: number): number => {
  if (value === 0) return -Infinity;
  if (value < 0 || Number.isNaN(value)) return Number.NaN;
  if (value === Infinity) return Infinity;
  let x = value;
  let word = high(x);
  let exponent = 0;
  if (word < 0x00100000) {
    x *= 1.8014398509481984e16;
    exponent -= 54;
    word = high(x);
  }
  exponent += Math.floor(word / 0x100000) - 1023;
  const fraction = word % 0x100000;
  const upper = fraction + 0x95f64 >= 0x100000 ? 0x100000 : 0;
  x = withHigh(x, fraction + (upper === 0 ? 0x3ff00000 : 0x3fe00000));
  exponent += upper / 0x100000;
  const f = x - 1;
  if ((2 + fraction) % 0x100000 < 3) {
    if (f === 0) return exponent === 0 ? 0 : exponent * LN2_HIGH + exponent * LN2_LOW;
    const correction = f * f * (0.5 - f / 3);
    return exponent === 0 ? f - correction : exponent * LN2_HIGH - (correction - exponent * LN2_LOW - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const even = w * (LOG_COEFFICIENTS[1] + w * (LOG_COEFFICIENTS[3] + w * LOG_COEFFICIENTS[5]));
  const odd = z * (LOG_COEFFICIENTS[0] + w * (LOG_COEFFICIENTS[2] + w * (LOG_COEFFICIENTS[4] + w * LOG_COEFFICIENTS[6])));
  const correction = even + odd;
  if (fraction > 0x6147a && fraction < 0x6b851) {
    const halfSquare = 0.5 * f * f;
    return exponent === 0
      ? f - (halfSquare - s * (halfSquare + correction))
      : exponent * LN2_HIGH - (halfSquare - (s * (halfSquare + correction) + exponent * LN2_LOW) - f);
  }
  return exponent === 0 ? f - s * (f - correction) : exponent * LN2_HIGH - (s * (f - correction) - exponent * LN2_LOW - f);
};

export const deterministicLog10 = (value: number): number => deterministicLog(value) * Math.LOG10E;

const SIN_COEFFICIENTS = [
  -1.66666666666666324348e-1, 8.33333333332248946124e-3, -1.98412698298579493134e-4, 2.75573137070700676789e-6, -2.50507602534068634195e-8,
  1.58969099521155010221e-10,
] as const;
const COS_COEFFICIENTS = [
  4.16666666666666019037e-2, -1.38888888888741095749e-3, 2.48015872894767294178e-5, -2.75573143513906633035e-7, 2.0875723212981748279e-9,
  -1.13596475577881948265e-11,
] as const;
const PI_OVER_TWO_HIGH = 1.570796326794896558;
const PI_OVER_TWO_LOW = 6.12323399573676603587e-17;

const kernelSin = (x: number): number => {
  const square = x * x;
  const tail =
    SIN_COEFFICIENTS[1] + square * (SIN_COEFFICIENTS[2] + square * (SIN_COEFFICIENTS[3] + square * (SIN_COEFFICIENTS[4] + square * SIN_COEFFICIENTS[5])));
  return x + x * square * (SIN_COEFFICIENTS[0] + square * tail);
};

const kernelCos = (x: number): number => {
  const square = x * x;
  const tail =
    square *
    (COS_COEFFICIENTS[0] +
      square *
        (COS_COEFFICIENTS[1] +
          square * (COS_COEFFICIENTS[2] + square * (COS_COEFFICIENTS[3] + square * (COS_COEFFICIENTS[4] + square * COS_COEFFICIENTS[5])))));
  if (Math.abs(x) < 0.3) return 1 - (0.5 * square - square * tail);
  const quarter = Math.abs(x) > 0.78125 ? 0.28125 : Math.abs(x) / 4;
  return 1 - quarter - (0.5 * square - quarter - square * tail);
};

const degreeTrig = (degrees: number, cosine: boolean): number => {
  if (!Number.isFinite(degrees)) return Number.NaN;
  const angle = ((degrees % 360) * Math.PI) / 180;
  const quadrant = Math.round(angle / PI_OVER_TWO_HIGH);
  const reduced = angle - quadrant * PI_OVER_TWO_HIGH - quadrant * PI_OVER_TWO_LOW;
  const position = ((quadrant % 4) + 4) % 4;
  if (cosine) {
    if (position === 0) return kernelCos(reduced);
    if (position === 1) return -kernelSin(reduced);
    if (position === 2) return -kernelCos(reduced);
    return kernelSin(reduced);
  }
  if (position === 0) return kernelSin(reduced);
  if (position === 1) return kernelCos(reduced);
  if (position === 2) return -kernelSin(reduced);
  return -kernelCos(reduced);
};

export const deterministicSinDegrees = (degrees: number): number => degreeTrig(degrees, false);
export const deterministicCosDegrees = (degrees: number): number => degreeTrig(degrees, true);

const ATAN_HIGH = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.570796326794896558] as const;
const ATAN_LOW = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17] as const;
const ATAN_COEFFICIENTS = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.1111110405462355788e-1, 9.09088713343650656196e-2,
  -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2, -3.6531572744216915527e-2,
  1.62858201153657823623e-2,
] as const;

const deterministicAtan = (value: number): number => {
  const magnitude = Math.abs(value);
  if (magnitude >= 2 ** 66) return value < 0 ? -(ATAN_HIGH[3] + ATAN_LOW[3]) : ATAN_HIGH[3] + ATAN_LOW[3];
  let x = magnitude;
  let region = -1;
  if (x >= 0.4375 && x < 1.1875) {
    if (x < 0.6875) {
      region = 0;
      x = (2 * x - 1) / (2 + x);
    } else {
      region = 1;
      x = (x - 1) / (x + 1);
    }
  } else if (x >= 1.1875 && x < 2.4375) {
    region = 2;
    x = (x - 1.5) / (1 + 1.5 * x);
  } else if (x >= 2.4375) {
    region = 3;
    x = -1 / x;
  }
  const square = x * x;
  const fourth = square * square;
  const odd =
    square *
    (ATAN_COEFFICIENTS[0] +
      fourth *
        (ATAN_COEFFICIENTS[2] +
          fourth * (ATAN_COEFFICIENTS[4] + fourth * (ATAN_COEFFICIENTS[6] + fourth * (ATAN_COEFFICIENTS[8] + fourth * ATAN_COEFFICIENTS[10])))));
  const even =
    fourth *
    (ATAN_COEFFICIENTS[1] +
      fourth * (ATAN_COEFFICIENTS[3] + fourth * (ATAN_COEFFICIENTS[5] + fourth * (ATAN_COEFFICIENTS[7] + fourth * ATAN_COEFFICIENTS[9]))));
  const angle = region < 0 ? x - x * (odd + even) : (ATAN_HIGH[region] ?? 0) - (x * (odd + even) - (ATAN_LOW[region] ?? 0) - x);
  return value < 0 ? -angle : angle;
};

const deterministicAtan2 = (y: number, x: number): number => {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (y === 0) {
    if (x >= 0) return y;
    return Object.is(y, -0) ? -Math.PI : Math.PI;
  }
  if (x === 0) return y < 0 ? -PI_OVER_TWO_HIGH : PI_OVER_TWO_HIGH;
  const angle = deterministicAtan(Math.abs(y / x));
  if (x > 0) return y < 0 ? -angle : angle;
  return y < 0 ? angle - Math.PI : Math.PI - angle;
};

export const deterministicAtanDegrees = (numerator: number, denominator: number): number =>
  ((deterministicAtan2(numerator, denominator) * 180) / Math.PI + 360) % 360;

export const deterministicExp = (base: number, exponent: number): number => {
  if (base >= 0 || Object.is(base, -0)) return deterministicPow(base, exponent);
  if (!Number.isInteger(exponent)) return Number.NaN;
  const magnitude = deterministicPow(-base, exponent);
  return exponent % 2 === 0 ? magnitude : -magnitude;
};

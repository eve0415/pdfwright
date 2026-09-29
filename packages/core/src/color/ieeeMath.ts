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
/*
 * ====================================================
 * Copyright (C) 2004 by Sun Microsystems, Inc. All rights reserved.
 *
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */

// Adapted from fdlibm s_cbrt.c and e_pow.c for the positive bases used by ICC curves.
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

const chop = (value: number): number => {
  bits.setFloat64(0, value);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
};

const pow2 = (exponent: number): number => {
  if (exponent > 1023) return Infinity;
  if (exponent < -1074) return 0;
  bits.setFloat64(0, 0);
  if (exponent >= -1022) bits.setUint32(0, (exponent + 1023) * 0x100000);
  else if (exponent >= -1042) {
    let mantissa = 1;
    for (let index = 0; index < exponent + 1042; index++) mantissa *= 2;
    bits.setUint32(0, mantissa);
  } else {
    let mantissa = 1;
    for (let index = 0; index < exponent + 1074; index++) mantissa *= 2;
    bits.setUint32(4, mantissa);
  }
  return bits.getFloat64(0);
};

export const deterministicCbrt = (value: number): number => {
  if (value === 0 || !Number.isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const h = high(x);
  const seedHigh = h < 0x00100000 ? high(pow2(54) * x) : h;
  let t = withHigh(0, Math.floor(seedHigh / 3) + (h < 0x00100000 ? 696219795 : 715094163));
  const r = (t * t) / x;
  const s = 5.42857142857142815906e-1 + r * t;
  t *= 3.57142857142857150787e-1 + 1.6071428571428572063 / (s + 1.41428571428571436819 - 7.0530612244897961105e-1 / s);
  t = withHigh(chop(t), high(t) + 1);
  const square = t * t;
  const quotient = x / square;
  const twice = t + t;
  return sign * (t + t * ((quotient - t) / (twice + quotient)));
};

const LOG_COEFFICIENTS = [
  5.99999999999994648725e-1, 4.28571428578550184252e-1, 3.33333329818377432918e-1, 2.72728123808534006489e-1, 2.30660745775561754067e-1,
  2.06975017800338417784e-1,
] as const;

const EXP_COEFFICIENTS = [
  1.66666666666666019037e-1, -2.77777777770155933842e-3, 6.61375632143793436117e-5, -1.6533902205465251539e-6, 4.13813679705723846039e-8,
] as const;

/** Computes positive-base powers with the fdlibm split-logarithm and exponential polynomials. */
const specialPower = (base: number, exponent: number): number | undefined => {
  if (exponent === 0 || base === 1) return 1;
  if (base === 0) return exponent > 0 ? 0 : Infinity;
  if (Number.isNaN(base) || Number.isNaN(exponent) || base < 0) return Number.NaN;
  if (exponent === 1) return base;
  if (exponent === 2) return base * base;
  if (exponent === 0.5) return Math.sqrt(base);
  if (!Number.isFinite(base) || !Number.isFinite(exponent)) return base > 1 === exponent > 0 ? Infinity : 0;
  return undefined;
};

export const deterministicPow = (base: number, exponent: number): number => {
  const special = specialPower(base, exponent);
  if (special !== undefined) return special;

  let scaled = base;
  let h = high(scaled);
  let n = 0;
  if (h < 0x00100000) {
    scaled *= 9007199254740992;
    n -= 53;
    h = high(scaled);
  }
  n += Math.floor(h / 1048576) - 1023;
  const fraction = h % 1048576;
  let interval = 0;
  let normalizedHigh = fraction + 0x3ff00000;
  if (fraction > 0x3988e && fraction < 0xbb67a) interval = 1;
  else if (fraction >= 0xbb67a) {
    n++;
    normalizedHigh -= 0x00100000;
  }
  scaled = withHigh(scaled, normalizedHigh);
  const bp = interval === 0 ? 1 : 1.5;
  const u = scaled - bp;
  const v = 1 / (scaled + bp);
  const s = u * v;
  const sHigh = chop(s);
  const tHigh = withHigh(0, Math.floor(normalizedHigh / 2) + 0x20000000 + 0x00080000 + interval * 262144);
  const tLow = scaled - (tHigh - bp);
  const sLow = v * (u - sHigh * tHigh - sHigh * tLow);
  let s2 = s * s;
  let r =
    s2 *
    s2 *
    (LOG_COEFFICIENTS[0] +
      s2 * (LOG_COEFFICIENTS[1] + s2 * (LOG_COEFFICIENTS[2] + s2 * (LOG_COEFFICIENTS[3] + s2 * (LOG_COEFFICIENTS[4] + s2 * LOG_COEFFICIENTS[5])))));
  r += sLow * (sHigh + s);
  s2 = sHigh * sHigh;
  const logHigh = chop(3 + s2 + r);
  const logLow = r - (logHigh - 3 - s2);
  const logU = sHigh * logHigh;
  const logV = sLow * logHigh + logLow * s;
  const pHigh = chop(logU + logV);
  const pLow = logV - (pHigh - logU);
  const zHigh = 9.61796700954437255859e-1 * pHigh;
  const zLow = -7.02846165095275826516e-9 * pHigh + pLow * 9.61796693925975554329e-1 + (interval === 0 ? 0 : 1.35003920212974897128e-8);
  const intervalHigh = interval === 0 ? 0 : 5.84962487220764160156e-1;
  const t1 = chop(zHigh + zLow + intervalHigh + n);
  const t2 = zLow - (t1 - n - intervalHigh - zHigh);
  const y1 = chop(exponent);
  const productLow = (exponent - y1) * t1 + exponent * t2;
  let productHigh = y1 * t1;
  const product = productHigh + productLow;
  if (product >= 1024) return Infinity;
  if (product <= -1075) return 0;
  const whole = Math.round(product);
  productHigh -= whole;
  const t = chop(productHigh + productLow);
  const expU = t * 6.93147182464599609375e-1;
  const expV = (productLow - (t - productHigh)) * Math.LN2 + t * -1.90465429995776804525e-9;
  const z = expU + expV;
  const w = expV - (z - expU);
  const square = z * z;
  const approx =
    z -
    square *
      (EXP_COEFFICIENTS[0] + square * (EXP_COEFFICIENTS[1] + square * (EXP_COEFFICIENTS[2] + square * (EXP_COEFFICIENTS[3] + square * EXP_COEFFICIENTS[4]))));
  const correction = (z * approx) / (approx - 2) - (w + z * w);
  return (1 - (correction - z)) * pow2(whole);
};

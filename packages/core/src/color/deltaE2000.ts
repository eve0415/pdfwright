const angle = (b: number, a: number): number => {
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
};

const hueDifference = (first: number, second: number, chromaProduct: number): number => {
  if (chromaProduct === 0) return 0;
  const difference = second - first;
  if (difference > 180) return difference - 360;
  if (difference < -180) return difference + 360;
  return difference;
};

const meanHue = (first: number, second: number, chromaProduct: number): number => {
  if (chromaProduct === 0) return first + second;
  if (Math.abs(first - second) <= 180) return (first + second) / 2;
  const sum = first + second;
  if (sum < 360) return (sum + 360) / 2;
  return (sum - 360) / 2;
};

/** CIEDE2000 for two L*a*b* triples, with unit parametric factors. */
export const deltaE2000 = (first: readonly number[], second: readonly number[]): number => {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const c1 = Math.hypot(a1 ?? 0, b1 ?? 0);
  const c2 = Math.hypot(a2 ?? 0, b2 ?? 0);
  const meanC = (c1 + c2) / 2;
  const meanC7 = meanC ** 7;
  const g = (1 - Math.sqrt(meanC7 / (meanC7 + 25 ** 7))) / 2;
  const ap1 = (a1 ?? 0) * (1 + g);
  const ap2 = (a2 ?? 0) * (1 + g);
  const cp1 = Math.hypot(ap1, b1 ?? 0);
  const cp2 = Math.hypot(ap2, b2 ?? 0);
  const h1 = angle(b1 ?? 0, ap1);
  const h2 = angle(b2 ?? 0, ap2);
  const deltaH = hueDifference(h1, h2, cp1 * cp2);
  const meanH = meanHue(h1, h2, cp1 * cp2);
  const meanCp = (cp1 + cp2) / 2;
  const t =
    1 -
    0.17 * Math.cos(((meanH - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * meanH * Math.PI) / 180) +
    0.32 * Math.cos(((3 * meanH + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * meanH - 63) * Math.PI) / 180);
  const deltaTheta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const meanCp7 = meanCp ** 7;
  const rc = 2 * Math.sqrt(meanCp7 / (meanCp7 + 25 ** 7));
  const sl = 1 + (0.015 * (((l1 ?? 0) + (l2 ?? 0)) / 2 - 50) ** 2) / Math.sqrt(20 + (((l1 ?? 0) + (l2 ?? 0)) / 2 - 50) ** 2);
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const dl = ((l2 ?? 0) - (l1 ?? 0)) / sl;
  const dc = (cp2 - cp1) / sc;
  const dh = (2 * Math.sqrt(cp1 * cp2) * Math.sin((deltaH * Math.PI) / 360)) / sh;
  return Math.sqrt(dl * dl + dc * dc + dh * dh - rc * Math.sin((2 * deltaTheta * Math.PI) / 180) * dc * dh);
};

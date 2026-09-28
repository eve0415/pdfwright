import type { LutTag } from '../icc/iccProfile.ts';
import type { Xyz } from '../icc/iccStructure.ts';

import { deterministicCbrt } from './ieeeMath.ts';

export const D50: Xyz = { x: 0.9642, y: 1, z: 0.8249 };
const XYZ_SCALE = 1 + 32767 / 32768;
const DELTA = 6 / 29;
const CUBE_THRESHOLD = DELTA * DELTA * DELTA;
const LINEAR_DIVISOR = 3 * DELTA * DELTA;

const labForward = (value: number): number => (value > CUBE_THRESHOLD ? deterministicCbrt(value) : value / LINEAR_DIVISOR + 4 / 29);
const labInverse = (value: number): number => (value > DELTA ? value * value * value : LINEAR_DIVISOR * (value - 4 / 29));

export const xyzToLab = (xyz: readonly number[]): number[] => {
  // ICC.1:2022, Annex A Equations A.4–A.6 express PCSLAB through the D50 PCS white.
  const fx = labForward((xyz[0] ?? 0) / D50.x);
  const fy = labForward((xyz[1] ?? 0) / D50.y);
  const fz = labForward((xyz[2] ?? 0) / D50.z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

export const labToXyz = (lab: readonly number[]): number[] => {
  const fy = ((lab[0] ?? 0) + 16) / 116;
  const fx = fy + (lab[1] ?? 0) / 500;
  const fz = fy - (lab[2] ?? 0) / 200;
  return [D50.x * labInverse(fx), D50.y * labInverse(fy), D50.z * labInverse(fz)];
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const labOffset = (tag: LutTag, option: 'icc' | 'adobe'): number => (tag.kind === 'lut8' && option === 'adobe' ? 127.5 : 128);

export const encodePcs = (values: readonly number[], pcs: 'XYZ' | 'Lab', config: { tag: LutTag; option: 'icc' | 'adobe' }): number[] => {
  // ICC.1:2022, 6.3.4.2 Tables 11–13 and 10.10: mft2 uses legacy PCSLAB (FFFF/FF00 conversion) even inside v4 profiles.
  if (pcs === 'XYZ') return values.map(value => clamp(value / XYZ_SCALE));
  if (config.tag.kind === 'lut16') {
    return [clamp(((values[0] ?? 0) * 652.8) / 65535), clamp((((values[1] ?? 0) + 128) * 256) / 65535), clamp((((values[2] ?? 0) + 128) * 256) / 65535)];
  }
  const offset = labOffset(config.tag, config.option);
  return [clamp((values[0] ?? 0) / 100), clamp(((values[1] ?? 0) + offset) / 255), clamp(((values[2] ?? 0) + offset) / 255)];
};

export const decodePcs = (values: readonly number[], pcs: 'XYZ' | 'Lab', config: { tag: LutTag; option: 'icc' | 'adobe' }): number[] => {
  if (pcs === 'XYZ') return values.map(value => value * XYZ_SCALE);
  if (config.tag.kind === 'lut16') return [((values[0] ?? 0) * 65535) / 652.8, ((values[1] ?? 0) * 65535) / 256 - 128, ((values[2] ?? 0) * 65535) / 256 - 128];
  const offset = labOffset(config.tag, config.option);
  return [(values[0] ?? 0) * 100, (values[1] ?? 0) * 255 - offset, (values[2] ?? 0) * 255 - offset];
};

import { isUint8Array } from '../bytes/isUint8Array.ts';

// ICC.1:2022, 10.6, 10.10 and 10.11: curve and lut16 samples are 16-bit (0–65535) and lut8 samples 8-bit (0–255), so a sample divides by its table's maximum to land in [0, 1].
export const sampleScale = (values: Uint8Array | Uint16Array): number => (isUint8Array(values) ? 255 : 65_535);

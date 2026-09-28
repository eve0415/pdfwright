import { InvalidArgumentError } from '@pdfwright/core';

export interface BackwardBitWriter {
  write: (value: number, bits: number) => void;
  finish: () => Uint8Array;
}

/** Appends little-endian bit groups in the reverse order a Zstandard decoder reads them. */
export const createBackwardBitWriter = (): BackwardBitWriter => {
  const bytes: number[] = [];
  let bitCount = 0;
  return {
    write: (value, bits) => {
      if (!Number.isInteger(bits) || bits < 0 || bits > 24 || !Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
        throw new InvalidArgumentError('invalid Zstandard bit group');
      }
      for (let index = 0; index < bits; index++) {
        const byteIndex = Math.floor(bitCount / 8);
        bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (((value >>> index) & 1) << (bitCount % 8));
        bitCount++;
      }
    },
    finish: () => {
      // RFC 8878, 3.1.1.3.2.1.2: one final 1 bit marks the stream end; high padding bits are zero.
      const byteIndex = Math.floor(bitCount / 8);
      bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << (bitCount % 8));
      return new Uint8Array(bytes);
    },
  };
};

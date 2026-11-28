import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { seededBytes } from '../testing/seededBytes.ts';

import { adler32, updateAdler32 } from './adler32.ts';

// RFC 1950, 8.2 and 9: A is 1 plus the bytes and B the sum of each step's A, both modulo 65521, and the checksum is B * 65536 + A. Reduced after every byte, as the RFC's sample code does before its optimisation.
const reference = (data: Uint8Array): number => {
  let first = 1;
  let second = 0;
  for (const byte of data) {
    first = (first + byte) % 65_521;
    second = (second + first) % 65_521;
  }
  return second * 65_536 + first;
};

describe('adler checksum', () => {
  it('matches known checksums and processes large buffers', () => {
    expect(adler32(new Uint8Array())).toBe(1);
    expect(adler32(new TextEncoder().encode('abc'))).toBe(0x02_4d_01_27);
    expect(adler32(new Uint8Array(100_000).fill(255))).toBe(0x14_9a_30_2c);
  });

  it('continues a checksum across pieces as if the pieces were joined', () => {
    // 5,553 bytes cross the 5,552-byte step after which the sums are reduced.
    const data = seededBytes(5553 + 300, 9);
    const first = data.subarray(0, 5553);
    const rest = data.subarray(5553);
    expect([updateAdler32(adler32(first), rest), updateAdler32(updateAdler32(1, data.subarray(0, 1)), data.subarray(1))]).toStrictEqual([
      reference(data),
      reference(data),
    ]);
  });
});

describe('properties', () => {
  it('continues a checksum over any split as the reference does over the whole', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 12_000, size: 'max' }), fc.uint8Array({ maxLength: 12_000, size: 'max' }), (first, rest) => {
        const joined = new Uint8Array([...first, ...rest]);
        expect(updateAdler32(adler32(first), rest)).toBe(reference(joined));
      }),
    );
  });
});

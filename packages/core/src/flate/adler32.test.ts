import { describe, expect, it } from 'vitest';

import { adler32 } from './adler32.ts';

describe('adler checksum', () => {
  it('matches known checksums and processes large buffers', () => {
    expect(adler32(new Uint8Array())).toBe(1);
    expect(adler32(new TextEncoder().encode('abc'))).toBe(0x02_4d_01_27);
    expect(adler32(new Uint8Array(100_000).fill(255))).toBe(0x14_9a_30_2c);
  });
});

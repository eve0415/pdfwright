import { describe, expect, it } from 'vitest';

import { adler32 } from './adler32.ts';

describe('adler checksum', () => {
  it('matches known checksums and processes large buffers', () => {
    expect(adler32(new Uint8Array())).toBe(1);
    expect(adler32(new TextEncoder().encode('abc'))).toBe(0x024d0127);
    expect(adler32(new Uint8Array(100_000).fill(255))).toBe(0x149a302c);
  });
});

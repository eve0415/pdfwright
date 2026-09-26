import { describe, expect, it } from 'vitest';

import { md5 } from './md5.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const nextState = (state: number): number => {
  const signed = (Math.imul(state, 1664525) + 1013904223) % 4294967296;
  return signed < 0 ? signed + 4294967296 : signed;
};

describe('message digest', () => {
  it('matches the RFC 1321 appendix A.5 vectors', () => {
    const vectors = [
      ['', 'd41d8cd98f00b204e9800998ecf8427e'],
      ['a', '0cc175b9c0f1b6a831c399e269772661'],
      ['abc', '900150983cd24fb0d6963f7d28e17f72'],
      ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
      ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
      ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
      ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
    ];
    for (const [message, digest] of vectors) {
      const bytes = new TextEncoder().encode(message);
      expect(hex(md5(bytes))).toBe(digest);
    }
  });

  it('matches an OpenSSL digest for one MiB of fixed-seed bytes', () => {
    const bytes = new Uint8Array(1024 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < bytes.length; index++) {
      state = nextState(state);
      bytes[index] = state % 256;
    }
    expect(hex(md5(bytes))).toBe('3be900009b1e4cdeded0d446b66616d4');
  });
});

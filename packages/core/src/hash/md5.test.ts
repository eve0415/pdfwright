import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createMd5, md5 } from './md5.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const nextState = (state: number): number => {
  const signed = (Math.imul(state, 1_664_525) + 1_013_904_223) % 4_294_967_296;
  return signed < 0 ? signed + 4_294_967_296 : signed;
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

  // RFC 1321, 3.1 pads to 56 bytes modulo 64, so a final block of 55 bytes takes the length in the same block and one of 56 needs a second block.
  // Each digest is the output of `python3 -c "import sys; sys.stdout.buffer.write(b'a' * N)" | openssl md5` for that N.
  it.each([
    [55, 'ef1772b6dff9a122358552954ad0df65'],
    [56, '3b0c8ac703f828b04c6c197006d17218'],
    [57, '652b906d60af96844ebd21b674f35e93'],
    [63, 'b06521f39153d618550606be297466d5'],
    [64, '014842d480b571495a4a0363793f7367'],
    [65, 'c743a45e0d2e6a95cb859adae0248435'],
    [119, '8a7bd0732ed6a28ce75f6dabc90e1613'],
    [120, '5f61c0ccad4cac44c75ff505e1f1e537'],
  ])('matches the OpenSSL digest of %i bytes, either side of the padding boundary', (length, digest) => {
    expect(hex(md5(new Uint8Array(length).fill(0x61)))).toBe(digest);
  });

  // The digest is the output of `python3 -c "import sys; s = 0x12345678; sys.stdout.buffer.write(bytes((s := (s * 1664525 + 1013904223) % 2**32) % 256 for _ in range(1 << 20)))" | openssl md5`, which writes the same bytes.
  it('matches an OpenSSL digest for one MiB of fixed-seed bytes', () => {
    const bytes = new Uint8Array(1024 * 1024);
    let state = 0x12_34_56_78;
    for (let index = 0; index < bytes.length; index++) {
      state = nextState(state);
      bytes[index] = state % 256;
    }
    expect(hex(md5(bytes))).toBe('3be900009b1e4cdeded0d446b66616d4');
  });

  it('gives the one-shot digest when the input arrives in chunks that straddle blocks', () => {
    const bytes = new Uint8Array(4096);
    let state = 0x9e_37_79_b9;
    for (let index = 0; index < bytes.length; index++) {
      state = nextState(state);
      bytes[index] = state % 256;
    }
    for (const size of [1, 55, 56, 63, 64, 65, 200, 4096]) {
      const hash = createMd5();
      for (let offset = 0; offset < bytes.length; offset += size) {
        hash.update(bytes.subarray(offset, offset + size));
      }
      expect(hex(hash.digest()), `chunk size ${String(size)}`).toBe(hex(md5(bytes)));
    }
    const empty = createMd5().update(new Uint8Array()).digest();
    expect(hex(empty)).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('keeps hashing after a digest, as if the digest had not been taken', () => {
    const encoder = new TextEncoder();
    const hash = createMd5().update(encoder.encode('message '));
    const first = hex(hash.digest());
    const second = hex(hash.digest());
    const extended = hex(hash.update(encoder.encode('digest')).digest());
    expect([first, second, extended]).toStrictEqual([hex(md5(encoder.encode('message '))), first, 'f96b697d7cb7938d525a2f31aaf161d0']);
  });
});

describe('properties', () => {
  it('gives the one-shot digest for input split at any points', () => {
    const splitInput = fc.uint8Array({ maxLength: 400 }).chain(bytes =>
      fc.tuple(
        fc.constant(bytes),
        fc.uniqueArray(fc.integer({ min: 0, max: bytes.length }), { maxLength: 8 }).map(cuts => cuts.toSorted((left, right) => left - right)),
      ),
    );
    fc.assert(
      fc.property(splitInput, ([bytes, cuts]) => {
        const hash = createMd5();
        let start = 0;
        for (const cut of [...cuts, bytes.length]) {
          hash.update(bytes.subarray(start, cut));
          start = cut;
        }
        expect(hex(hash.digest())).toBe(hex(md5(bytes)));
      }),
    );
  });
});

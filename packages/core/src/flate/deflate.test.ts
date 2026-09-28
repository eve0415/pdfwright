import type { Runtime } from '../../../../tests/providedContext.ts';

import { unzlibSync as inflateFflate } from 'fflate';
import { deflate as deflatePako, inflate as inflatePako } from 'pako';
import { describe, expect, inject, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { ZlibDeflater, createDeflateStream, deflateRaw, deflateZlib } from './deflate.ts';
import { inflateRaw, inflateZlib } from './inflate.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const digest = (bytes: Uint8Array): string => hex(md5(bytes));

const largeData = (): Uint8Array => {
  const data = new Uint8Array(10 * 1024 * 1024);
  for (let index = 0; index < data.length; index++) data[index] = 65 + (index % 4);
  return data;
};

const randomData = (): Uint8Array => {
  const random = new Uint8Array(1024 * 1024);
  let state = 0x12345678;
  for (let index = 0; index < random.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) % 4294967296;
    if (state < 0) state += 4294967296;
    random[index] = Math.floor(state / 16777216);
  }
  return random;
};

const corpus = (includeLarge: boolean): [string, Uint8Array][] => {
  const text = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(24).slice(0, 1024));
  const items: [string, Uint8Array][] = [
    ['empty', new Uint8Array()],
    ['one-byte', new Uint8Array([123])],
    ['text', text],
    ['random', randomData()],
  ];
  if (includeLarge) items.push(['compressible', largeData()]);
  return items;
};

const expectBytes = (actual: Uint8Array, expected: Uint8Array): void => {
  expect(actual).toHaveLength(expected.length);
  let mismatch = -1;
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) {
      mismatch = index;
      break;
    }
  }
  expect(mismatch).toBe(-1);
};

describe('deterministic deflate encoding', () => {
  const runtime: Runtime = inject('runtime');

  it('round-trips levels 0 through 9 through three independent decoders', () => {
    for (const [, data] of corpus(true)) {
      for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
        const encoded = deflateZlib(data, { level });
        expect(encoded.length).toBeGreaterThan(0);
        expectBytes(inflateZlib(encoded).data, data);
        expectBytes(inflateFflate(encoded), data);
        expectBytes(inflatePako(encoded), data);
        expectBytes(deflateZlib(data, { level }), encoded);
      }
    }
  });

  it('writes stored blocks at level zero and round-trips raw deflate', () => {
    const data = new Uint8Array(200_000).fill(42);
    expectBytes(inflateRaw(deflateRaw(data, { level: 0 })), data);
    expectBytes(inflateRaw(deflateRaw(data, { level: 6 })), data);
    expect(deflateZlib(new Uint8Array(), { level: 0 }).subarray(0, 2)).toStrictEqual(new Uint8Array([0x78, 0x01]));
  });

  it('compresses data given in pieces as it compresses the pieces joined', () => {
    const data = largeData().subarray(0, 2 * 1024 * 1024 + 5);
    const pieced: string[] = [];
    const joined: string[] = [];
    for (const level of [0, 6] as const) {
      const whole = digest(deflateZlib(data, { level }));
      for (const piece of [1000, 1024 * 1024, 3 * 1024 * 1024]) {
        const deflater = new ZlibDeflater({ level });
        for (let offset = 0; offset < data.length; offset += piece) deflater.write(data.subarray(offset, offset + piece));
        const encoded = deflater.finish();
        pieced.push(digest(encoded));
        joined.push(whole);
      }
      const nothing = new ZlibDeflater({ level }).finish();
      const empty = deflateZlib(new Uint8Array(), { level });
      pieced.push(digest(nothing));
      joined.push(digest(empty));
    }
    expect(pieced).toStrictEqual(joined);
  });

  it('matches recorded level-six digests on every runtime', () => {
    const digests = new Map([
      ['empty', 'fb0fc3ab8c050179a378dcb10368acf6'],
      ['one-byte', 'e3f5fa0bc1255c21b900f168d4763893'],
      ['text', 'bbc1ae96a583a1845dd92f5f7ad9110e'],
      ['random', '859fae60d0b1c76df3aee77c8384bc59'],
      ['compressible', '8248ae32e85fd793aefe676e53e75556'],
    ]);
    for (const [name, data] of corpus(true)) {
      const encoded = deflateZlib(data);
      expect(hex(md5(encoded))).toBe(digests.get(name));
    }
  });

  it('stays within 1.10 times pako at level six on three corpora', () => {
    const text = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(24).slice(0, 1024));
    const digits = new TextEncoder().encode('0123456789'.repeat(52_429).slice(0, 512 * 1024));
    const cases = [
      ['text', text],
      ['digits', digits],
      ['random', randomData()],
    ] as const;
    for (const [name, data] of cases) {
      const ratio = deflateZlib(data).length / deflatePako(data, { level: 6 }).length;
      expect(ratio, `${name}: ${ratio.toFixed(4)}× pako`).toBeLessThanOrEqual(1.1);
    }
  });

  it.runIf(runtime === 'node')('compresses ten MiB under three seconds with pako-sized output', () => {
    const compressible = largeData();
    const started = performance.now();
    const encoded = deflateZlib(compressible);
    const elapsed = performance.now() - started;
    const ratio = encoded.length / deflatePako(compressible, { level: 6 }).length;
    expect(ratio, `compressible: ${ratio.toFixed(4)}× pako`).toBeLessThanOrEqual(1.1);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('incremental deflate output', () => {
  it('emits bounded pieces byte-identical to one-shot compression across input boundaries', () => {
    const input = Uint8Array.from({ length: 1_100_000 }, (_, index) => (index * 73 + (index >>> 8)) & 255);
    for (const level of [0, 6, 9] as const) {
      const stream = createDeflateStream({ level });
      const parts: Uint8Array[] = [];
      for (let offset = 0; offset < input.length; offset += 19_871) parts.push(...stream.push(input.subarray(offset, offset + 19_871)));
      parts.push(stream.finish());
      const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
      }
      expect(result).toStrictEqual(deflateZlib(input, { level }));
      expect(Math.max(...parts.map(part => part.length))).toBeLessThan(1_100_000);
    }
  });
});

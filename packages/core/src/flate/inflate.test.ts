import { zlibSync as compressFflate } from 'fflate';
import { deflate } from 'pako';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { inflateRaw, inflateZlib } from './inflate.ts';

const dataSet = (): Uint8Array[] => {
  const random = new Uint8Array(1024 * 1024);
  let state = 0x12345678;
  for (let index = 0; index < random.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) % 4294967296;
    if (state < 0) state += 4294967296;
    random[index] = Math.floor(state / 16777216);
  }
  const text = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(24).slice(0, 1024));
  return [new Uint8Array(), new Uint8Array([123]), text, random];
};

const largeData = (): Uint8Array => {
  const data = new Uint8Array(10 * 1024 * 1024);
  for (let index = 0; index < data.length; index++) data[index] = 65 + (index % 4);
  return data;
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

describe('zlib inflation', () => {
  it('decodes fflate and pako streams at levels 0, 1, 6 and 9', () => {
    for (const data of dataSet()) {
      for (const level of [0, 1, 6, 9] as const) {
        const fflateResult = inflateZlib(compressFflate(data, { level }));
        expect(fflateResult.warnings).toStrictEqual([]);
        expectBytes(fflateResult.data, data);
        expectBytes(inflateZlib(deflate(data, { level })).data, data);
      }
    }
  });

  it('decodes ten MiB of highly compressible data', () => {
    const data = largeData();
    for (const level of [0, 1, 6, 9] as const) {
      const fflateResult = inflateZlib(compressFflate(data, { level }));
      expect(fflateResult.warnings).toStrictEqual([]);
      expectBytes(fflateResult.data, data);
      expectBytes(inflateZlib(deflate(data, { level })).data, data);
    }
  });

  it('decodes raw deflate and warns about bytes after the checksum', () => {
    const data = new TextEncoder().encode('hello hello hello');
    const compressed = compressFflate(data);
    expect(inflateRaw(compressed.subarray(2, -4))).toStrictEqual(data);
    const newline = new Uint8Array([...compressed, 10]);
    expect(inflateZlib(newline).warnings.map(warning => warning.code)).toStrictEqual(['trailing-data']);
    const garbage = new Uint8Array([...compressed, 1, 2, 3]);
    expect(inflateZlib(garbage).warnings.map(warning => warning.code)).toStrictEqual(['trailing-data']);
  });

  it('returns decoded data when the Adler trailer is truncated or wrong', () => {
    const data = new TextEncoder().encode('payload');
    const compressed = compressFflate(data);
    for (const cut of [-4, -3, -1]) {
      const result = inflateZlib(compressed.subarray(0, cut));
      expect(result.warnings.map(warning => warning.code)).toStrictEqual(['truncated-trailer']);
      expect(result.data).toStrictEqual(data);
    }
    const corrupted = Uint8Array.from(compressed);
    corrupted.fill(0, -1);
    expect(inflateZlib(corrupted).warnings.map(warning => warning.code)).toStrictEqual(['checksum-mismatch']);
  });

  it('rejects truncated blocks and preset dictionaries', () => {
    const compressed = compressFflate(new TextEncoder().encode('incomplete block '.repeat(100)));
    expect(() => inflateZlib(compressed.subarray(0, 5))).toThrow(ParseError);
    const dictionaryHeader = new Uint8Array([0x78, 0x20]);
    expect(() => inflateZlib(dictionaryHeader)).toThrow(UnsupportedFeatureError);
  });
});

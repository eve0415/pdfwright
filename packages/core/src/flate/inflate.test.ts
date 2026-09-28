import type { FlateWarning } from './inflate.ts';

import { zlibSync as compressFflate } from 'fflate';
import { deflate } from 'pako';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { BitWriter } from './bitWriter.ts';
import { deflateZlib } from './deflate.ts';
import { canonicalCodes } from './huffmanEncoder.ts';
import { inflateChunks, inflateRaw, inflateZlib } from './inflate.ts';

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

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const lengths = (count: number, used: Record<number, number>): number[] => Array.from({ length: count }, (_, symbol) => used[symbol] ?? 0);

// One final dynamic block whose code lengths use four-bit codes for lengths 0-15, followed by the given literal/length symbols.
const dynamicBlock = (literal: number[], distance: number[], symbols: number[]): Uint8Array => {
  const writer = new BitWriter();
  writer.writeBits(0b101, 3);
  writer.writeBits(literal.length - 257, 5);
  writer.writeBits(distance.length - 1, 5);
  writer.writeBits(19 - 4, 4);
  const codeLengths = lengths(19, Object.fromEntries(Array.from({ length: 16 }, (_, symbol) => [symbol, 4])));
  for (const symbol of CODE_LENGTH_ORDER) writer.writeBits(codeLengths[symbol] ?? 0, 3);
  const codeCodes = canonicalCodes(codeLengths);
  for (const length of [...literal, ...distance]) writer.writeBits(codeCodes[length] ?? 0, 4);
  const literalCodes = canonicalCodes(literal);
  for (const symbol of symbols) writer.writeBits(literalCodes[symbol] ?? 0, literal[symbol] ?? 0);
  return writer.finish();
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

  it('stops at the output limit for literal, copied and stored bytes', () => {
    const zeros = new Uint8Array(1024 * 1024);
    for (const level of [0, 6] as const) {
      const compressed = compressFflate(zeros, { level });
      expect(() => inflateZlib(compressed, { maxOutputBytes: 1000 })).toThrow(ResourceLimitError);
      expect(() => inflateRaw(compressed.subarray(2, -4), { maxOutputBytes: zeros.length - 1 })).toThrow(ResourceLimitError);
      expect(inflateZlib(compressed, { maxOutputBytes: zeros.length }).data).toHaveLength(zeros.length);
    }
    expect(() => inflateZlib(compressFflate(new Uint8Array([1])), { maxOutputBytes: 0 })).toThrow(ResourceLimitError);
    for (const maxOutputBytes of [-1, 1.5, Number.NaN]) expect(() => inflateRaw(new Uint8Array([3, 0]), { maxOutputBytes })).toThrow(InvalidArgumentError);
  });

  it('rejects more literal/length or distance codes than zlib accepts', () => {
    const literalOnly = lengths(257, { 65: 1, 256: 1 });
    const thirtyDistances = dynamicBlock(literalOnly, lengths(30, { 0: 1 }), [65, 256]);
    expect(inflateRaw(thirtyDistances)).toStrictEqual(new Uint8Array([65]));
    for (const literalCount of [287, 288]) {
      const block = dynamicBlock(lengths(literalCount, { 65: 1, 256: 1 }), [0], [65, 256]);
      expect(() => inflateRaw(block)).toThrow(/literal\/length codes/u);
    }
    for (const distanceCount of [31, 32]) {
      const block = dynamicBlock(literalOnly, lengths(distanceCount, { 0: 1 }), [65, 256]);
      expect(() => inflateRaw(block)).toThrow(/distance codes/u);
    }
  });

  it('decodes literals with an empty distance tree and names its misuse', () => {
    const literals = dynamicBlock(lengths(257, { 65: 1, 256: 1 }), [0], [65, 65, 256]);
    expect(inflateRaw(literals)).toStrictEqual(new Uint8Array([65, 65]));
    const lengthSymbol = dynamicBlock(lengths(258, { 65: 2, 256: 2, 257: 1 }), [0], [65, 257, 256]);
    expect(() => inflateRaw(lengthSymbol)).toThrow(ParseError);
    expect(() => inflateRaw(lengthSymbol)).toThrow(/^distance code used with an empty distance tree$/u);
  });

  it('rejects truncated blocks and preset dictionaries', () => {
    const compressed = compressFflate(new TextEncoder().encode('incomplete block '.repeat(100)));
    expect(() => inflateZlib(compressed.subarray(0, 5))).toThrow(ParseError);
    const dictionaryHeader = new Uint8Array([0x78, 0x20]);
    expect(() => inflateZlib(dictionaryHeader)).toThrow(UnsupportedFeatureError);
  });
});

describe('chunked zlib inflate', () => {
  it('reports trailer warnings while returning decoded chunks', () => {
    const input = new TextEncoder().encode('stream payload');
    const compressed = deflateZlib(input);
    const corrupted = Uint8Array.from(compressed);
    corrupted[corrupted.length - 1] = 0;
    for (const { data, code } of [
      { data: compressed.subarray(0, -2), code: 'truncated-trailer' },
      { data: corrupted, code: 'checksum-mismatch' },
      { data: Uint8Array.from([...compressed, 0]), code: 'trailing-data' },
    ]) {
      const warnings: FlateWarning[] = [];
      const chunks = [
        ...inflateChunks(data, {
          onWarning: warning => {
            warnings.push(warning);
          },
        }),
      ];
      const restored = new Uint8Array(input.length);
      let offset = 0;
      for (const chunk of chunks) {
        restored.set(chunk, offset);
        offset += chunk.length;
      }
      expect(restored).toStrictEqual(input);
      expect(warnings.map(warning => warning.code)).toStrictEqual([code]);
    }
  });

  it('rejects malformed later blocks before yielding earlier decoded bytes', () => {
    const bytes = new Uint8Array(2 + 5 + 65535 + 6 + 1 + 4);
    bytes.set([0x78, 0x01, 0, 255, 255, 0, 0]);
    bytes.fill(65, 7, 7 + 65535);
    bytes.set([0, 1, 0, 254, 255, 65, 7], 7 + 65535);
    const stream = inflateChunks(bytes);
    expect(() => stream.next()).toThrow(ParseError);
  });

  it('yields bounded decoded chunks across long distance references', () => {
    const input = Uint8Array.from({ length: 1_100_000 }, (_, index) => (index * 31 + (index >>> 8)) & 255);
    const chunks = [...inflateChunks(deflateZlib(input))];
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(65536);
    const restored = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      restored.set(chunk, offset);
      offset += chunk.length;
    }
    expect(restored).toStrictEqual(input);
    expect(() => [...inflateChunks(deflateZlib(input), { maxOutputBytes: 1000 })]).toThrow(ResourceLimitError);
  });
});

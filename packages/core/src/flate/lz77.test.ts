import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { seededBytes } from '../testing/seededBytes.ts';

import { matchToken, tokenize } from './lz77.ts';
import { DISTANCE_BASE, DISTANCE_EXTRA, LENGTH_BASE, LENGTH_EXTRA } from './tables.ts';

type Token = number | readonly [length: number, distance: number];

// An extra value is written with only as many bits as its symbol takes (RFC 1951, 3.2.5), so a value that needs more is not representable.
const extraValue = (value: number, bits: number): number => (value < 2 ** bits ? value : Number.NaN);

// Reads a token back through the layout matchToken documents: bits 0-8 the literal/length symbol, 9-13 the distance symbol, 14-18 the length extra value and 19-31 the distance extra value, with the bases and extra-bit counts of RFC 1951, 3.2.5.
const decodeToken = (token: number): Token => {
  const symbol = token & 511;
  if (symbol < 256) {
    return symbol;
  }
  const distanceSymbol = (token >>> 9) & 31;
  return [
    (LENGTH_BASE[symbol - 257] ?? Number.NaN) + extraValue((token >>> 14) & 31, LENGTH_EXTRA[symbol - 257] ?? 0),
    (DISTANCE_BASE[distanceSymbol] ?? Number.NaN) + extraValue(token >>> 19, DISTANCE_EXTRA[distanceSymbol] ?? 0),
  ];
};

const tokens = (data: Uint8Array, level: number): Array<Token> => {
  const words = new Uint32Array(data.length);
  const count = tokenize(data, level, words);
  return [...words.subarray(0, count)].map(decodeToken);
};

// Rebuilds the bytes a token list stands for, as an inflater would.
const replay = (list: ReadonlyArray<Token>): Uint8Array => {
  const bytes: Array<number> = [];
  for (const token of list) {
    if (typeof token === 'number') {
      bytes.push(token);
    } else {
      const [length, distance] = token;
      const start = bytes.length - distance;
      for (let index = 0; index < length; index++) {
        bytes.push(bytes[start + index] ?? Number.NaN);
      }
    }
  }
  return Uint8Array.from(bytes);
};

// 258 bytes below 128, a gap of bytes from 128 up, and the 258 bytes again, so that the only match reaching the repeat is the whole repeat.
const repeatedAfter = (distance: number): Uint8Array => {
  const repeated = seededBytes(258, 1).map(byte => byte & 127);
  const gap = seededBytes(distance - 258, 2).map(byte => byte | 128);
  return new Uint8Array([...repeated, ...gap, ...repeated]);
};

const farMatches = (list: ReadonlyArray<Token>): Array<Token> => list.filter(token => typeof token !== 'number' && token[1] > 32_000);

describe('LZ77 tokens', () => {
  // RFC 1951, 3.2: "distances are limited to 32K bytes".
  it('uses a match exactly 32,768 bytes back', () => {
    const data = repeatedAfter(32_768);
    const list = tokens(data, 9);
    expect([replay(list), farMatches(list)]).toStrictEqual([data, [[258, 32_768]]]);
  });

  it('does not use a repeat 32,769 bytes back', () => {
    const data = repeatedAfter(32_769);
    const list = tokens(data, 9);
    expect([replay(list), farMatches(list)]).toStrictEqual([data, []]);
  });

  // RFC 1951, 3.2.5: match lengths run from 3 to 258.
  it('covers a run of one byte with matches of at most 258 bytes, ending with what remains', () => {
    expect(tokens(new Uint8Array(600).fill(7), 1)).toStrictEqual([7, [258, 1], [258, 1], [83, 1]]);
  });

  // RFC 1951, 3.2.5: length 257 is symbol 284 with extra value 30 and length 258 is symbol 285 with no extra bits; distance 32,768 is symbol 29 with extra value 8,191.
  it.each([
    [258, 32_768, 285, 29, 0, 8191],
    [257, 1, 284, 0, 30, 0],
    [3, 4, 257, 3, 0, 0],
    [11, 5, 265, 4, 0, 0],
  ])(
    'encodes length %i at distance %i as symbol %i, distance symbol %i and extra values %i and %i',
    (length, distance, symbol, distanceSymbol, lengthExtra, distanceExtra) => {
      expect(matchToken(length, distance)).toBe(symbol | (distanceSymbol << 9) | (lengthExtra << 14) | (distanceExtra << 19));
    },
  );
});

describe('properties', () => {
  it('decodes every length with the distances at the edges of each distance code back to itself', () => {
    const distances = [1, 4, 5, 256, 257, 384, 385, 24_577, 32_768];
    const pairs = Array.from({ length: 256 }, (_, index) => index + 3).flatMap(length => distances.map(distance => [length, distance] as const));
    expect(pairs.map(([length, distance]) => decodeToken(matchToken(length, distance)))).toStrictEqual(pairs);
  });

  it('decodes any length and distance RFC 1951 allows back to itself', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 258 }), fc.integer({ min: 1, max: 32_768 }), (length, distance) => {
        expect(decodeToken(matchToken(length, distance))).toStrictEqual([length, distance]);
      }),
    );
  });

  it('writes tokens that replay to the input at every level', () => {
    const input = fc.oneof(fc.uint8Array({ maxLength: 2048 }), fc.uint8Array({ max: 3, maxLength: 4096 }));
    fc.assert(
      fc.property(input, fc.integer({ min: 0, max: 9 }), (data, level) => {
        expect(replay(tokens(data, level))).toStrictEqual(data);
      }),
    );
  });
});

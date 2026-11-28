import type { Runtime } from '../../../../tests/providedContext.ts';
import type { DeflateOptions } from './deflate.ts';

import fc from 'fast-check';
import { unzlibSync as inflateFflate } from 'fflate';
import { deflate as deflatePako, inflate as inflatePako, inflateRaw as inflateRawPako } from 'pako';
import { describe, expect, inject, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { md5 } from '../hash/md5.ts';

import { ZlibDeflater, createDeflateStream, deflateRaw, deflateZlib } from './deflate.ts';
import { inflateRaw, inflateZlib } from './inflate.ts';
import { comparison, concat, foxText, largeData, randomData } from './testData.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const digest = (bytes: Uint8Array): string => hex(md5(bytes));

const corpus = (includeLarge: boolean): Array<[string, Uint8Array]> => {
  const items: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array()],
    ['one-byte', new Uint8Array([123])],
    ['text', foxText()],
    ['random', randomData()],
  ];
  if (includeLarge) {
    items.push(['compressible', largeData()]);
  }
  return items;
};

const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

// Options a JavaScript caller can pass although the type admits only the levels 0 to 9.
const invalidLevel = (level: number): DeflateOptions => ({
  // @ts-expect-error The level type admits only 0 to 9, and these tests pass values outside it.
  level,
});

// RFC 1951, 3.2.4: a stored block is the 3-bit header padded to a byte, LEN and its one's complement NLEN, both least-significant byte first, then LEN bytes of data.
const storedBlock = (header: number, payload: Uint8Array): Uint8Array =>
  concat([Uint8Array.of(header, payload.length & 255, payload.length >>> 8, ~payload.length & 255, (~payload.length >>> 8) & 255), payload]);

describe('deterministic deflate encoding', () => {
  const runtime: Runtime = inject('runtime');

  it('round-trips levels 0 through 9 through three independent decoders', () => {
    for (const [, data] of corpus(true)) {
      for (const level of LEVELS) {
        const encoded = deflateZlib(data, { level });
        expect(encoded.length).toBeGreaterThan(0);
        expect(comparison(inflateZlib(encoded).data, data)).toStrictEqual([data.length, -1]);
        expect(comparison(inflateFflate(encoded), data)).toStrictEqual([data.length, -1]);
        expect(comparison(inflatePako(encoded), data)).toStrictEqual([data.length, -1]);
        expect(comparison(deflateZlib(data, { level }), encoded)).toStrictEqual([encoded.length, -1]);
      }
    }
  }, 60_000);

  it('writes level zero as stored blocks of at most 65,535 bytes, the last one marked final', () => {
    const data = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 7 + (index >>> 9)) & 255);
    const expected = concat([
      storedBlock(0x00, data.subarray(0, 65_535)),
      storedBlock(0x00, data.subarray(65_535, 131_070)),
      storedBlock(0x00, data.subarray(131_070, 196_605)),
      storedBlock(0x01, data.subarray(196_605)),
    ]);
    expect(expected).toHaveLength(200_000 + 4 * 5);
    expect(expected.subarray(196_605 + 15, 196_605 + 20)).toStrictEqual(Uint8Array.of(0x01, 0x43, 0x0d, 0xbc, 0xf2));
    expect(comparison(deflateRaw(data, { level: 0 }), expected)).toStrictEqual([expected.length, -1]);
    expect(comparison(deflateZlib(data, { level: 0 }).subarray(2, -4), expected)).toStrictEqual([expected.length, -1]);
    expect(comparison(inflateRaw(deflateRaw(data, { level: 6 })), data)).toStrictEqual([data.length, -1]);
  });

  // RFC 1951, 3.2.3: BTYPE is bits 1-2 of the first byte, 00 for stored, 01 for fixed and 10 for dynamic Huffman codes.
  it.each([
    ['a stored block at level 0', Uint8Array.of(97), 0, 0],
    ['a fixed block for one byte', Uint8Array.of(97), 6, 1],
    ['a fixed block for text made mostly of matches', foxText(), 6, 1],
    [
      'a dynamic block for text with no repeated sequence',
      new TextEncoder().encode('Pack my box with five dozen liquor jugs; how vexingly quick daft zebras jump!'),
      6,
      2,
    ],
  ] as const)('writes %s', (_, data, level, blockType) => {
    const first = deflateRaw(data, { level })[0] ?? -1;
    expect([first & 1, (first >>> 1) & 3]).toStrictEqual([1, blockType]);
  });

  it('writes no input at level six as the empty final fixed block', () => {
    // RFC 1951, 3.2.6: BFINAL 1, BTYPE 01, then the seven zero bits of end-of-block code 256.
    expect(deflateRaw(new Uint8Array())).toStrictEqual(Uint8Array.of(0x03, 0x00));
  });

  // RFC 1950, 2.2: FLEVEL 0 is the fastest algorithm, 1 fast, 2 the default and 3 the maximum compression, and FCHECK makes CMF * 256 + FLG a multiple of 31.
  it.each([
    [0, 0x01],
    [1, 0x01],
    [2, 0x5e],
    [5, 0x5e],
    [6, 0x9c],
    [7, 0xda],
    [9, 0xda],
  ] as const)('writes the zlib header flag byte for level %i', (level, flag) => {
    expect(deflateZlib(new Uint8Array(), { level }).subarray(0, 2)).toStrictEqual(Uint8Array.of(0x78, flag));
    expect([...new ZlibDeflater({ level }).finish().subarray(0, 2)]).toStrictEqual([0x78, flag]);
  });

  it('compresses data given in pieces as it compresses the pieces joined', () => {
    const data = largeData().subarray(0, 2 * 1024 * 1024 + 5);
    const pieced: Array<string> = [];
    const joined: Array<string> = [];
    for (const level of [0, 6] as const) {
      const whole = digest(deflateZlib(data, { level }));
      for (const piece of [1000, 1024 * 1024, 3 * 1024 * 1024]) {
        const deflater = new ZlibDeflater({ level });
        for (let offset = 0; offset < data.length; offset += piece) {
          deflater.write(data.subarray(offset, offset + piece));
        }
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

  // At level 0 ZlibDeflater buffers sixteen stored blocks, 1,048,560 bytes, before it writes them.
  it.each([65_535, 65_536, 1_048_560, 1_048_561])('round-trips %i bytes at level 0 through raw and zlib streams', length => {
    const data = Uint8Array.from({ length }, (_, index) => (index * 13 + (index >>> 16)) & 255);
    expect(comparison(inflateRaw(deflateRaw(data, { level: 0 })), data)).toStrictEqual([length, -1]);
    expect(comparison(inflateRawPako(deflateRaw(data, { level: 0 })), data)).toStrictEqual([length, -1]);
    expect(inflateZlib(deflateZlib(data, { level: 0 })).warnings).toStrictEqual([]);
    expect(comparison(inflateFflate(deflateZlib(data, { level: 0 })), data)).toStrictEqual([length, -1]);
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
    const digits = new TextEncoder().encode('0123456789'.repeat(52_429).slice(0, 512 * 1024));
    const cases = [
      ['text', foxText()],
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

describe('compression level validation', () => {
  const entries = [
    [
      'deflateRaw',
      (options: DeflateOptions): void => {
        deflateRaw(Uint8Array.of(1), options);
      },
    ],
    [
      'deflateZlib',
      (options: DeflateOptions): void => {
        deflateZlib(Uint8Array.of(1), options);
      },
    ],
    [
      'ZlibDeflater',
      (options: DeflateOptions): void => {
        new ZlibDeflater(options).finish();
      },
    ],
    [
      'createDeflateStream',
      (options: DeflateOptions): void => {
        createDeflateStream(options).finish();
      },
    ],
  ] as const;

  it.each(entries.flatMap(([name, call]) => [10, -1, 1.5].map(level => [name, level, call] as const)))('%s refuses level %d', (_, level, call) => {
    expect(() => {
      call(invalidLevel(level));
    }).toThrow(InvalidArgumentError);
  });

  it.each(entries)('%s accepts the levels 0 and 9 at both ends of the range', (_, call) => {
    expect(() => {
      call({ level: 0 });
      call({ level: 9 });
    }).not.toThrow();
  });
});

describe('incremental deflate output', () => {
  it('emits bounded pieces byte-identical to one-shot compression across input boundaries', () => {
    const input = Uint8Array.from({ length: 1_100_000 }, (_, index) => (index * 73 + (index >>> 8)) & 255);
    for (const level of [0, 6, 9] as const) {
      const stream = createDeflateStream({ level });
      const parts: Array<Uint8Array> = [];
      for (let offset = 0; offset < input.length; offset += 19_871) {
        parts.push(...stream.push(input.subarray(offset, offset + 19_871)));
      }
      parts.push(stream.finish());
      expect(concat(parts)).toStrictEqual(deflateZlib(input, { level }));
      expect(Math.max(...parts.map(part => part.length))).toBeLessThanOrEqual(1024 * 1024 + 64);
    }
  }, 60_000);

  it('refuses a push or a second finish after the stream is finished', () => {
    const pushed = createDeflateStream();
    pushed.finish();
    expect(() => pushed.push(Uint8Array.of(1))).toThrow(InvalidArgumentError);
    const finished = createDeflateStream();
    finished.finish();
    expect(() => finished.finish()).toThrow(InvalidArgumentError);
  });

  it('accepts pushes before the stream is finished', () => {
    const stream = createDeflateStream();
    const parts = [...stream.push(Uint8Array.of(1)), ...stream.push(Uint8Array.of(2)), stream.finish()];
    expect(inflateZlib(concat(parts))).toStrictEqual({ data: Uint8Array.of(1, 2), warnings: [] });
  });
});

describe('properties', () => {
  // Bytes drawn from four values repeat often enough to produce matches and dynamic Huffman blocks; unrestricted bytes mostly do not.
  const input = fc.oneof(fc.uint8Array({ maxLength: 2048, size: 'max' }), fc.uint8Array({ max: 3, maxLength: 4096, size: 'max' }));
  const level = fc.constantFrom(...LEVELS);

  it('inflates what it deflates at every level', () => {
    fc.assert(
      fc.property(input, level, (data, chosen) => {
        expect(inflateZlib(deflateZlib(data, { level: chosen }))).toStrictEqual({ data, warnings: [] });
      }),
    );
  });

  it('writes streams two independent decoders inflate to the input, raw and zlib, at every level', () => {
    fc.assert(
      fc.property(input, level, (data, chosen) => {
        const raw = deflateRaw(data, { level: chosen });
        const zlib = deflateZlib(data, { level: chosen });
        expect([inflateRaw(raw), inflateRawPako(raw), inflatePako(zlib), inflateFflate(zlib)]).toStrictEqual([data, data, data, data]);
      }),
    );
  });

  it('writes the same zlib stream for any split of the input into pieces', () => {
    const pieced = input.chain(data =>
      fc.tuple(
        fc.constant(data),
        fc.uniqueArray(fc.integer({ min: 0, max: data.length }), { maxLength: 8, size: 'max' }).map(cuts => cuts.toSorted((left, right) => left - right)),
      ),
    );
    fc.assert(
      fc.property(pieced, level, ([data, cuts], chosen) => {
        const bounds = [0, ...cuts, data.length];
        const pieces = bounds.slice(1).map((end, index) => data.subarray(bounds[index], end));
        const deflater = new ZlibDeflater({ level: chosen });
        const stream = createDeflateStream({ level: chosen });
        const streamed: Array<Uint8Array> = [];
        for (const piece of pieces) {
          deflater.write(piece);
          streamed.push(...stream.push(piece));
        }
        streamed.push(stream.finish());
        const whole = deflateZlib(data, { level: chosen });
        expect([deflater.finish(), concat(streamed)]).toStrictEqual([whole, whole]);
      }),
    );
  });
});

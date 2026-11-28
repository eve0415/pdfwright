import type { FlateWarning } from './inflate.ts';

import fc from 'fast-check';
import { zlibSync as compressFflate } from 'fflate';
import { deflate } from 'pako';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { adler32 } from './adler32.ts';
import { BitWriter } from './bitWriter.ts';
import { deflateZlib } from './deflate.ts';
import { canonicalCodes } from './huffmanEncoder.ts';
import { inflateChunks, inflateRaw, inflateZlib } from './inflate.ts';
import { comparison, concat, foxText, largeData, randomData } from './testData.ts';

const dataSet = (): Array<Uint8Array> => [new Uint8Array(), new Uint8Array([123]), foxText(), randomData()];

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// The code-length code of the hand-built dynamic blocks: symbols 0-12 take four bits and 13-18 five, which fills the code space exactly.
const CODE_LENGTH_LENGTHS = Array.from({ length: 19 }, (_, symbol) => (symbol <= 12 ? 4 : 5));

// RFC 1951, 3.2.7: repeat code 16 takes 2 extra bits, 17 takes 3 and 18 takes 7.
const REPEAT_BITS = new Map([
  [16, 2],
  [17, 3],
  [18, 7],
]);

const lengths = (count: number, used: Record<number, number>): Array<number> => Array.from({ length: count }, (_, symbol) => used[symbol] ?? 0);

type Run = readonly [symbol: number, extra: number];

interface DynamicExtras {
  // The code-length symbols with their extra values, in place of one symbol per code length.
  readonly runs?: ReadonlyArray<Run>;
  // Bits written after the symbols, as [value, count].
  readonly tail?: readonly [number, number];
}

/**
 * One final dynamic block (RFC 1951, 3.2.7) with the given literal/length and distance code lengths, followed by the given literal/length symbols.
 * The builder takes its codes from the library's canonicalCodes, so a bit-order defect shared by it and the decoder would pass here; the round trips through pako and fflate catch that class instead.
 */
const dynamicBlock = (literal: Array<number>, distance: Array<number>, symbols: Array<number>, extras: DynamicExtras = {}): Uint8Array => {
  const writer = new BitWriter();
  writer.writeBits(0b101, 3);
  writer.writeBits(literal.length - 257, 5);
  writer.writeBits(distance.length - 1, 5);
  writer.writeBits(19 - 4, 4);
  for (const symbol of CODE_LENGTH_ORDER) {
    writer.writeBits(CODE_LENGTH_LENGTHS[symbol] ?? 0, 3);
  }
  const codeCodes = canonicalCodes(CODE_LENGTH_LENGTHS);
  const runs = extras.runs ?? [...literal, ...distance].map((length): Run => [length, 0]);
  for (const [symbol, extra] of runs) {
    writer.writeBits(codeCodes[symbol] ?? 0, CODE_LENGTH_LENGTHS[symbol] ?? 0);
    writer.writeBits(extra, REPEAT_BITS.get(symbol) ?? 0);
  }
  const literalCodes = canonicalCodes(literal);
  for (const symbol of symbols) {
    writer.writeBits(literalCodes[symbol] ?? 0, literal[symbol] ?? 0);
  }
  if (extras.tail !== undefined) {
    writer.writeBits(...extras.tail);
  }
  return writer.finish();
};

// RFC 1951, 3.1.1: Huffman codes are packed starting with their most-significant bit.
const writeCode = (writer: BitWriter, code: number, length: number): void => {
  for (let bit = length - 1; bit >= 0; bit--) {
    writer.writeBits((code >>> bit) & 1, 1);
  }
};

type Write = (writer: BitWriter) => void;

// RFC 1951, 3.2.6: the fixed literal/length codes are 00110000 plus the symbol for 0-143, 110010000 plus symbol - 144 for 144-255, seven bits of symbol - 256 for 256-279 and 11000000 plus symbol - 280 for 280-287.
const fixedSymbol =
  (symbol: number): Write =>
  writer => {
    if (symbol < 144) {
      writeCode(writer, 0b0011_0000 + symbol, 8);
    } else if (symbol < 256) {
      writeCode(writer, 0b1_1001_0000 + symbol - 144, 9);
    } else if (symbol < 280) {
      writeCode(writer, symbol - 256, 7);
    } else {
      writeCode(writer, 0b1100_0000 + symbol - 280, 8);
    }
  };

// RFC 1951, 3.2.6: fixed distance codes are the five-bit symbol.
const fixedDistance =
  (symbol: number): Write =>
  writer => {
    writeCode(writer, symbol, 5);
  };

/** One final fixed-code block (BFINAL 1, BTYPE 01) holding the given codes. */
const fixedBlock = (...codes: Array<Write>): Uint8Array => {
  const writer = new BitWriter();
  writer.writeBits(1, 1);
  writer.writeBits(1, 2);
  for (const code of codes) {
    code(writer);
  }
  return writer.finish();
};

// RFC 1950, 2.2: a zlib stream is CMF 78, an FLG that makes the header a multiple of 31, the raw deflate data and the Adler-32 of the decoded data, most-significant byte first.
const zlib = (raw: Uint8Array, decoded: Uint8Array = new Uint8Array()): Uint8Array => {
  const checksum = adler32(decoded);
  return concat([Uint8Array.of(0x78, 0x01), raw, Uint8Array.of(checksum >>> 24, (checksum >>> 16) & 255, (checksum >>> 8) & 255, checksum & 255)]);
};

const chunked = (data: Uint8Array): Uint8Array => concat([...inflateChunks(data)]);

// The calls that decode raw deflate data (when given) and its zlib form through each decoder.
const decoders = (raw: Uint8Array | undefined, wrapped: Uint8Array): Array<() => void> => [
  ...(raw === undefined
    ? []
    : [
        (): void => {
          inflateRaw(raw);
        },
      ]),
  (): void => {
    inflateZlib(wrapped);
  },
  (): void => {
    chunked(wrapped);
  },
];

type Outcome<T> = { readonly value: T } | { readonly error: string };

// What a decode returned, or the name of the error it threw, so that two decoders can be compared on both.
const outcome = <T>(decode: () => T): Outcome<T> => {
  try {
    return { value: decode() };
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'not an Error' };
  }
};

const literalOnly = lengths(257, { 65: 1, 256: 1 });

// Code-length runs for literalOnly, with code lengths at symbols 65 and 256 and zeros elsewhere: 65 zeros, a 1, 190 zeros and a 1.
const literalOnlyRuns: ReadonlyArray<Run> = [
  [18, 54],
  [1, 0],
  [18, 127],
  [18, 41],
  [1, 0],
];

// Raw deflate data that both decoders must refuse, with what the refusal names, and below them the nearest data they must accept.
const malformedRaw: ReadonlyArray<readonly [string, Uint8Array, RegExp]> = [
  ['the reserved block type 11', Uint8Array.of(0x07), /reserved deflate block type/u],
  ['a stored block whose NLEN is not the complement of LEN', Uint8Array.of(0x01, 0x03, 0x00, 0xfd, 0xff, 1, 2, 3), /invalid stored block length/u],
  ['a stored block holding 3 of its 10 bytes', Uint8Array.of(0x01, 0x0a, 0x00, 0xf5, 0xff, 1, 2, 3), /truncated deflate stream/u],
  ['a match before any output', fixedBlock(fixedSymbol(257), fixedDistance(0), fixedSymbol(256)), /invalid backward distance/u],
  [
    'a distance one past the output so far',
    fixedBlock(fixedSymbol(65), fixedSymbol(66), fixedSymbol(257), fixedDistance(2), fixedSymbol(256)),
    /invalid backward distance/u,
  ],
  ['the fixed length symbol 286', fixedBlock(fixedSymbol(65), fixedSymbol(286), fixedSymbol(256)), /invalid length code/u],
  ['the fixed length symbol 287', fixedBlock(fixedSymbol(65), fixedSymbol(287), fixedSymbol(256)), /invalid length code/u],
  ['the fixed distance symbol 30', fixedBlock(fixedSymbol(65), fixedSymbol(257), fixedDistance(30), fixedSymbol(256)), /invalid distance code/u],
  ['the fixed distance symbol 31', fixedBlock(fixedSymbol(65), fixedSymbol(257), fixedDistance(31), fixedSymbol(256)), /invalid distance code/u],
  ['a dynamic block with no end-of-block code', dynamicBlock(lengths(257, { 65: 1, 66: 1 }), [0], [65, 66]), /end-of-block/u],
  [
    'a repeat code 16 as the first code length',
    dynamicBlock(literalOnly, [0], [65, 256], {
      runs: [
        [16, 0],
        [18, 51],
        [1, 0],
        [18, 127],
        [18, 41],
        [1, 0],
        [0, 0],
      ],
    }),
    /previous code length/u,
  ],
  ['a repeat past HLIT + HDIST', dynamicBlock(literalOnly, [0, 0, 0], [65, 256], { runs: [...literalOnlyRuns, [17, 1]] }), /too many code lengths/u],
  ['an oversubscribed literal/length tree', dynamicBlock(lengths(257, { 65: 1, 66: 1, 256: 1 }), [0], [65, 256]), /oversubscribed/u],
  ['an incomplete tree read at an unassigned code', dynamicBlock(lengths(257, { 65: 2, 256: 2 }), [0], [65], { tail: [0b11, 2] }), /invalid Huffman code/u],
  ['HLIT 287', dynamicBlock(lengths(287, { 65: 1, 256: 1 }), [0], [65, 256]), /literal\/length codes/u],
  ['HDIST 31', dynamicBlock(literalOnly, lengths(31, { 0: 1 }), [65, 256]), /distance codes/u],
  ['a length symbol with an empty distance tree', dynamicBlock(lengths(258, { 65: 2, 256: 2, 257: 1 }), [0], [65, 257, 256]), /empty distance tree/u],
];

const acceptedRaw: ReadonlyArray<readonly [string, Uint8Array, Uint8Array]> = [
  [
    'a stored block holding all 10 of its bytes',
    Uint8Array.of(0x01, 0x0a, 0x00, 0xf5, 0xff, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
  ],
  ['a stored block whose NLEN is the complement of LEN', Uint8Array.of(0x01, 0x03, 0x00, 0xfc, 0xff, 1, 2, 3), Uint8Array.of(1, 2, 3)],
  [
    'a distance equal to the output so far',
    fixedBlock(fixedSymbol(65), fixedSymbol(66), fixedSymbol(257), fixedDistance(1), fixedSymbol(256)),
    new TextEncoder().encode('ABABA'),
  ],
  ['an overlapping match of distance 1', fixedBlock(fixedSymbol(65), fixedSymbol(257), fixedDistance(0), fixedSymbol(256)), new TextEncoder().encode('AAAA')],
  ['the last fixed length symbol 285', fixedBlock(fixedSymbol(65), fixedSymbol(285), fixedDistance(0), fixedSymbol(256)), new Uint8Array(259).fill(65)],
  [
    'the last fixed distance symbol 29',
    fixedBlock(
      ...Array.from({ length: 24_577 }, () => fixedSymbol(66)),
      fixedSymbol(257),
      fixedDistance(29),
      (writer: BitWriter): void => {
        writer.writeBits(0, 13);
      },
      fixedSymbol(256),
    ),
    new Uint8Array(24_580).fill(66),
  ],
  [
    'three zero code lengths in place of the leading repeat code',
    dynamicBlock(literalOnly, [0], [65, 256], {
      runs: [
        [0, 0],
        [0, 0],
        [0, 0],
        [18, 51],
        [1, 0],
        [18, 127],
        [18, 41],
        [1, 0],
        [0, 0],
      ],
    }),
    Uint8Array.of(65),
  ],
  ['a repeat that ends exactly at HLIT + HDIST', dynamicBlock(literalOnly, [0, 0, 0], [65, 256], { runs: [...literalOnlyRuns, [17, 0]] }), Uint8Array.of(65)],
  ['a complete tree with one one-bit code', dynamicBlock(lengths(257, { 65: 1, 66: 2, 256: 2 }), [0], [65, 66, 256]), Uint8Array.of(65, 66)],
  ['an incomplete tree read at assigned codes only', dynamicBlock(lengths(257, { 65: 2, 256: 2 }), [0], [65, 256]), Uint8Array.of(65)],
  ['HLIT 286', dynamicBlock(lengths(286, { 65: 1, 256: 1 }), [0], [65, 256]), Uint8Array.of(65)],
  ['HDIST 30', dynamicBlock(literalOnly, lengths(30, { 0: 1 }), [65, 256]), Uint8Array.of(65)],
  ['literals with an empty distance tree', dynamicBlock(literalOnly, [0], [65, 65, 256]), Uint8Array.of(65, 65)],
];

// RFC 1950, 2.2: CM must be 8, CINFO at most 7 and CMF * 256 + FLG a multiple of 31; FDICT asks for a preset dictionary.
const body = deflateZlib(Uint8Array.of(1, 2, 3)).subarray(2);
const malformedHeaders: ReadonlyArray<readonly [string, Uint8Array, typeof ParseError | typeof UnsupportedFeatureError, Partial<Pick<ParseError, 'offset'>>]> =
  [
    ['no bytes', new Uint8Array(), ParseError, { offset: 0 }],
    ['one header byte', Uint8Array.of(0x78), ParseError, { offset: 1 }],
    ['CM 9', concat([Uint8Array.of(0x79, 0x18), body]), ParseError, { offset: 0 }],
    ['CINFO 8', concat([Uint8Array.of(0x88, 0x1c), body]), ParseError, { offset: 0 }],
    ['a header that is not a multiple of 31', concat([Uint8Array.of(0x78, 0x00), body]), ParseError, { offset: 0 }],
    ['a preset dictionary', concat([Uint8Array.of(0x78, 0x20), body]), UnsupportedFeatureError, {}],
  ];

describe('zlib inflation', () => {
  it('decodes fflate and pako streams at levels 0, 1, 6 and 9', () => {
    for (const data of dataSet()) {
      for (const level of [0, 1, 6, 9] as const) {
        const fflateResult = inflateZlib(compressFflate(data, { level }));
        expect(fflateResult.warnings).toStrictEqual([]);
        expect(comparison(fflateResult.data, data)).toStrictEqual([data.length, -1]);
        expect(comparison(inflateZlib(deflate(data, { level })).data, data)).toStrictEqual([data.length, -1]);
      }
    }
  });

  it('decodes ten MiB of highly compressible data', () => {
    const data = largeData();
    for (const level of [0, 1, 6, 9] as const) {
      const fflateResult = inflateZlib(compressFflate(data, { level }));
      expect(fflateResult.warnings).toStrictEqual([]);
      expect(comparison(fflateResult.data, data)).toStrictEqual([data.length, -1]);
      expect(comparison(inflateZlib(deflate(data, { level })).data, data)).toStrictEqual([data.length, -1]);
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

  it('ignores bytes after the final block of raw deflate data, which has no trailer to warn about', () => {
    const data = new TextEncoder().encode('hello hello hello');
    const raw = compressFflate(data).subarray(2, -4);
    expect(inflateRaw(concat([raw, Uint8Array.of(1, 2, 3)]))).toStrictEqual(data);
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
    for (const maxOutputBytes of [-1, 1.5, Number.NaN]) {
      expect(() => inflateRaw(new Uint8Array([3, 0]), { maxOutputBytes })).toThrow(InvalidArgumentError);
    }
  });

  it('rejects more literal/length or distance codes than zlib accepts', () => {
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
    const literals = dynamicBlock(literalOnly, [0], [65, 65, 256]);
    expect(inflateRaw(literals)).toStrictEqual(new Uint8Array([65, 65]));
    const lengthSymbol = dynamicBlock(lengths(258, { 65: 2, 256: 2, 257: 1 }), [0], [65, 257, 256]);
    expect(() => inflateRaw(lengthSymbol)).toThrow(ParseError);
    // Without the empty-tree check the distance read fails as a truncated Huffman code, so the message is what tells the two apart.
    expect(() => inflateRaw(lengthSymbol)).toThrow(/empty distance tree/u);
  });

  it('rejects truncated blocks and preset dictionaries', () => {
    const compressed = compressFflate(new TextEncoder().encode('incomplete block '.repeat(100)));
    expect(() => inflateZlib(compressed.subarray(0, 5))).toThrow(ParseError);
    const dictionaryHeader = new Uint8Array([0x78, 0x20]);
    expect(() => inflateZlib(dictionaryHeader)).toThrow(UnsupportedFeatureError);
  });
});

describe('malformed deflate data', () => {
  it.each(malformedRaw)('inflateRaw, inflateZlib and inflateChunks refuse %s', (_, raw, message) => {
    const wrapped = zlib(raw);
    for (const decode of decoders(raw, wrapped)) {
      expect(decode).toThrow(ParseError);
      expect(decode).toThrow(message);
    }
  });

  it.each(acceptedRaw)('inflateRaw, inflateZlib and inflateChunks decode %s', (_, raw, expected) => {
    const wrapped = zlib(raw, expected);
    const warnings: Array<FlateWarning> = [];
    const chunks = concat([
      ...inflateChunks(wrapped, {
        onWarning: warning => {
          warnings.push(warning);
        },
      }),
    ]);
    expect([inflateRaw(raw), inflateZlib(wrapped), chunks, warnings]).toStrictEqual([expected, { data: expected, warnings: [] }, expected, []]);
  });

  it.each(malformedHeaders)('inflateZlib and inflateChunks refuse a zlib header with %s', (_, data, errorClass, fields) => {
    for (const decode of decoders(undefined, data)) {
      expect(decode).toThrow(errorClass);
      expect(decode).toThrow(expect.objectContaining(fields));
    }
  });

  it('accepts the zlib header with CINFO 7 and each valid FCHECK', () => {
    for (const flag of [0x01, 0x5e, 0x9c, 0xda]) {
      const data = concat([Uint8Array.of(0x78, flag), body]);
      expect([inflateZlib(data).data, chunked(data)]).toStrictEqual([Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)]);
    }
  });
});

describe('zlib trailer warnings', () => {
  const payload = new TextEncoder().encode('stream payload');
  const compressed = deflateZlib(payload);
  const trailer = compressed.length - 4;
  const corrupted = Uint8Array.from(compressed);
  corrupted[trailer + 3] = (corrupted[trailer + 3] ?? 0) ^ 1;

  // RFC 1950, 2.2: the Adler-32 trailer starts where the deflate data ends; a warning about it names that offset, and a warning about bytes after it names the first such byte.
  it.each([
    ['a trailer cut to two bytes', compressed.subarray(0, -2), [{ code: 'truncated-trailer', offset: trailer }]],
    ['a trailer with no bytes', compressed.subarray(0, -4), [{ code: 'truncated-trailer', offset: trailer }]],
    ['a wrong checksum', corrupted, [{ code: 'checksum-mismatch', offset: trailer }]],
    ['a byte after the trailer', concat([compressed, Uint8Array.of(0)]), [{ code: 'trailing-data', offset: trailer + 4 }]],
    [
      'a wrong checksum and a byte after it',
      concat([corrupted, Uint8Array.of(0)]),
      [
        { code: 'checksum-mismatch', offset: trailer },
        { code: 'trailing-data', offset: trailer + 4 },
      ],
    ],
  ] as const)('inflateZlib and inflateChunks report %s at its offset', (_, data, expected) => {
    const warnings: Array<FlateWarning> = [];
    const chunks = concat([
      ...inflateChunks(data, {
        onWarning: warning => {
          warnings.push(warning);
        },
      }),
    ]);
    expect([inflateZlib(data), chunks, warnings]).toStrictEqual([{ data: payload, warnings: expected }, payload, expected]);
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
      const warnings: Array<FlateWarning> = [];
      const chunks = [
        ...inflateChunks(data, {
          onWarning: warning => {
            warnings.push(warning);
          },
        }),
      ];
      expect(concat(chunks)).toStrictEqual(input);
      expect(warnings.map(warning => warning.code)).toStrictEqual([code]);
    }
  });

  it('delivers trailer warnings before it yields the first chunk', () => {
    const data = concat([deflateZlib(new TextEncoder().encode('stream payload')), Uint8Array.of(0)]);
    const warnings: Array<string> = [];
    const chunks = inflateChunks(data, {
      onWarning: warning => {
        warnings.push(warning.code);
      },
    });
    expect(chunks.next().done).toBe(false);
    expect(warnings).toStrictEqual(['trailing-data']);
  });

  it('rejects malformed later blocks before yielding earlier decoded bytes', () => {
    const bytes = new Uint8Array(2 + 5 + 65_535 + 6 + 1 + 4);
    bytes.set([0x78, 0x01, 0, 255, 255, 0, 0]);
    bytes.fill(65, 7, 7 + 65_535);
    bytes.set([0, 1, 0, 254, 255, 65, 7], 7 + 65_535);
    const stream = inflateChunks(bytes);
    expect(() => stream.next()).toThrow(ParseError);
  });

  it('yields bounded decoded chunks across long distance references', () => {
    const input = Uint8Array.from({ length: 1_100_000 }, (_, index) => (index * 31 + (index >>> 8)) & 255);
    const compressed = deflateZlib(input);
    const warnings: Array<FlateWarning> = [];
    const chunks = [
      ...inflateChunks(compressed, {
        onWarning: warning => {
          warnings.push(warning);
        },
      }),
    ];
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(65_536);
    expect(concat(chunks)).toStrictEqual(input);
    expect(warnings).toStrictEqual([]);
    expect(() => [...inflateChunks(compressed, { maxOutputBytes: 1000 })]).toThrow(ResourceLimitError);
  }, 60_000);

  it('checks the Adler-32 trailer across chunks of compressed and stored blocks', () => {
    const input = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 31 + (index >>> 8)) & 255);
    for (const level of [0, 6] as const) {
      const compressed = deflateZlib(input, { level });
      const corrupted = Uint8Array.from(compressed);
      corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 1;
      const codes = [compressed, corrupted].map(data => {
        const warnings: Array<string> = [];
        const decoded = concat([
          ...inflateChunks(data, {
            onWarning: warning => {
              warnings.push(warning.code);
            },
          }),
        ]);
        expect(comparison(decoded, input)).toStrictEqual([input.length, -1]);
        return warnings;
      });
      expect(codes).toStrictEqual([[], ['checksum-mismatch']]);
    }
  });

  it('accepts maxOutputBytes equal to the decoded length and refuses one byte less', () => {
    const input = Uint8Array.from({ length: 70_000 }, (_, index) => index & 255);
    const compressed = deflateZlib(input);
    expect(concat([...inflateChunks(compressed, { maxOutputBytes: 70_000 })])).toStrictEqual(input);
    expect(() => [...inflateChunks(compressed, { maxOutputBytes: 69_999 })]).toThrow(ResourceLimitError);
  });

  it.each([-1, 1.5, Number.NaN])('refuses maxOutputBytes %d by the time it is iterated', maxOutputBytes => {
    expect(() => [...inflateChunks(deflateZlib(Uint8Array.of(1)), { maxOutputBytes })]).toThrow(InvalidArgumentError);
  });

  it('decodes from its own copy of the input by default once iteration has started', () => {
    const input = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 7) & 255);
    const compressed = deflateZlib(input, { level: 0 });
    const chunks = inflateChunks(compressed);
    const first = chunks.next();
    compressed.fill(0);
    const rest = [...chunks];
    expect(first.done).toBe(false);
    expect(comparison(concat([first.value ?? new Uint8Array(), ...rest]), input)).toStrictEqual([input.length, -1]);
  });
});

describe('properties', () => {
  // Bytes drawn from four values repeat often enough to produce matches and dynamic Huffman blocks; unrestricted bytes mostly do not.
  const input = fc.oneof(fc.uint8Array({ maxLength: 2048, size: 'max' }), fc.uint8Array({ max: 3, maxLength: 4096, size: 'max' }));
  const level = fc.constantFrom(0, 1, 6, 9);
  const damage = fc.oneof(
    fc.constant({ kind: 'none' } as const),
    fc.record({ kind: fc.constant('cut' as const), bytes: fc.integer({ min: 1, max: 12 }) }),
    fc.record({ kind: fc.constant('flip' as const), back: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ kind: fc.constant('append' as const), bytes: fc.uint8Array({ minLength: 1, maxLength: 4, size: 'max' }) }),
  );

  type Damage =
    | { readonly kind: 'none' }
    | { readonly kind: 'cut'; readonly bytes: number }
    | { readonly kind: 'flip'; readonly back: number }
    | { readonly kind: 'append'; readonly bytes: Uint8Array };

  const damaged = (data: Uint8Array, change: Damage): Uint8Array => {
    if (change.kind === 'cut') {
      return data.subarray(0, Math.max(0, data.length - change.bytes));
    }
    if (change.kind === 'flip') {
      const copy = Uint8Array.from(data);
      copy[copy.length - change.back] = (copy[copy.length - change.back] ?? 0) ^ 0x10;
      return copy;
    }
    if (change.kind === 'append') {
      return concat([data, change.bytes]);
    }
    return data;
  };

  it('yields chunks that join to what inflateZlib returns, with the same warnings or the same error', () => {
    fc.assert(
      fc.property(input, level, damage, (data, chosen, change) => {
        const stream = damaged(deflateZlib(data, { level: chosen }), change);
        const whole = outcome(() => inflateZlib(stream));
        const pieces = outcome(() => {
          const warnings: Array<FlateWarning> = [];
          const joined = concat([
            ...inflateChunks(stream, {
              onWarning: warning => {
                warnings.push(warning);
              },
            }),
          ]);
          return { data: joined, warnings };
        });
        expect(pieces).toStrictEqual(whole);
      }),
    );
  });

  it('either decodes arbitrary bytes or refuses them with a library error', () => {
    const library = new Set(['ParseError', 'ResourceLimitError', 'UnsupportedFeatureError']);
    const zlibLike = fc.uint8Array({ maxLength: 512, size: 'max' }).map(bytes => concat([Uint8Array.of(0x78, 0x9c), bytes]));
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 512, size: 'max' }), zlibLike), data => {
        for (const decode of decoders(data, data)) {
          const result = outcome(decode);
          const refused = 'error' in result ? result.error : undefined;
          expect(refused === undefined || library.has(refused), `refused with ${String(refused)}`).toBe(true);
        }
      }),
    );
  });
});

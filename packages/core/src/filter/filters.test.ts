import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { latin1Bytes } from '../testing/pdfBuilder.ts';
import { seededBytes } from '../testing/seededBytes.ts';

import { decodeAscii85 } from './ascii85.ts';
import { decodeAsciiHex } from './asciiHex.ts';
import { decodeLzw } from './lzw.ts';
import { decodeRunLength } from './runLength.ts';

const LIMIT = 1_048_576;

// ISO 32000-1:2008, 7.2.2, Table 1: NUL, HORIZONTAL TAB, LINE FEED, FORM FEED, CARRIAGE RETURN and SPACE.
const WHITE_SPACE = ['\u0000', '\t', '\n', '\f', '\r', ' '] as const;

// Packs codes high-order bit first into bytes, as ISO 32000-1:2008, 7.4.4.2 describes.
const packCodes = (codes: ReadonlyArray<readonly [number, number]>): Uint8Array => {
  let bits = '';
  for (const [code, width] of codes) {
    bits += code.toString(2).padStart(width, '0');
  }
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes: Array<number> = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Uint8Array.from(bytes);
};

const CLEAR = 256;
const EOD = 257;

// ISO 32000-1:2008, 7.4.4.2: codes start at 9 bits and grow to at most 12. With EarlyChange 1 the width grows when the table is one entry short of 512, 1024 and 2048 entries, and with EarlyChange 0 when it reaches them.
const codeWidth = (tableLength: number, earlyChange: 0 | 1): number => {
  let width = 9;
  while (width < 12 && tableLength + earlyChange >= 2 ** width) {
    width++;
  }
  return width;
};

// A clear code followed by literal codes, each one byte, written at the width the table length after it calls for; every literal after the first adds a table entry.
const literalCodes = (literals: ReadonlyArray<number>, earlyChange: 0 | 1): Array<readonly [number, number]> => {
  const codes: Array<readonly [number, number]> = [[CLEAR, 9]];
  for (const [index, literal] of literals.entries()) {
    codes.push([literal, codeWidth(258 + Math.max(0, index - 1), earlyChange)]);
  }
  return codes;
};

// A test-side LZW encoder (ISO 32000-1:2008, 7.4.4.2). The decoder adds the entry for each code when it reads the next one, so the width of a code follows the decoder's table, one entry behind the encoder's. When the table is full the encoder either clears it or goes on without adding entries.
const lzwEncode = (data: Uint8Array, earlyChange: 0 | 1, clearWhenFull: boolean): Array<readonly [number, number]> => {
  const codes: Array<readonly [number, number]> = [];
  let table = new Map<string, number>();
  let next = 258;
  const reset = (): void => {
    table = new Map(Array.from({ length: 256 }, (_, byte) => [String.fromCodePoint(byte), byte]));
    next = 258;
  };
  const emit = (code: number): void => {
    codes.push([code, codeWidth(next - 1, earlyChange)]);
  };
  reset();
  emit(CLEAR);
  let current = '';
  for (const byte of data) {
    const extended = current + String.fromCodePoint(byte);
    if (table.has(extended)) {
      current = extended;
      continue;
    }
    emit(table.get(current) ?? Number.NaN);
    if (next < 4096) {
      table.set(extended, next++);
    } else if (clearWhenFull) {
      emit(CLEAR);
      reset();
    }
    current = String.fromCodePoint(byte);
  }
  if (current !== '') {
    emit(table.get(current) ?? Number.NaN);
  }
  emit(EOD);
  return codes;
};

// A test-side ASCII85 encoder (ISO 32000-1:2008, 7.4.3): four bytes to five base-85 digits from !, z for four zero bytes, and a final group of n bytes padded with zeros and cut to n + 1 digits.
const ascii85Encode = (data: Uint8Array): string => {
  let text = '';
  for (let offset = 0; offset < data.length; offset += 4) {
    const count = Math.min(4, data.length - offset);
    let value = 0;
    for (let index = 0; index < 4; index++) {
      value = value * 256 + (data[offset + index] ?? 0) * (index < count ? 1 : 0);
    }
    if (count === 4 && value === 0) {
      text += 'z';
      continue;
    }
    const digits: Array<string> = [];
    for (let index = 0; index < 5; index++) {
      digits.unshift(String.fromCodePoint(0x21 + (value % 85)));
      value = Math.floor(value / 85);
    }
    text += digits.slice(0, count + 1).join('');
  }
  return text;
};

const hexEncode = (data: Uint8Array): string => [...data].map(byte => byte.toString(16).padStart(2, '0')).join('');

// Inserts each white-space character at the position given for it, counted in the text before any insertion.
const withWhiteSpace = (text: string, insertions: ReadonlyArray<readonly [number, string]>): string => {
  let spaced = text;
  for (const [position, space] of insertions.toSorted(([left], [right]) => right - left)) {
    const at = Math.min(position, spaced.length);
    spaced = spaced.slice(0, at) + space + spaced.slice(at);
  }
  return spaced;
};

// Up to maxLength pseudo-random bytes masked with mask, drawn from a length and a seed, so a failure shrinks in a few steps rather than byte by byte through thousands of bytes.
const seeded = (maxLength: number, mask: number): fc.Arbitrary<Uint8Array> =>
  fc.tuple(fc.integer({ min: 0, max: maxLength }), fc.nat({ max: 0xff_ff_ff_ff })).map(([length, seed]) => seededBytes(length, seed).map(byte => byte & mask));

describe('stream filters', () => {
  it('decodes ASCIIHexDecode data, ignoring white space and padding an odd final digit', () => {
    expect(decodeAsciiHex(latin1Bytes('90 1f\nA3>'), LIMIT)).toStrictEqual(Uint8Array.of(0x90, 0x1f, 0xa3));
    expect(decodeAsciiHex(latin1Bytes('901FA>trailing'), LIMIT)).toStrictEqual(Uint8Array.of(0x90, 0x1f, 0xa0));
    expect(() => decodeAsciiHex(latin1Bytes('9G>'), LIMIT)).toThrow(ParseError);
  });

  it('decodes ASCII85Decode groups, z and a final partial group', () => {
    const decoded = decodeAscii85(latin1Bytes('9jqo^BlbD-BleB1DJ+*+F(f,q~>'), LIMIT);
    expect(new TextDecoder().decode(decoded)).toBe('Man is distinguished');
    expect(decodeAscii85(latin1Bytes('z 9jqo ^~>'), LIMIT)).toStrictEqual(Uint8Array.of(0, 0, 0, 0, 77, 97, 110, 32));
    expect(decodeAscii85(latin1Bytes('9jqo~>'), LIMIT)).toStrictEqual(Uint8Array.of(77, 97, 110));
    expect(decodeAscii85(latin1Bytes('s8W-!~>'), LIMIT)).toStrictEqual(Uint8Array.of(255, 255, 255, 255));
  });

  it('rejects the ASCII85Decode sequences 7.4.3 says never occur', () => {
    for (const text of ['9jzqo~>', 's8W-"~>', '9~>', '9jqo{~>']) {
      expect(() => decodeAscii85(latin1Bytes(text), LIMIT)).toThrow(ParseError);
    }
  });

  it('decodes RunLengthDecode literal and repeated runs up to EOD', () => {
    expect(decodeRunLength(Uint8Array.of(2, 1, 2, 3, 254, 9, 128, 7), LIMIT)).toStrictEqual(Uint8Array.of(1, 2, 3, 9, 9, 9));
    expect(() => decodeRunLength(Uint8Array.of(5, 1), LIMIT)).toThrow(ParseError);
    expect(() => decodeRunLength(Uint8Array.of(129, 1), 10)).toThrow(ResourceLimitError);
  });

  it('decodes the LZW example of 7.4.4.2', () => {
    const encoded = Uint8Array.of(0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01);
    expect(decodeLzw(encoded, { earlyChange: 1, maxOutputBytes: LIMIT })).toStrictEqual(Uint8Array.of(45, 45, 45, 45, 45, 65, 45, 45, 45, 66));
  });

  it('widens LZW codes one code early by default and at the table boundary with EarlyChange 0', () => {
    // 253 literal codes after a clear fill the table to entry 510, so the next code is written with 10 bits when EarlyChange is 1.
    const literals = Array.from({ length: 254 }, (_, index) => [index % 200, 9] as const);
    const expected = Uint8Array.from(literals.map(([code]) => code));
    const early = packCodes([[256, 9], ...literals, [257, 10]]);
    const late = packCodes([[256, 9], ...literals, [257, 9]]);
    expect(decodeLzw(early, { earlyChange: 1, maxOutputBytes: LIMIT })).toStrictEqual(expected);
    expect(decodeLzw(late, { earlyChange: 0, maxOutputBytes: LIMIT })).toStrictEqual(expected);
    expect(() =>
      decodeLzw(
        packCodes([
          [256, 9],
          [300, 9],
        ]),
        { earlyChange: 1, maxOutputBytes: LIMIT },
      ),
    ).toThrow(ParseError);
  });
});

describe('ASCIIHexDecode', () => {
  it('decodes every hexadecimal digit in both cases', () => {
    expect(decodeAsciiHex(latin1Bytes('0123456789abcdefABCDEF>'), LIMIT)).toStrictEqual(
      Uint8Array.of(0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef),
    );
  });

  // The characters on either side of 0-9, A-F and a-f.
  it.each(['/', ':', '@', 'G', '`', 'g'])('refuses %s at its offset', character => {
    expect(() => decodeAsciiHex(latin1Bytes(`12${character}4>`), LIMIT)).toThrow(expect.objectContaining({ name: 'ParseError', offset: 2 }));
  });

  it.each([
    ['an odd final digit with no EOD', 'A', [0xa0]],
    ['no data', '', []],
    ['EOD alone', '>', []],
    ['every PDF white-space character', '1\u00002\t3\n4\f5\r6 >', [0x12, 0x34, 0x56]],
  ])('decodes %s', (_, text, expected) => {
    expect(decodeAsciiHex(latin1Bytes(text), LIMIT)).toStrictEqual(Uint8Array.from(expected));
  });

  it('accepts output up to maxOutputBytes and refuses a byte more, including the padded odd digit', () => {
    expect(decodeAsciiHex(latin1Bytes('0000'), 2)).toStrictEqual(Uint8Array.of(0, 0));
    expect(() => decodeAsciiHex(latin1Bytes('000000'), 2)).toThrow(ResourceLimitError);
    expect(decodeAsciiHex(latin1Bytes('0'), 1)).toStrictEqual(Uint8Array.of(0));
    expect(() => decodeAsciiHex(latin1Bytes('000'), 1)).toThrow(ResourceLimitError);
  });
});

describe('ASCII85Decode', () => {
  it.each([
    ['the lowest group, !!!!!', '!!!!!~>', [0, 0, 0, 0]],
    ['a group ending in u, the highest digit', '!!!!u~>', [0, 0, 0, 84]],
    // The encoder pads a final group of n bytes with zeros; the decoder must pad with u for the n bytes to come back, which padding with ! would not give for these two.
    ['a final group of two characters', '9`~>', [77]],
    ['a final group of three characters', '9jn~>', [77, 97]],
    ['data with no EOD', '9jqo^', [77, 97, 110, 32]],
    ['data with bytes after EOD', '9jqo^~>9jqo^{', [77, 97, 110, 32]],
    ['a group split by every PDF white-space character', '9\u0000j\tq\no\f^\r ~>', [77, 97, 110, 32]],
  ])('decodes %s', (_, text, expected) => {
    expect(decodeAscii85(latin1Bytes(text), LIMIT)).toStrictEqual(Uint8Array.from(expected));
  });

  // The characters just outside ! to u, and a control character that is not PDF white space.
  it.each([
    ['v', '9jqo^v~>', 5],
    ['the control character U+0001', '9jqo^\u0001~>', 5],
    ['the space-like but not white-space U+00A0', '9j qo~>', 2],
  ])('refuses %s at its offset', (_, text, offset) => {
    expect(() => decodeAscii85(latin1Bytes(text), LIMIT)).toThrow(expect.objectContaining({ name: 'ParseError', offset }));
  });

  it('accepts output up to maxOutputBytes and refuses a byte more', () => {
    expect(decodeAscii85(latin1Bytes('z~>'), 4)).toStrictEqual(new Uint8Array(4));
    expect(() => decodeAscii85(latin1Bytes('z~>'), 3)).toThrow(ResourceLimitError);
    expect(decodeAscii85(latin1Bytes('9jn~>'), 2)).toStrictEqual(Uint8Array.of(77, 97));
    expect(() => decodeAscii85(latin1Bytes('9jn~>'), 1)).toThrow(ResourceLimitError);
  });
});

describe('RunLengthDecode', () => {
  // ISO 32000-1:2008, 7.4.5: a length byte of 0 to 127 copies the next length + 1 bytes, and 129 to 255 repeats the next byte 257 - length times.
  const literals = Array.from({ length: 128 }, (_, index) => index + 1);
  it.each([
    ['length 0 as one literal byte', [0, 9], [9]],
    ['length 127 as 128 literal bytes', [127, ...literals], literals],
    ['length 129 as 128 repeats', [129, 7], Array.from({ length: 128 }, () => 7)],
    ['length 255 as 2 repeats', [255, 7], [7, 7]],
    ['a literal run that ends the data without EOD', [2, 1, 2, 3], [1, 2, 3]],
    ['a repeated run that ends the data without EOD', [254, 4], [4, 4, 4]],
    ['no data', [], []],
    ['EOD alone, ignoring what follows', [128, 1, 2], []],
  ])('decodes %s', (_, data, expected) => {
    expect(decodeRunLength(Uint8Array.from(data), LIMIT)).toStrictEqual(Uint8Array.from(expected));
  });

  it.each([
    ['a repeated run with no byte to repeat', [200], 0],
    ['a literal run one byte short', [1, 1, 2, 3, 4, 5, 6], 3],
  ])('refuses %s at its offset', (_, data, offset) => {
    expect(() => decodeRunLength(Uint8Array.from(data), LIMIT)).toThrow(expect.objectContaining({ name: 'ParseError', offset }));
  });

  it('accepts a literal run up to maxOutputBytes and refuses a byte more', () => {
    expect(decodeRunLength(Uint8Array.of(2, 1, 2, 3), 3)).toStrictEqual(Uint8Array.of(1, 2, 3));
    expect(() => decodeRunLength(Uint8Array.of(2, 1, 2, 3), 2)).toThrow(ResourceLimitError);
  });
});

describe('LZWDecode', () => {
  it('refuses a code equal to the next table entry right after a clear, where there is no previous sequence to extend', () => {
    expect(() =>
      decodeLzw(
        packCodes([
          [CLEAR, 9],
          [258, 9],
        ]),
        { earlyChange: 1, maxOutputBytes: LIMIT },
      ),
    ).toThrow(ParseError);
  });

  // Tables one entry short of each boundary and at it, for both EarlyChange values; the code after the literals is EOD at the width the boundary calls for. A clear leaves 258 entries and every literal after the first adds one, so n literals leave 257 + n.
  it.each([
    [1, 1022, 10],
    [1, 1023, 11],
    [1, 2046, 11],
    [1, 2047, 12],
    [0, 1023, 10],
    [0, 1024, 11],
    [0, 2047, 11],
    [0, 2048, 12],
  ] as const)('with EarlyChange %i, reads the code after a table of %i entries with %i bits', (earlyChange, table, width) => {
    const literals = Array.from({ length: table - 257 }, (_, index) => (index * 7) % 256);
    const codes = [...literalCodes(literals, earlyChange), [EOD, width] as const];
    expect(decodeLzw(packCodes(codes), { earlyChange, maxOutputBytes: LIMIT })).toStrictEqual(Uint8Array.from(literals));
  });

  it('stays at 12 bits once the table holds 4096 entries and still decodes its last entry', () => {
    const literals = Array.from({ length: 3839 }, (_, index) => (index * 7) % 256);
    // Entry 258 + n holds literal n followed by literal n + 1, so entry 4095 holds literals 3837 and 3838.
    const codes = [...literalCodes(literals, 1), [65, 12], [66, 12], [4095, 12], [EOD, 12]] as const;
    const expected = [...literals, 65, 66, literals[3837] ?? -1, literals[3838] ?? -1];
    expect(decodeLzw(packCodes(codes), { earlyChange: 1, maxOutputBytes: LIMIT })).toStrictEqual(Uint8Array.from(expected));
  });

  it('returns to 9-bit codes after a clear in mid-stream', () => {
    const literals = Array.from({ length: 300 }, (_, index) => index % 256);
    const codes = [...literalCodes(literals, 1), [CLEAR, 10], [65, 9], [66, 9], [258, 9], [EOD, 9]] as const;
    expect(decodeLzw(packCodes(codes), { earlyChange: 1, maxOutputBytes: LIMIT })).toStrictEqual(Uint8Array.from([...literals, 65, 66, 65, 66]));
  });

  it('decodes a stream that does not start with a clear and one that ends without EOD', () => {
    const codes = [
      [65, 9],
      [66, 9],
      [258, 9],
    ] as const;
    expect(decodeLzw(packCodes(codes), { earlyChange: 1, maxOutputBytes: LIMIT })).toStrictEqual(latin1Bytes('ABAB'));
  });

  it('accepts a table entry that fills maxOutputBytes and refuses one that passes it', () => {
    const data = packCodes([
      [CLEAR, 9],
      [65, 9],
      [66, 9],
      [258, 9],
      [EOD, 9],
    ]);
    expect(decodeLzw(data, { earlyChange: 1, maxOutputBytes: 4 })).toStrictEqual(latin1Bytes('ABAB'));
    expect(() => decodeLzw(data, { earlyChange: 1, maxOutputBytes: 3 })).toThrow(ResourceLimitError);
  });
});

describe('properties', () => {
  const insertions = fc.array(fc.tuple(fc.nat({ max: 4096 }), fc.constantFrom(...WHITE_SPACE)), { maxLength: 12, size: 'max' });

  it('decodes ASCIIHexDecode data written by a test-side encoder, wherever white space falls', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512, size: 'max' }), insertions, fc.boolean(), (data, spaces, upper) => {
        const text = hexEncode(data);
        expect(decodeAsciiHex(latin1Bytes(`${withWhiteSpace(upper ? text.toUpperCase() : text, spaces)}>`), LIMIT)).toStrictEqual(data);
      }),
    );
  });

  it('decodes ASCII85Decode data written by a test-side encoder, wherever white space falls', () => {
    const data = fc.oneof(fc.uint8Array({ maxLength: 512, size: 'max' }), fc.uint8Array({ max: 1, maxLength: 64, size: 'max' }));
    fc.assert(
      fc.property(data, insertions, (bytes, spaces) => {
        expect(decodeAscii85(latin1Bytes(`${withWhiteSpace(ascii85Encode(bytes), spaces)}~>`), LIMIT)).toStrictEqual(bytes);
      }),
    );
  });

  it('decodes RunLengthDecode data built from literal and repeated runs', () => {
    const run = fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 128, size: 'max' }).map(bytes => ({ encoded: [bytes.length - 1, ...bytes], decoded: [...bytes] })),
      fc
        .tuple(fc.integer({ min: 2, max: 128 }), fc.nat({ max: 255 }))
        .map(([count, byte]) => ({ encoded: [257 - count, byte], decoded: Array.from({ length: count }, () => byte) })),
    );
    fc.assert(
      fc.property(fc.array(run, { maxLength: 20, size: 'max' }), fc.boolean(), (runs, terminated) => {
        const encoded = [...runs.flatMap(({ encoded: bytes }) => bytes), ...(terminated ? [128] : [])];
        expect(decodeRunLength(Uint8Array.from(encoded), LIMIT)).toStrictEqual(Uint8Array.from(runs.flatMap(({ decoded }) => decoded)));
      }),
    );
  });

  it('decodes LZWDecode data written by a test-side encoder, through a full table and with either EarlyChange', () => {
    // Long unstructured inputs fill the 4,096-entry table; inputs from two byte values build long entries.
    const data = fc.oneof(seeded(12_000, 255), seeded(2000, 1));
    fc.assert(
      fc.property(data, fc.constantFrom(0, 1), fc.boolean(), (bytes, earlyChange, clearWhenFull) => {
        expect(decodeLzw(packCodes(lzwEncode(bytes, earlyChange, clearWhenFull)), { earlyChange, maxOutputBytes: LIMIT })).toStrictEqual(bytes);
      }),
    );
  });
});

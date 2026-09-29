import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { latin1Bytes } from '../testing/pdfBuilder.ts';

import { decodeAscii85 } from './ascii85.ts';
import { decodeAsciiHex } from './asciiHex.ts';
import { decodeLzw } from './lzw.ts';
import { decodeRunLength } from './runLength.ts';

const LIMIT = 1_048_576;

// Packs codes high-order bit first into bytes, as ISO 32000-1:2008, 7.4.4.2 describes.
const packCodes = (codes: readonly (readonly [number, number])[]): Uint8Array => {
  let bits = '';
  for (const [code, width] of codes) bits += code.toString(2).padStart(width, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes: number[] = [];
  for (let offset = 0; offset < bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Uint8Array.from(bytes);
};

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
    for (const text of ['9jzqo~>', 's8W-"~>', '9~>', '9jqo{~>']) expect(() => decodeAscii85(latin1Bytes(text), LIMIT)).toThrow(ParseError);
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

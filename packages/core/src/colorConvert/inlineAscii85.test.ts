import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodeAscii85 } from '../filter/ascii85.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { encodeAscii85 } from './inlineAscii85.ts';

describe('inline ASCII85 encoding', () => {
  it.each([
    { name: 'no data as the end marker alone', data: [], text: '~>' },
    { name: 'a whole group as five digits', data: [0x4d, 0x61, 0x6e, 0x20], text: '9jqo^~>' },
    { name: 'four zero bytes as z', data: [0, 0, 0, 0], text: 'z~>' },
    { name: 'a final group of three zero bytes as four digits, not z', data: [0, 0, 0], text: '!!!!~>' },
    { name: 'a final group of one byte as two digits', data: [0x4d], text: '9`~>' },
    { name: 'the largest group as s8W-!', data: [0xff, 0xff, 0xff, 0xff], text: 's8W-!~>' },
  ])('writes $name', ({ data, text }) => {
    expect(latin1Text(encodeAscii85(Uint8Array.from(data)))).toBe(text);
  });

  it('writes text without white space that decodes to the data', () => {
    const data = fc.oneof(fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ max: 1, maxLength: 16 }));
    fc.assert(
      fc.property(data, bytes => {
        const text = encodeAscii85(bytes);
        expect(latin1Text(text)).toMatch(/^[!-uz]*~>$/u);
        expect(decodeAscii85(text, 1024)).toStrictEqual(bytes);
      }),
    );
  });
});

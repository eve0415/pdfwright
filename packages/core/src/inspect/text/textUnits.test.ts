import { describe, expect, it } from 'vitest';

import { latin1Bytes } from '../../testing/pdfBuilder.ts';

import { decodeTextString } from './textUnits.ts';

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../gu) ?? [], pair => Number.parseInt(pair, 16));

describe('text strings', () => {
  it('decodes PDFDocEncoding, with undefined codes as U+FFFD', () => {
    // Annex D, D.3: code 0x93 is U+FB01 and 0x7F is undefined.
    expect(decodeTextString(Uint8Array.of(0x41, 0x93, 0x7f))).toStrictEqual({ text: 'Aﬁ�', language: undefined });
  });

  it('decodes UTF-16BE after the byte order marker, with surrogate pairs', () => {
    expect(decodeTextString(hex('feff5c71d842dfb7'))).toStrictEqual({ text: '山𠮷', language: undefined });
  });

  it('removes language escapes and reports the first one', () => {
    // 7.9.2.2: U+001B, a 2-byte ISO 639 code, an optional 2-byte ISO 3166 code, and U+001B.
    expect(decodeTextString(hex('feff001b6a614a50001b845bdb40dd00001b656e001b0041'))).toStrictEqual({ text: '葛󠄀A', language: 'ja-JP' });
  });

  it('keeps a byte order marker without text as empty text', () => {
    expect(decodeTextString(latin1Bytes('þÿ'))).toStrictEqual({ text: '', language: undefined });
  });
});

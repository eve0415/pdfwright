import { describe, expect, it } from 'vitest';

import { mm, pt } from '../length/length.ts';

import { createDocument } from './pdfDocument.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('minimal PDF document', () => {
  it('writes empty A4 pages with exact media boxes and no contents', () => {
    const document = createDocument();
    const mediaBox = [pt(0), pt(0), mm(210), mm(297)] as const;
    document.addPage({ mediaBox: [...mediaBox] });
    document.addPage({ mediaBox: [...mediaBox] });
    document.addPage({ mediaBox: [...mediaBox] });
    const text = ascii(document.save().toBytes());
    expect(text).toContain('/Count 3');
    expect(text.match(/\/MediaBox\[0 0 595\.27559 841\.88976\]/gu)).toHaveLength(3);
    expect(text).not.toContain('/Contents');
    expect(text).toContain('/Resources<<>>');
  });

  it('returns identical bytes on repeated saves and keeps supplied file IDs', () => {
    const firstId = new Uint8Array(16).fill(0x11);
    const secondId = new Uint8Array(16).fill(0x22);
    const document = createDocument({ fileIdentifier: [firstId, secondId] });
    document.addPage({ mediaBox: [pt(0), pt(0), mm(210), mm(297)] });
    const first = document.save();
    expect(document.save().toBytes()).toStrictEqual(first.toBytes());
    expect(ascii(first.toBytes())).toContain(`/ID[<${'11'.repeat(16)}> <${'22'.repeat(16)}>]`);
  });

  it('writes no exponent-form number tokens', () => {
    const document = createDocument({ fractionDigits: 10 });
    document.addPage({ mediaBox: [pt(0), pt(0), mm(0.000001), mm(297)] });
    const text = ascii(document.save().toBytes()).replaceAll(/<[0-9A-F]+>/gu, '');
    const numericTokens = text.split(/[^0-9A-Za-z.+-]+/u).filter(token => /^[-+]?\d/u.test(token));
    expect(numericTokens.filter(token => /[eE]/u.test(token))).toStrictEqual([]);
  });
});

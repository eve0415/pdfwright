import type { EncodingTable } from './simpleEncodings.ts';

import { describe, expect, it } from 'vitest';

import { glyphNameText } from './glyphNames.ts';
import {
  LATIN_PDF_DOC_CODES,
  MAC_EXPERT_ENCODING,
  MAC_ROMAN_ENCODING,
  STANDARD_ENCODING,
  SYMBOL_ENCODING,
  WIN_ANSI_ENCODING,
  ZAPF_DINGBATS_ENCODING,
  namedEncoding,
  pdfDocEncodingUnicode,
} from './simpleEncodings.ts';

const defined = (table: EncodingTable): number => table.filter(name => name !== undefined).length;

// The codes from 0x20 to 0xFF at which the encoding's glyph name gives text other than the decoder's, and the codes the encoding leaves undefined.
interface Comparison {
  readonly differ: number[];
  readonly undefinedCodes: number[];
}

const against = (table: EncodingTable, label: string): Comparison => {
  const decoder = new TextDecoder(label);
  const differ: number[] = [];
  const undefinedCodes: number[] = [];
  for (let code = 0x20; code <= 0xff; code++) {
    const name = table[code];
    if (name === undefined) undefinedCodes.push(code);
    else if (glyphNameText(name) !== decoder.decode(Uint8Array.of(code))) differ.push(code);
  }
  return { differ, undefinedCodes };
};

describe('the encodings of Annex D', () => {
  it('holds every row of D.2, D.4, D.5 and D.6', () => {
    expect([LATIN_PDF_DOC_CODES.size, defined(MAC_EXPERT_ENCODING), defined(SYMBOL_ENCODING), defined(ZAPF_DINGBATS_ENCODING)]).toStrictEqual([
      229, 165, 189, 188,
    ]);
  });

  it('agrees with the windows-1252 decoder except where the footnotes of D.2 define a code differently', () => {
    // Footnote 3 maps unused codes to bullet, where the decoder gives U+007F and C1 controls; footnotes 5 and 6 map 240 and 255 (octal) to space and hyphen, where the decoder gives U+00A0 and U+00AD.
    expect(against(WIN_ANSI_ENCODING, 'windows-1252')).toStrictEqual({ differ: [0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d, 0xa0, 0xad], undefinedCodes: [] });
  });

  it('agrees with the macintosh decoder wherever D.2 defines a MacRomanEncoding code, but for the space at 312 and the currency sign at 333 (octal)', () => {
    // D.2 footnote 1: "PDF’s MacRomanEncoding … shall continue to map code 333 to currency", where the decoder gives the euro sign.
    const { differ, undefinedCodes } = against(MAC_ROMAN_ENCODING, 'macintosh');
    expect(differ).toStrictEqual([0o312, 0o333]);
    expect(undefinedCodes).toStrictEqual([0o177, 0o255, 0o260, 0o262, 0o263, 0o266, 0o267, 0o270, 0o271, 0o272, 0o275, 0o303, 0o305, 0o306, 0o327, 0o360]);
  });

  it('reads the StandardEncoding codes that differ from ASCII', () => {
    expect([STANDARD_ENCODING[0o47], STANDARD_ENCODING[0o140], STANDARD_ENCODING[0o341], STANDARD_ENCODING[0o200]]).toStrictEqual([
      'quoteright',
      'quoteleft',
      'AE',
      undefined,
    ]);
  });

  it('reads the built-in encodings of Symbol and ZapfDingbats', () => {
    expect([SYMBOL_ENCODING[0o141], SYMBOL_ENCODING[0o240], SYMBOL_ENCODING[0o44]]).toStrictEqual(['alpha', 'Euro', 'existential']);
    // D.6 has no row for the codes 200 to 215 (octal).
    expect([ZAPF_DINGBATS_ENCODING[0o41], ZAPF_DINGBATS_ENCODING[0o254], ZAPF_DINGBATS_ENCODING[0o200]]).toStrictEqual(['a1', 'a120', undefined]);
  });

  it('maps PDFDocEncoding codes to Unicode by D.3', () => {
    const codes = [0x00, 0x09, 0x18, 0x41, 0x7f, 0x80, 0x9f, 0xa0, 0xad, 0xe9];
    expect(codes.map(code => pdfDocEncodingUnicode(code))).toStrictEqual([undefined, 0x09, 0x2d8, 0x41, undefined, 0x2022, undefined, 0x20ac, undefined, 0xe9]);
  });

  it('selects the encodings Table 114 names', () => {
    expect([
      namedEncoding('WinAnsiEncoding'),
      namedEncoding('MacRomanEncoding'),
      namedEncoding('MacExpertEncoding'),
      namedEncoding('Identity-H'),
    ]).toStrictEqual([WIN_ANSI_ENCODING, MAC_ROMAN_ENCODING, MAC_EXPERT_ENCODING, undefined]);
  });
});

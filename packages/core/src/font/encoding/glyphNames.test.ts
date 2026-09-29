import { describe, expect, it } from 'vitest';

import { glyphNameText } from './glyphNames.ts';
import { LATIN_PDF_DOC_CODES, MAC_EXPERT_ENCODING, SYMBOL_ENCODING, ZAPF_DINGBATS_ENCODING } from './simpleEncodings.ts';

// The names in a list that map to no text.
const unmapped = (names: readonly (string | undefined)[], font?: string): (string | undefined)[] =>
  names.filter(name => name !== undefined && glyphNameText(name, font) === undefined);

describe('glyph names', () => {
  it('maps the Latin names of D.2 through their PDFDocEncoding codes and D.3', () => {
    const names = ['A', 'space', 'quotesingle', 'Euro', 'fi', 'minus', 'Lslash', 'ydieresis'];
    expect(names.map(name => glyphNameText(name))).toStrictEqual(['A', ' ', "'", '€', 'ﬁ', '−', 'Ł', 'ÿ']);
  });

  it('follows the uni and u examples of the Adobe Glyph List specification, section 3', () => {
    const names = ['uni20AC0308', 'u1040C', 'uniD801DC0C', 'uni20ac', 'foo', '.notdef'];
    expect(names.map(name => glyphNameText(name))).toStrictEqual(['€̈', '\u{1040C}', undefined, undefined, undefined, undefined]);
  });

  it('maps names by the Adobe Glyph List, including multi-character entries and the Lcommaaccent example of section 3', () => {
    const names = ['Lcommaaccent', 'alpha', 'arrowvertex', 'dalethatafpatah', 'Lcommaaccent_uni20AC0308_u1040C.alternate'];
    expect(names.map(name => glyphNameText(name))).toStrictEqual(['\u013B', '\u03B1', '\uF8E6', '\u05D3\u05B2', '\u013B\u20AC\u0308\u{1040C}']);
  });

  it('maps ZapfDingbats names by the ITC Zapf Dingbats Glyph List only in the ZapfDingbats font', () => {
    expect([
      glyphNameText('a1'),
      glyphNameText('a1', 'ZapfDingbats'),
      glyphNameText('a120', 'ZapfDingbats'),
      glyphNameText('space', 'ZapfDingbats'),
    ]).toStrictEqual([undefined, '\u2701', '\u2460', ' ']);
  });

  it('maps every name of the Symbol, ZapfDingbats and expert encodings of Annex D', () => {
    expect([
      unmapped(SYMBOL_ENCODING),
      unmapped(ZAPF_DINGBATS_ENCODING, 'ZapfDingbats'),
      unmapped(MAC_EXPERT_ENCODING),
      unmapped([...LATIN_PDF_DOC_CODES.keys()]),
    ]).toStrictEqual([[], [], [], []]);
  });

  it('drops the suffix after the first period and joins the components between underscores', () => {
    const names = ['a.sc', 'f_f_i', 'f_f_i.liga', 'A_foo', 'uni0041.alt.2'];
    expect(names.map(name => glyphNameText(name))).toStrictEqual(['a', 'ffi', 'ffi', 'A', 'A']);
  });

  it('reads u with four to six uppercase digits up to U+10FFFF, outside the surrogates', () => {
    const names = ['u0041', 'u1F600', 'u10FFFF', 'u110000', 'uD800', 'u041', 'u1000000', 'uniE000'];
    expect(names.map(name => glyphNameText(name))).toStrictEqual(['A', '\u{1F600}', '\u{10FFFF}', undefined, undefined, undefined, undefined, '']);
  });
});

import { describe, expect, it } from 'vitest';

import { glyphNameText } from './glyphNames.ts';

describe('glyph names', () => {
  it('maps the Latin names of D.2 through their PDFDocEncoding codes and D.3', () => {
    const names = ['A', 'space', 'quotesingle', 'Euro', 'fi', 'minus', 'Lslash', 'ydieresis'];
    expect(names.map(name => glyphNameText(name))).toStrictEqual(['A', ' ', "'", '€', 'ﬁ', '−', 'Ł', 'ÿ']);
  });

  it('follows the uni and u examples of the Adobe Glyph List specification, section 3', () => {
    const names = ['uni20AC0308', 'u1040C', 'uniD801DC0C', 'uni20ac', 'foo', '.notdef'];
    expect(names.map(name => glyphNameText(name))).toStrictEqual(['€̈', '\u{1040C}', undefined, undefined, undefined, undefined]);
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

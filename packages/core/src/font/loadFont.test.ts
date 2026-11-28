import type { TestObject } from '../testing/pdfBuilder.ts';
import type { CMapProvider } from './cmap/cmapProvider.ts';
import type { FontGlyph, FontModel } from './fontModel.ts';

import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { pdfDictionary, pdfReference } from '../object/pdfObject.ts';
import { latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../testing/syntheticTrueType.ts';

import { FontCache, fontKey, fontResourceOwner } from './loadFont.ts';
import { fontDocument } from './testing/fontDocument.ts';

// Object 10 is the font; the other objects are what it refers to.
const fontOf = (font: string, objects: ReadonlyArray<TestObject> = [], provider?: CMapProvider): FontModel =>
  new FontCache(fontDocument([{ number: 10, body: font }, ...objects]), provider).font(pdfReference(10, 0), '10.0');

const glyphsOf = (font: FontModel, string: Uint8Array | string): ReadonlyArray<FontGlyph> => {
  const result = font.glyphs(typeof string === 'string' ? latin1Bytes(string) : string);
  if (result.kind !== 'glyphs') {
    throw new Error(`the string does not split: ${result.kind}`);
  }
  return result.glyphs;
};

const pick = <K extends keyof FontGlyph>(glyphs: ReadonlyArray<FontGlyph>, field: K): Array<FontGlyph[K]> => glyphs.map(glyph => glyph[field]);

const providerOf = (files: Readonly<Record<string, string>>): CMapProvider => ({
  cmap: name => (name in files ? latin1Bytes(files[name] ?? '') : undefined),
});

const HELVETICA_WIDTHS =
  '/FirstChar 32/LastChar 65/Widths[278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667]';
const descriptorObject = (flags: number, extra = ''): TestObject => ({
  number: 11,
  body: `<</Type/FontDescriptor/FontName/Test/Flags ${String(flags)}/MissingWidth 250${extra}>>`,
});

describe('simple fonts', () => {
  it('refuses a string longer than its glyph budget and accepts one exactly at it', () => {
    const font = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
    const atBudget = font.glyphs(latin1Bytes('AAA'), 3);
    expect(atBudget.kind === 'glyphs' ? pick(atBudget.glyphs, 'glyphName') : atBudget.kind).toStrictEqual(['A', 'A', 'A']);
    expect(() => font.glyphs(latin1Bytes('AAA'), 2)).toThrow(ResourceLimitError);
  });

  it('names codes by a predefined encoding and takes widths from Widths', () => {
    const font = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/Encoding/WinAnsiEncoding${HELVETICA_WIDTHS}/FontDescriptor 11 0 R>>`, [descriptorObject(32)]);
    const glyphs = glyphsOf(font, 'A \u0080');
    expect(pick(glyphs, 'glyphName')).toStrictEqual(['A', 'space', 'Euro']);
    expect(pick(glyphs, 'encodingText')).toStrictEqual(['A', ' ', '€']);
    // Table 111, Widths: "For character codes outside the range FirstChar to LastChar, the value of MissingWidth from the FontDescriptor entry for this font shall be used."
    expect(pick(glyphs, 'width')).toStrictEqual([0.667, 0.278, 0.25]);
    expect(pick(glyphs, 'wordSpace')).toStrictEqual([false, true, false]);
  });

  it('applies Differences over a BaseEncoding and flags .notdef', () => {
    const font = fontOf(
      '<</Type/Font/Subtype/Type1/BaseFont/Test/Encoding<</BaseEncoding/MacRomanEncoding/Differences[65/B/C 67/.notdef]>>/FontDescriptor 11 0 R>>',
      [descriptorObject(32)],
    );
    const glyphs = glyphsOf(font, 'ABC\u0080');
    expect(pick(glyphs, 'glyphName')).toStrictEqual(['B', 'C', '.notdef', 'Adieresis']);
    expect(pick(glyphs, 'notdef')).toStrictEqual([false, false, true, false]);
  });

  it('takes StandardEncoding as the base of a nonsymbolic Type 1 font and no base for a symbolic one', () => {
    const nonsymbolic = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Test/FontDescriptor 11 0 R>>', [descriptorObject(32)]);
    const symbolic = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Test/FontDescriptor 11 0 R>>', [descriptorObject(4)]);
    expect(pick(glyphsOf(nonsymbolic, "'`"), 'glyphName')).toStrictEqual(['quoteright', 'quoteleft']);
    expect(pick(glyphsOf(symbolic, "'`"), 'glyphName')).toStrictEqual([undefined, undefined]);
  });

  it('uses the built-in encodings of the standard Symbol and ZapfDingbats fonts', () => {
    const symbol = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Symbol>>');
    const dingbats = fontOf('<</Type/Font/Subtype/Type1/BaseFont/ZapfDingbats>>');
    expect(pick(glyphsOf(symbol, 'a'), 'encodingText')).toStrictEqual(['α']);
    expect(pick(glyphsOf(dingbats, '!'), 'encodingText')).toStrictEqual(['✁']);
  });

  it('fills the undefined entries of a nonsymbolic TrueType font from StandardEncoding, and only those of a TrueType font', () => {
    // 9.6.6.4: "Finally, any undefined entries in the table shall be filled using StandardEncoding." MacRomanEncoding leaves code 255 (octal) undefined, and StandardEncoding names it guilsinglright.
    const trueType = fontOf('<</Type/Font/Subtype/TrueType/BaseFont/Test/Encoding/MacRomanEncoding/FontDescriptor 11 0 R>>', [descriptorObject(32)]);
    const type1 = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Test/Encoding/MacRomanEncoding/FontDescriptor 11 0 R>>', [descriptorObject(32)]);
    const shown = Uint8Array.of(0o255, 0x41);
    expect([pick(glyphsOf(trueType, shown), 'glyphName'), pick(glyphsOf(type1, shown), 'glyphName')]).toStrictEqual([
      ['guilsinglright', 'A'],
      [undefined, 'A'],
    ]);
  });

  it('reports unknown widths for a font without Widths that is not a standard 14 font', () => {
    const font = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Test/FontDescriptor 11 0 R>>', [descriptorObject(32)]);
    expect(pick(glyphsOf(font, 'A'), 'width')).toStrictEqual([undefined]);
    expect(font.warnings.map(warning => warning.code)).toStrictEqual(['widths-unknown']);
  });

  it('takes the widths of a standard 14 font without Widths from its bundled metrics, by glyph name', () => {
    const helvetica = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding<</Differences[66/a1]>>>>');
    const symbol = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Symbol>>');
    expect([...pick(glyphsOf(helvetica, 'A B'), 'width'), ...pick(glyphsOf(symbol, 'a'), 'width')]).toStrictEqual([0.667, 0.278, undefined, 0.631]);
    expect([...helvetica.warnings, ...symbol.warnings]).toStrictEqual([]);
    expect(helvetica.verticalExtent).toStrictEqual({ descent: -225, ascent: 931, estimated: false });
  });

  it('prefers the Widths array of a standard 14 font to its bundled metrics', () => {
    const font = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/FirstChar 65/LastChar 65/Widths[500]>>');
    expect(pick(glyphsOf(font, 'A'), 'width')).toStrictEqual([0.5]);
  });

  it('maps codes through a ToUnicode stream and reports a ToUnicode name as unreadable', () => {
    const toUnicode = streamBody('', '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <00660069> endbfchar');
    const mapped = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/ToUnicode 12 0 R${HELVETICA_WIDTHS}/FontDescriptor 11 0 R>>`, [
      descriptorObject(32),
      { number: 12, body: toUnicode },
    ]);
    expect([mapped.toUnicode, ...pick(glyphsOf(mapped, 'AB'), 'toUnicode')]).toStrictEqual(['present', 'fi', undefined]);
    const named = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/ToUnicode/Identity-H${HELVETICA_WIDTHS}/FontDescriptor 11 0 R>>`, [descriptorObject(32)]);
    expect([named.toUnicode, ...named.warnings.map(warning => warning.code)]).toStrictEqual(['unreadable', 'to-unicode-unreadable']);
  });

  it('takes the vertical extent from the descriptor, else from its normalised FontBBox, else estimates it', () => {
    const ascent = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test${HELVETICA_WIDTHS}/FontDescriptor 11 0 R>>`, [
      descriptorObject(32, '/Ascent 718/Descent -207/FontBBox[0 -300 1000 900]'),
    ]);
    const box = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test${HELVETICA_WIDTHS}/FontDescriptor 11 0 R>>`, [
      descriptorObject(32, '/Ascent 0/Descent 0/FontBBox[0 900 1000 -300]'),
    ]);
    const none = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test${HELVETICA_WIDTHS}/FontDescriptor 11 0 R>>`, [descriptorObject(32)]);
    expect([ascent.verticalExtent, box.verticalExtent, none.verticalExtent]).toStrictEqual([
      { descent: -207, ascent: 718, estimated: false },
      { descent: -300, ascent: 900, estimated: false },
      { descent: -200, ascent: 800, estimated: true },
    ]);
  });

  it('reads a font value that is not a dictionary as an unreadable font', () => {
    const font = new FontCache(fontDocument([]), undefined).font({ kind: 'integer', value: 3 }, 'direct:1.0:4631');
    expect([font.subtype, font.glyphs(latin1Bytes('A')).kind, ...font.warnings.map(warning => warning.code)]).toStrictEqual([
      'other',
      'undecodable',
      'font-unreadable',
    ]);
  });
});

const type0Font = (encoding: string, cidFont: string): string =>
  `<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding ${encoding}/DescendantFonts[<<${cidFont}>>]>>`;
const CID_FONT_TYPE2 =
  '/Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 900/W[65[500 600]100 200 700]';

describe('composite fonts', () => {
  it('refuses a composite string longer than its glyph budget and accepts one exactly at it', () => {
    const font = fontOf('<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[12 0 R]>>', [
      { number: 12, body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000>>' },
    ]);
    const shown = Uint8Array.of(0, 65, 0, 66);
    const atBudget = font.glyphs(shown, 2);
    expect(atBudget.kind === 'glyphs' ? pick(atBudget.glyphs, 'cid') : atBudget.kind).toStrictEqual([65, 66]);
    expect(() => font.glyphs(shown, 1)).toThrow(ResourceLimitError);
  });

  it('splits strings of two fonts that share a predefined CMap within the codespace check budget of each string', () => {
    // 2000 one-code ranges in blocks of 100: each miss FFFF costs 4000 checks, so a string of 250 misses takes the whole budget of 1,000,000.
    const ranges = Array.from({ length: 2000 }, (_, index) => `<${index.toString(16).padStart(4, '0')}>`.repeat(2));
    const wide = Array.from(
      { length: 20 },
      (_, block) => `100 begincodespacerange ${ranges.slice(block * 100, block * 100 + 100).join(' ')} endcodespacerange`,
    ).join('\n');
    const cache = new FontCache(
      fontDocument([
        { number: 10, body: type0Font('/Wide', CID_FONT_TYPE2) },
        { number: 11, body: type0Font('/Wide', CID_FONT_TYPE2) },
      ]),
      providerOf({ Wide: wide }),
    );
    const fonts = [cache.font(pdfReference(10, 0), '10.0'), cache.font(pdfReference(11, 0), '11.0')];
    const string = new Uint8Array(500).fill(0xff);
    const shown = [...fonts, ...fonts].map(font => {
      const result = font.glyphs(string);
      return result.kind === 'glyphs' ? result.glyphs.length : result.kind;
    });
    expect(shown).toStrictEqual([250, 250, 250, 250]);
  });

  it('splits Identity-H strings into 2-byte CIDs and reads widths from W in both forms and DW', () => {
    const font = fontOf(type0Font('/Identity-H', CID_FONT_TYPE2));
    const glyphs = glyphsOf(font, Uint8Array.of(0x00, 0x41, 0x00, 0x42, 0x00, 0x96, 0x00, 0x20, 0x00, 0x00));
    expect(pick(glyphs, 'cid')).toStrictEqual([0x41, 0x42, 0x96, 0x20, 0]);
    expect(pick(glyphs, 'width')).toStrictEqual([0.5, 0.6, 0.7, 0.9, 0.9]);
    // A two-byte <0020> never takes word spacing (9.3.3).
    expect(pick(glyphs, 'wordSpace')).toStrictEqual([false, false, false, false, false]);
    expect(pick(glyphs, 'notdef')).toStrictEqual([false, false, false, false, true]);
  });

  it('maps CIDs to glyph indices through a CIDToGIDMap stream and flags glyph 0', () => {
    const map = streamBody('', '\u0000\u0000\u0000\u0007\u0000\u0000');
    const font = fontOf(type0Font('/Identity-H', `${CID_FONT_TYPE2}/CIDToGIDMap 12 0 R`), [{ number: 12, body: map }]);
    const glyphs = glyphsOf(font, Uint8Array.of(0x00, 0x01, 0x00, 0x02, 0x00, 0x09));
    expect(pick(glyphs, 'gid')).toStrictEqual([7, 0, 0]);
    expect(pick(glyphs, 'notdef')).toStrictEqual([false, true, true]);
  });

  it('applies word spacing to a single-byte code 32 of an embedded CMap', () => {
    const cmap = streamBody(
      '/Type/CMap/CMapName/Mixed',
      '2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange 2 begincidrange <00> <7F> 1 <8000> <FFFF> 200 endcidrange',
    );
    const font = fontOf(type0Font('12 0 R', CID_FONT_TYPE2), [{ number: 12, body: cmap }]);
    const glyphs = glyphsOf(font, Uint8Array.of(0x20, 0x80, 0x20));
    expect(pick(glyphs, 'cid')).toStrictEqual([33, 232]);
    expect(pick(glyphs, 'wordSpace')).toStrictEqual([true, false]);
  });

  it('names an embedded CMap by its parsed name when the CMapName entry cannot be read', () => {
    const cmap = streamBody(
      '/Type/CMap/CMapName 13 0 R',
      '/CMapName /Parsed def 1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <00> <FF> 1 endcidrange',
    );
    const font = fontOf(type0Font('12 0 R', CID_FONT_TYPE2), [
      { number: 12, body: cmap },
      { number: 13, body: '<</A [ 1 2' },
    ]);
    const glyphs = glyphsOf(font, Uint8Array.of(0x41));
    expect([font.encoding, pick(glyphs, 'cid')]).toStrictEqual([
      { kind: 'cmap', name: latin1Bytes('Parsed'), predefined: false, embedded: true, writingMode: 0, available: true },
      [66],
    ]);
  });

  it('reports a string in a predefined CMap no provider supplies or one supplies empty, and reads it with a provider', () => {
    const font = type0Font('/UniJIS-UTF16-H', '/Type/Font/Subtype/CIDFontType0/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Japan1)/Supplement 6>>');
    const without = fontOf(font);
    expect([without.glyphs(Uint8Array.of(0x5c, 0x71)), ...without.warnings.map(warning => warning.code)]).toStrictEqual([
      { kind: 'cmap-unavailable', cmap: 'UniJIS-UTF16-H' },
      'cmap-unavailable',
      'cmap-unavailable',
    ]);
    const empty = fontOf(font, [], providerOf({ 'UniJIS-UTF16-H': '', 'Adobe-Japan1-UCS2': '' }));
    expect([empty.glyphs(Uint8Array.of(0x5c, 0x71)), ...empty.warnings.map(warning => warning.code)]).toStrictEqual([
      { kind: 'cmap-unavailable', cmap: 'UniJIS-UTF16-H' },
      'cmap-unavailable',
      'cmap-unavailable',
    ]);
    const files = {
      'UniJIS-UTF16-H':
        '/CIDSystemInfo 3 dict dup begin /Registry (Adobe) def /Ordering (Japan1) def /Supplement 6 def end def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 begincidchar <5c71> 2030 endcidchar',
      'Adobe-Japan1-UCS2': '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <07ee> <5c71> endbfchar',
    };
    const glyphs = glyphsOf(fontOf(font, [], providerOf(files)), Uint8Array.of(0x5c, 0x71));
    expect([...pick(glyphs, 'cid'), ...pick(glyphs, 'encodingText')]).toStrictEqual([2030, '山']);
  });

  it('consumes an invalid code by the codespace rules and selects CID 0 for it', () => {
    const cmap = streamBody('/Type/CMap', '1 begincodespacerange <8000> <80FF> endcodespacerange 1 begincidrange <8000> <80FF> 1 endcidrange');
    const glyphs = glyphsOf(fontOf(type0Font('12 0 R', CID_FONT_TYPE2), [{ number: 12, body: cmap }]), Uint8Array.of(0x90, 0x00, 0x80, 0x01));
    expect([...pick(glyphs, 'valid'), ...pick(glyphs, 'cid')]).toStrictEqual([false, true, 0, 2]);
  });

  it('derives vertical metrics from DW2, whose default is [880 -1000], with the position vector at half the width', () => {
    const glyphs = glyphsOf(fontOf(type0Font('/Identity-V', CID_FONT_TYPE2)), Uint8Array.of(0x00, 0x41, 0x00, 0x20));
    // ISO 32000-1:2008, 9.7.4.3, EXAMPLE 2: "v = (w0 ÷ 2, 880)" and "w1 = (0, – 1000)".
    expect(pick(glyphs, 'vertical')).toStrictEqual([
      { w1: -1, vx: 0.25, vy: 0.88 },
      { w1: -1, vx: 0.45, vy: 0.88 },
    ]);
    const custom = glyphsOf(fontOf(type0Font('/Identity-V', `${CID_FONT_TYPE2}/DW2[900 -1100]`)), Uint8Array.of(0x00, 0x41));
    expect(pick(custom, 'vertical')).toStrictEqual([{ w1: -1.1, vx: 0.25, vy: 0.9 }]);
  });

  it('reads W2 in both of its forms', () => {
    const font = fontOf(type0Font('/Identity-V', `${CID_FONT_TYPE2}/W2[65[-1000 250 772 -950 300 800]100 200 -900 500 900]`));
    const glyphs = glyphsOf(font, Uint8Array.of(0x00, 0x41, 0x00, 0x42, 0x00, 0x96, 0x00, 0x20));
    expect(pick(glyphs, 'vertical')).toStrictEqual([
      { w1: -1, vx: 0.25, vy: 0.772 },
      { w1: -0.95, vx: 0.3, vy: 0.8 },
      { w1: -0.9, vx: 0.5, vy: 0.9 },
      { w1: -1, vx: 0.45, vy: 0.88 },
    ]);
  });

  it('gives simple fonts no vertical metrics', () => {
    const font = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/Encoding/WinAnsiEncoding${HELVETICA_WIDTHS}/FontDescriptor 11 0 R>>`, [descriptorObject(32)]);
    expect(pick(glyphsOf(font, 'A'), 'vertical')).toStrictEqual([undefined]);
  });

  it('takes the writing mode from the CMap, whatever its name says', () => {
    const cmap = streamBody('/Type/CMap/CMapName/Custom-H', '/CMapName /Custom-H def /WMode 1 def 1 begincodespacerange <0000> <FFFF> endcodespacerange');
    const writingModes = [
      fontOf(type0Font('12 0 R', CID_FONT_TYPE2), [{ number: 12, body: cmap }]),
      fontOf(type0Font('/Identity-V', CID_FONT_TYPE2)),
      fontOf(type0Font('/Identity-H', CID_FONT_TYPE2)),
    ].map(font => font.writingMode);
    expect(writingModes).toStrictEqual([1, 1, 0]);
  });

  it('takes the writing mode of a predefined CMap no provider supplies from the end of its name', () => {
    // 9.7.5.2, NOTE 1: "CMaps whose names end in H specify horizontal writing mode; those ending in V specify vertical writing mode."
    const cidFont = '/Type/Font/Subtype/CIDFontType0/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Japan1)/Supplement 6>>';
    expect([fontOf(type0Font('/UniJIS-UTF16-V', cidFont)).writingMode, fontOf(type0Font('/UniJIS-UTF16-H', cidFont)).writingMode]).toStrictEqual([1, 0]);
  });
});

const type3Font = (extra: string): string =>
  `<</Type/Font/Subtype/Type3/FontBBox[0 0 750 750]/FontMatrix[0.002 0 0 -0.002 0 0]/CharProcs<</a 12 0 R/g0 12 0 R/blank 13 0 R>>/Encoding<</Differences[97/a/b/blank]>>/FirstChar 97/LastChar 99/Widths[500 250 100]${extra}>>`;
const PROCEDURES: ReadonlyArray<TestObject> = [
  { number: 12, body: streamBody('', '500 0 0 750 750 0 d1 0 0 750 750 re f') },
  { number: 13, body: streamBody('', '100 0 d0 0 0 m') },
];

// Chromium's Type 3 shape with the given Differences names after code 0 and the given extra entries.
const chromiumShape = (names: string, extra: string): string =>
  `<</Type/Font/Subtype/Type3/FontBBox[0 0 750 750]/FontMatrix[0.001 0 0 -0.001 0 0]/CharProcs<</g0 12 0 R/g1A 12 0 R/g1a 12 0 R>>/Encoding<</Differences[0${names}]>>/FirstChar 0/LastChar 1/Widths[1000 500]${extra}>>`;

describe('fonts of subtype Type3', () => {
  it('scales Widths by FontMatrix and uses the font matrix as glyph space', () => {
    const font = fontOf(type3Font(''), PROCEDURES);
    // Table 112, Widths: "For character codes outside the range FirstChar to LastChar, the width shall be 0."
    expect(pick(glyphsOf(font, 'abcd'), 'width')).toStrictEqual([1, 0.5, 0.2, 0]);
    expect(font.glyphMatrix).toStrictEqual([0.002, 0, 0, -0.002, 0, 0]);
    expect(font.verticalExtent).toStrictEqual({ descent: 0, ascent: 750, estimated: false });
  });

  it('reads the d1 bounding box of each glyph procedure and the normalised FontBBox', () => {
    const font = fontOf(type3Font('').replace('/FontBBox[0 0 750 750]', '/FontBBox[0 750 750 0]'), PROCEDURES);
    expect([font.type3?.fontBBox, ...pick(glyphsOf(font, 'ac'), 'type3Box')]).toStrictEqual([[0, 0, 750, 750], [0, 0, 750, 750], undefined]);
  });

  it('flags a glyph name without a glyph procedure as notdef and a procedure that paints nothing as empty', () => {
    const glyphs = glyphsOf(fontOf(type3Font(''), PROCEDURES), 'abce');
    expect(pick(glyphs, 'notdef')).toStrictEqual([false, true, false, true]);
    expect(pick(glyphs, 'empty')).toStrictEqual([false, false, true, false]);
  });

  it("recognises Chromium's shape and flags its g0 glyph as notdef", () => {
    const chromium = `<</Type/Font/Subtype/Type3/FontBBox[0 0 750 750]/FontMatrix[0.001 0 0 -0.001 0 0]/CharProcs<</g0 12 0 R/g1A 12 0 R>>/Encoding<</Differences[0/g0/g1A]>>/FirstChar 0/LastChar 1/Widths[1000 500]/FontDescriptor 14 0 R>>`;
    const font = fontOf(chromium, [...PROCEDURES, { number: 14, body: '<</Type/FontDescriptor/FontName/AAAAAA+Test/Flags 4>>' }]);
    const other = fontOf(type3Font(''), PROCEDURES);
    expect([font.type3?.chromium, other.type3?.chromium, ...pick(glyphsOf(font, '\u0000\u0001'), 'notdef')]).toStrictEqual([true, false, true, false]);
  });

  it("needs both a FontDescriptor and uppercase hexadecimal names to take a font for Chromium's", () => {
    const procedures: ReadonlyArray<TestObject> = [...PROCEDURES, { number: 14, body: '<</Type/FontDescriptor/FontName/AAAAAA+Test/Flags 4>>' }];
    const withoutDescriptor = fontOf(chromiumShape('/g0/g1A', ''), procedures);
    const lowercase = fontOf(chromiumShape('/g0/g1a', '/FontDescriptor 14 0 R'), procedures);
    expect([withoutDescriptor, lowercase].map(font => [font.type3?.chromium, ...pick(glyphsOf(font, '\u0000\u0001'), 'notdef')])).toStrictEqual([
      [false, false, false],
      [false, false, false],
    ]);
  });
});

// A TrueType program with only a table directory and a cmap table whose (3, 1) format 4 subtable maps U+0041 to glyph 5 and U+3042 to glyph 6.
const PROGRAM =
  '000100000001000000000000636d6170000000000000001c0000003400000001000300010000000c000400280000000600000000000000413042ffff000000413042ffffffc4cfc40001000000000000';

const embeddedGlyphs = (font: FontModel): ReadonlyArray<number | undefined> | string => {
  const reading = font.embeddedCmap();
  if (reading?.kind !== 'cmap') {
    return reading?.kind ?? 'none';
  }
  return [reading.cmap.glyph(0x41), reading.cmap.glyph(0x30_42), reading.cmap.glyph(0x42)];
};

describe('embedded TrueType programs', () => {
  it('reads the cmap table of a CIDFontType2 font program through its descendant descriptor', () => {
    const objects: ReadonlyArray<TestObject> = [
      { number: 12, body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontFile2 13 0 R>>' },
      { number: 13, body: streamBody('/Filter/ASCIIHexDecode', `${PROGRAM}>`) },
    ];
    const composite = fontOf(type0Font('/Identity-H', `${CID_FONT_TYPE2}/FontDescriptor 12 0 R`), objects);
    const simple = fontOf('<</Type/Font/Subtype/TrueType/BaseFont/Test/FontDescriptor 12 0 R>>', objects);
    expect([embeddedGlyphs(composite), embeddedGlyphs(simple)]).toStrictEqual([
      [5, 6, undefined],
      [5, 6, undefined],
    ]);
  });

  it('has no embedded cmap without a FontFile2 program and reports one that cannot be read', () => {
    const broken: ReadonlyArray<TestObject> = [
      { number: 12, body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontFile2 13 0 R>>' },
      { number: 13, body: streamBody('', 'not a font') },
    ];
    const none = fontOf(type0Font('/Identity-H', CID_FONT_TYPE2));
    const damaged = fontOf('<</Type/Font/Subtype/TrueType/BaseFont/Test/FontDescriptor 12 0 R>>', broken);
    expect([embeddedGlyphs(none), embeddedGlyphs(damaged)]).toStrictEqual(['none', 'unreadable']);
  });
});

describe('the font cache', () => {
  it('loads each font once per key', () => {
    const cache = new FontCache(fontDocument([{ number: 10, body: type0Font('/Identity-H', CID_FONT_TYPE2) }]), undefined);
    expect(cache.font(pdfReference(10, 0), '10.0')).toBe(cache.font(pdfReference(10, 0), '10.0'));
  });

  it('keys an indirect font by its reference and a direct font by its owner and resource name', () => {
    expect([fontKey(pdfReference(10, 0), '3.0', latin1Bytes('F1')), fontKey(pdfDictionary(), '3.0', latin1Bytes('F1'))]).toStrictEqual([
      '10.0',
      'direct:3.0:4631',
    ]);
  });
});

const warningCodes = (font: FontModel): Array<string> => font.warnings.map(warning => warning.code);

const SIMPLE_WIDTHS = `${HELVETICA_WIDTHS}/FontDescriptor 11 0 R`;
const JAPAN1 = '/Type/Font/Subtype/CIDFontType0/BaseFont/Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Japan1)/Supplement 6>>';
const CODESPACE_2 = '1 begincodespacerange <0000> <FFFF> endcodespacerange';

describe('simple font encodings and widths', () => {
  it.each([
    { label: 'FirstChar 65, LastChar 65 and two widths', entries: '/FirstChar 65/LastChar 65/Widths[500 600]', widths: [0.25, 0.5, 0.25, 0.25] },
    { label: 'FirstChar 65, LastChar 70 and one width', entries: '/FirstChar 65/LastChar 70/Widths[500]', widths: [0.25, 0.5, 0.25, 0.25] },
    { label: 'FirstChar 65 and two widths without LastChar', entries: '/FirstChar 65/Widths[500 600]', widths: [0.25, 0.5, 0.6, 0.25] },
  ])('takes MissingWidth for codes outside $label', ({ entries, widths }) => {
    // Table 111, Widths: "For character codes outside the range FirstChar to LastChar, the value of MissingWidth from the FontDescriptor entry for this font shall be used."
    const font = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test${entries}/FontDescriptor 11 0 R>>`, [descriptorObject(32)]);
    expect(pick(glyphsOf(font, '@ABC'), 'width')).toStrictEqual(widths);
  });

  it('reports unknown widths for a Widths array without FirstChar', () => {
    const font = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Test/LastChar 65/Widths[500]/FontDescriptor 11 0 R>>', [descriptorObject(32)]);
    expect([pick(glyphsOf(font, 'A'), 'width'), warningCodes(font)]).toStrictEqual([[undefined], ['widths-unknown']]);
  });

  it('gives a font without a descriptor a MissingWidth of 0', () => {
    const font = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Test/FirstChar 65/LastChar 65/Widths[500]>>');
    expect(pick(glyphsOf(font, 'AB'), 'width')).toStrictEqual([0.5, 0]);
  });

  it('gives a Type 3 font width 0 outside FirstChar to LastChar whatever its MissingWidth', () => {
    // Table 112, Widths: "For character codes outside the range FirstChar to LastChar, the width shall be 0."
    const font = fontOf(type3Font('/FontDescriptor 14 0 R'), [
      ...PROCEDURES,
      { number: 14, body: '<</Type/FontDescriptor/FontName/Test/Flags 4/MissingWidth 250>>' },
    ]);
    expect(pick(glyphsOf(font, 'ad'), 'width')).toStrictEqual([1, 0]);
  });

  it.each([
    { label: 'a Differences entry that is not an array', differences: '5', names: ['A', 'B'], listed: 0, problems: 1 },
    { label: 'a name before any code', differences: '[/A 65/B]', names: ['B', 'B'], listed: 1, problems: 1 },
    { label: 'a code that is not an integer', differences: '[65.5/C]', names: ['A', 'B'], listed: 0, problems: 2 },
  ])('reports $label in Differences and keeps the base encoding elsewhere', ({ differences, names, listed, problems }) => {
    const font = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/Encoding<</Differences ${differences}>>${SIMPLE_WIDTHS}>>`, [descriptorObject(32)]);
    expect([pick(glyphsOf(font, 'AB'), 'glyphName'), font.encoding, warningCodes(font)]).toStrictEqual([
      names,
      { kind: 'differences', base: undefined, differences: listed },
      Array.from({ length: problems }, () => 'font-unreadable'),
    ]);
  });

  it('names code 255 by Differences and drops the names that run past it, counting them still', () => {
    // 9.6.6.1: "Subsequent names replace consecutive code indices"; no code follows 255 in a simple font.
    const font = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/Encoding<</Differences[254/b/a/c]>>${SIMPLE_WIDTHS}>>`, [descriptorObject(32)]);
    expect([pick(glyphsOf(font, Uint8Array.of(254, 255, 0)), 'glyphName'), font.encoding, warningCodes(font)]).toStrictEqual([
      ['b', 'a', undefined],
      { kind: 'differences', base: undefined, differences: 3 },
      [],
    ]);
  });

  it.each([
    { label: 'an Encoding name that is not predefined', encoding: '/Foo' },
    { label: 'a BaseEncoding name that is not predefined', encoding: '<</BaseEncoding/Foo>>' },
    { label: 'an Encoding that is neither a name nor a dictionary', encoding: '3' },
  ])('reports $label and falls back to the built-in encoding', ({ encoding }) => {
    const font = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/Encoding ${encoding}${SIMPLE_WIDTHS}>>`, [descriptorObject(32)]);
    expect([pick(glyphsOf(font, "'A"), 'glyphName'), warningCodes(font)]).toStrictEqual([['quoteright', 'A'], ['font-unreadable']]);
  });

  it('applies Differences without a BaseEncoding to StandardEncoding in a nonsymbolic font and to nothing in a symbolic one', () => {
    // Table 114, BaseEncoding: "If this entry is absent, the Differences entry shall describe differences from an implicit base encoding."
    const encoding = `/Encoding<</Differences[65/B]>>${SIMPLE_WIDTHS}`;
    const nonsymbolic = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test${encoding}>>`, [descriptorObject(32)]);
    const symbolic = fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test${encoding}>>`, [descriptorObject(4)]);
    expect([pick(glyphsOf(nonsymbolic, "'A"), 'glyphName'), pick(glyphsOf(symbolic, "'A"), 'glyphName')]).toStrictEqual([
      ['quoteright', 'B'],
      [undefined, 'B'],
    ]);
  });

  it('gives a Type 3 font without an Encoding no glyph names, so every glyph is notdef', () => {
    const font = fontOf(type3Font('').replace('/Encoding<</Differences[97/a/b/blank]>>', ''), PROCEDURES);
    const glyphs = glyphsOf(font, 'ac');
    expect([pick(glyphs, 'glyphName'), pick(glyphs, 'notdef')]).toStrictEqual([
      [undefined, undefined],
      [true, true],
    ]);
  });

  it('uses the Symbol encoding for a subset of the Type 1 Symbol font, but not for a TrueType font named Symbol', () => {
    const subset = fontOf('<</Type/Font/Subtype/Type1/BaseFont/ABCDEF+Symbol>>');
    const trueType = fontOf('<</Type/Font/Subtype/TrueType/BaseFont/Symbol>>');
    expect([pick(glyphsOf(subset, 'a'), 'glyphName'), pick(glyphsOf(trueType, 'a'), 'glyphName')]).toStrictEqual([['alpha'], ['a']]);
  });

  it.each([
    { label: 'a TrueType font named Helvetica', font: '<</Type/Font/Subtype/TrueType/BaseFont/Helvetica>>' },
    { label: 'a subset of Helvetica', font: '<</Type/Font/Subtype/Type1/BaseFont/ABCDEF+Helvetica>>' },
  ])('takes no bundled widths for $label', ({ font }) => {
    // Table 111 exempts only the standard 14 fonts, which are Type 1 fonts named exactly, from Widths.
    const model = fontOf(font);
    expect([pick(glyphsOf(model, 'A'), 'width'), warningCodes(model)]).toStrictEqual([[undefined], ['widths-unknown']]);
  });

  it('takes the vertical extent of a standard 14 font from its descriptor, else from its bundled FontBBox', () => {
    const empty = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/FontDescriptor 11 0 R>>', [descriptorObject(32)]);
    const described = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/FontDescriptor 11 0 R>>', [descriptorObject(32, '/Ascent 700/Descent -200')]);
    expect([empty.verticalExtent, described.verticalExtent]).toStrictEqual([
      { descent: -225, ascent: 931, estimated: false },
      { descent: -200, ascent: 700, estimated: false },
    ]);
  });

  it('reports the damage a ToUnicode stream holds and keeps the stream', () => {
    const overflow = streamBody('', '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <01> <04> <00FD> endbfrange');
    const damaged = streamBody('', '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> 5 endbfchar');
    const fonts = [overflow, damaged].map(stream =>
      fontOf(`<</Type/Font/Subtype/Type1/BaseFont/Test/ToUnicode 12 0 R${SIMPLE_WIDTHS}>>`, [descriptorObject(32), { number: 12, body: stream }]),
    );
    expect(fonts.map(font => [font.toUnicode, warningCodes(font)])).toStrictEqual([
      ['present', ['to-unicode-range-overflow']],
      ['present', ['to-unicode-unreadable']],
    ]);
  });
});

describe('fonts of subtype Type3, damaged', () => {
  it.each([
    { label: 'three numbers', matrix: '/FontMatrix[1 0 0]' },
    { label: 'seven numbers', matrix: '/FontMatrix[0.002 0 0 0.002 0 0 0]' },
    { label: 'absent', matrix: '' },
  ])('uses a thousandth as glyph space and warns once when the FontMatrix is $label', ({ matrix }) => {
    const font = fontOf(type3Font('').replace('/FontMatrix[0.002 0 0 -0.002 0 0]', matrix), PROCEDURES);
    expect([font.glyphMatrix, warningCodes(font)]).toStrictEqual([[0.001, 0, 0, 0.001, 0, 0], ['font-unreadable']]);
  });

  it.each([
    { box: '[0 0 0 0]', expected: undefined },
    { box: '[0 0 750 750 1]', expected: undefined },
    { box: '[0 0 750]', expected: undefined },
    { box: '[0 0 0 750]', expected: [0, 0, 0, 750] },
  ])('reads the FontBBox $box as $expected', ({ box, expected }) => {
    // Table 112, FontBBox: "If all four elements of the rectangle are zero, a conforming reader shall make no assumptions about glyph sizes based on the font bounding box."
    const font = fontOf(type3Font('').replace('/FontBBox[0 0 750 750]', `/FontBBox${box}`), PROCEDURES);
    expect(font.type3?.fontBBox).toStrictEqual(expected);
  });

  it('keeps a glyph whose procedure cannot be decoded, with no box and not as empty', () => {
    const font = fontOf(type3Font('').replace('/blank 13 0 R', '/blank 13 0 R/b 15 0 R'), [
      ...PROCEDURES,
      { number: 15, body: streamBody('/Filter/Foo', '0 0 m') },
    ]);
    const glyphs = glyphsOf(font, 'b');
    expect([pick(glyphs, 'notdef'), pick(glyphs, 'empty'), pick(glyphs, 'type3Box')]).toStrictEqual([[false], [false], [undefined]]);
  });
});

describe('composite fonts, damaged', () => {
  it('reports a Type 0 font without an Encoding and decodes none of its strings', () => {
    const font = fontOf(`<</Type/Font/Subtype/Type0/BaseFont/Test/DescendantFonts[<<${CID_FONT_TYPE2}>>]>>`);
    expect([font.glyphs(Uint8Array.of(0, 0x41)).kind, font.encoding.kind, warningCodes(font)]).toStrictEqual([
      'undecodable',
      'unreadable',
      ['font-unreadable'],
    ]);
  });

  it.each([
    { label: 'no DescendantFonts', entry: '' },
    { label: 'an empty DescendantFonts', entry: '/DescendantFonts[]' },
    { label: 'a DescendantFonts item that is not a dictionary', entry: '/DescendantFonts[5]' },
  ])('reads the CIDs of a Type 0 font with $label and leaves its metrics unknown', ({ entry }) => {
    const font = fontOf(`<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-V${entry}>>`);
    const glyphs = glyphsOf(font, Uint8Array.of(0, 0x41));
    expect([
      font.descendant,
      font.warnings.map(warning => [warning.code, /descendant/u.test(warning.detail)]),
      pick(glyphs, 'cid'),
      pick(glyphs, 'width'),
      pick(glyphs, 'vertical'),
    ]).toStrictEqual([undefined, [['font-unreadable', true]], [0x41], [undefined], [undefined]]);
  });

  it('records the subtype and reference of a descendant CIDFont', () => {
    const referenced = fontOf('<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/DescendantFonts[12 0 R]>>', [
      { number: 12, body: `<<${CID_FONT_TYPE2}>>` },
    ]);
    const other = fontOf(type0Font('/Identity-H', CID_FONT_TYPE2.replace('CIDFontType2', 'CIDFontType9')));
    expect([referenced.descendant?.subtype, referenced.descendant?.reference, other.descendant?.subtype, other.descendant?.reference]).toStrictEqual([
      'CIDFontType2',
      pdfReference(12, 0),
      'other',
      undefined,
    ]);
  });

  it.each([
    { label: 'no CIDToGIDMap', entry: '', objects: [], gids: [1, 2], warnings: [] },
    { label: 'the CIDToGIDMap name Identity', entry: '/CIDToGIDMap/Identity', objects: [], gids: [1, 2], warnings: [] },
    // Table 117, CIDToGIDMap: "the glyph index for a particular CID value c shall be a 2-byte value stored in bytes 2 × c and 2 × c + 1"; the odd last byte is the high byte of CID 1.
    {
      label: 'a CIDToGIDMap stream of odd length',
      entry: '/CIDToGIDMap 12 0 R',
      objects: [{ number: 12, body: streamBody('', '\u0000\u0000\u0003') }],
      gids: [768, 0],
      warnings: [],
    },
    { label: 'a CIDToGIDMap integer', entry: '/CIDToGIDMap 5', objects: [], gids: [undefined, undefined], warnings: ['font-unreadable'] },
    {
      label: 'a CIDToGIDMap stream that cannot be decoded',
      entry: '/CIDToGIDMap 12 0 R',
      objects: [{ number: 12, body: streamBody('/Filter/Foo', '\u0000\u0001') }],
      gids: [undefined, undefined],
      warnings: ['font-unreadable'],
    },
  ])('maps CIDs to glyph indices with $label', ({ entry, objects, gids, warnings }) => {
    const font = fontOf(type0Font('/Identity-H', `${CID_FONT_TYPE2}${entry}`), objects);
    expect([pick(glyphsOf(font, Uint8Array.of(0, 1, 0, 2)), 'gid'), warningCodes(font)]).toStrictEqual([gids, warnings]);
  });

  it('gives the glyphs of a CIDFontType0 font no glyph index, whatever its CIDToGIDMap', () => {
    const font = fontOf(type0Font('/Identity-H', `${JAPAN1}/CIDToGIDMap 12 0 R`), [{ number: 12, body: streamBody('', '\u0000\u0007\u0000\u0007') }]);
    expect(pick(glyphsOf(font, Uint8Array.of(0, 1)), 'gid')).toStrictEqual([undefined]);
  });

  it.each([
    { label: 'W', entry: '/W[65[500]]', widths: [0.5, 1] },
    { label: 'W and DW', entry: '/W[65[500]]/DW 700', widths: [0.5, 0.7] },
  ])('takes the width of an unlisted CID from DW, else 1000, from $label', ({ entry, widths }) => {
    // Table 117, DW: "Default value: 1000".
    const font = fontOf(type0Font('/Identity-H', `/Type/Font/Subtype/CIDFontType2/BaseFont/Test${entry}`));
    expect(pick(glyphsOf(font, Uint8Array.of(0, 65, 0, 66)), 'width')).toStrictEqual(widths);
  });

  it.each([
    { label: 'a negative first CID', array: '[65[500] -1[600] 70[700]]' },
    { label: 'a first CID that is not an integer', array: '[65[500] 1.5[600] 70[700]]' },
    { label: 'a range whose last CID is below its first', array: '[65[500] 80 79 600 70[700]]' },
    { label: 'a range without its width', array: '[65[500] 70 72]' },
  ])('keeps the W groups before $label and reads none after it', ({ array }) => {
    const font = fontOf(type0Font('/Identity-H', `/Type/Font/Subtype/CIDFontType2/BaseFont/Test/DW 900/W${array}`));
    expect(pick(glyphsOf(font, Uint8Array.of(0, 65, 0, 70)), 'width')).toStrictEqual([0.5, 0.9]);
  });

  it.each([{ dw2: '[900]' }, { dw2: '[1 2 3]' }, { dw2: '5' }])('uses the default [880 -1000] for the malformed DW2 $dw2', ({ dw2 }) => {
    const font = fontOf(type0Font('/Identity-V', `${CID_FONT_TYPE2}/DW2 ${dw2}`));
    expect(pick(glyphsOf(font, Uint8Array.of(0, 0x41)), 'vertical')).toStrictEqual([{ w1: -1, vx: 0.25, vy: 0.88 }]);
  });

  it.each([
    {
      label: 'Identity-H over an Adobe-Japan1 descendant',
      encoding: '/Identity-H',
      cidFont: JAPAN1,
      objects: [],
      map: { name: 'Adobe-Japan1-UCS2', available: false },
      warnings: ['cmap-unavailable'],
    },
    { label: 'Identity-H over an Adobe-Identity descendant', encoding: '/Identity-H', cidFont: CID_FONT_TYPE2, objects: [], map: undefined, warnings: [] },
    {
      label: 'Identity-H over a Japan1 descendant of another registry',
      encoding: '/Identity-H',
      cidFont: JAPAN1.replace('(Adobe)', '(Other)'),
      objects: [],
      map: undefined,
      warnings: [],
    },
    {
      label: 'Identity-H over a descendant whose Registry is a name',
      encoding: '/Identity-H',
      cidFont: JAPAN1.replace('(Adobe)', '/Adobe'),
      objects: [],
      map: undefined,
      warnings: [],
    },
    {
      label: 'an embedded CMap over an Adobe-Korea1 descendant',
      encoding: '12 0 R',
      cidFont: JAPAN1.replace('Japan1', 'Korea1'),
      objects: [{ number: 12, body: streamBody('/Type/CMap', CODESPACE_2) }],
      map: { name: 'Adobe-Korea1-UCS2', available: false },
      warnings: ['cmap-unavailable'],
    },
    {
      label: 'a predefined CMap over an Adobe-Identity descendant',
      encoding: '/UniJIS-UTF16-H',
      cidFont: CID_FONT_TYPE2,
      objects: [],
      map: { name: 'Adobe-Identity-UCS2', available: false },
      warnings: ['cmap-unavailable', 'cmap-unavailable'],
    },
  ])('chooses the CID-to-Unicode map of $label', ({ encoding, cidFont, objects, map, warnings }) => {
    // 9.10.2: the registry–ordering–UCS2 map serves "a predefined CMap" other than Identity-H and Identity-V, or "Adobe-GB1, Adobe-CNS1, Adobe-Japan1, or Adobe-Korea1".
    const font = fontOf(type0Font(encoding, cidFont), objects);
    expect([font.collectionMap, warningCodes(font)]).toStrictEqual([map, warnings]);
  });

  it('does not warn about a missing CID-to-Unicode map when a ToUnicode stream gives the text', () => {
    const toUnicode = streamBody('', `${CODESPACE_2} 1 beginbfchar <0041> <0042> endbfchar`);
    const font = fontOf(`<</Type/Font/Subtype/Type0/BaseFont/Test/Encoding/Identity-H/ToUnicode 12 0 R/DescendantFonts[<<${JAPAN1}>>]>>`, [
      { number: 12, body: toUnicode },
    ]);
    expect([font.collectionMap, warningCodes(font)]).toStrictEqual([{ name: 'Adobe-Japan1-UCS2', available: false }, []]);
  });

  it('summarises a predefined CMap by whether a provider supplied it', () => {
    const without = fontOf(type0Font('/UniJIS-UTF16-H', JAPAN1));
    const supplied = fontOf(type0Font('/UniJIS-UTF16-H', JAPAN1), [], providerOf({ 'UniJIS-UTF16-H': CODESPACE_2 }));
    const summary = { kind: 'cmap', name: latin1Bytes('UniJIS-UTF16-H'), predefined: true, embedded: false, writingMode: 0 };
    expect([without.encoding, supplied.encoding]).toStrictEqual([
      { ...summary, available: false },
      { ...summary, available: true },
    ]);
  });

  it('summarises an embedded CMap stream that cannot be decoded as unreadable', () => {
    const font = fontOf(type0Font('12 0 R', CID_FONT_TYPE2), [{ number: 12, body: streamBody('/Type/CMap/Filter/Foo', CODESPACE_2) }]);
    expect([font.encoding.kind, font.glyphs(Uint8Array.of(0, 0x41)).kind, warningCodes(font)]).toStrictEqual([
      'unreadable',
      'undecodable',
      ['font-unreadable'],
    ]);
  });

  it('reports the damage an embedded Encoding CMap holds and decodes with what it reads', () => {
    const cmap = streamBody('/Type/CMap', `${CODESPACE_2} 2 begincidrange <0010> <0001> 5 <0000> <00FF> 1 endcidrange`);
    const font = fontOf(type0Font('12 0 R', CID_FONT_TYPE2), [{ number: 12, body: cmap }]);
    expect([
      pick(glyphsOf(font, Uint8Array.of(0, 0x41)), 'cid'),
      font.warnings.map(warning => [warning.code, warning.detail.startsWith('the Encoding CMap')]),
    ]).toStrictEqual([[0x42], [['font-unreadable', true]]]);
  });

  it('gives no CID for a code that only the unavailable CMap its usecmap names could map', () => {
    const cmap = streamBody('/Type/CMap', `/UniJIS-UTF16-H usecmap ${CODESPACE_2} 1 begincidchar <0041> 7 endcidchar 1 beginnotdefchar <0043> 9 endnotdefchar`);
    const font = fontOf(type0Font('12 0 R', CID_FONT_TYPE2), [{ number: 12, body: cmap }]);
    // A trailing single byte is an invalid code, which may lie in the other CMap's codespace.
    const glyphs = glyphsOf(font, Uint8Array.of(0, 0x41, 0, 0x42, 0, 0x43, 0x44));
    expect([
      pick(glyphs, 'cid'),
      pick(glyphs, 'cmapUnavailable'),
      pick(glyphs, 'width'),
      font.encoding,
      font.warnings.map(warning => [warning.code, warning.detail.includes('UniJIS-UTF16-H')]),
    ]).toStrictEqual([
      [7, undefined, 9, undefined],
      [undefined, 'UniJIS-UTF16-H', undefined, 'UniJIS-UTF16-H'],
      [0.9, undefined, 0.9, undefined],
      { kind: 'cmap', name: new Uint8Array(), predefined: false, embedded: true, writingMode: 0, available: false },
      [['cmap-unavailable', true]],
    ]);
  });
});

// A FontFile2 stream holding `program`, written as ASCIIHexDecode data.
const fontFile2 = (program: Uint8Array): TestObject => ({
  number: 13,
  body: streamBody('/Filter/ASCIIHexDecode', `${[...program].map(byte => byte.toString(16).padStart(2, '0')).join('')}>`),
});

describe('embedded TrueType programs, by font type', () => {
  const descriptor: TestObject = { number: 12, body: '<</Type/FontDescriptor/FontName/Test/Flags 4/FontFile2 13 0 R>>' };

  it('reads the glyph boxes of a simple TrueType font program once, on the first call', () => {
    const program = syntheticTrueType({
      name: 'Test',
      glyphs: [{ advance: 1000 }, { advance: 1000, box: [500, -120, 900, 700] }],
      characters: [[0x41, 1]],
      unitsPerEm: 2000,
    });
    const font = fontOf('<</Type/Font/Subtype/TrueType/BaseFont/Test/FontDescriptor 12 0 R>>', [descriptor, fontFile2(program)]);
    const bounds = font.embeddedGlyphBounds();
    const cmap = font.embeddedCmap();
    expect([bounds?.kind === 'bounds' ? bounds.bounds.bounds(1) : bounds?.kind, cmap?.kind === 'cmap' ? cmap.cmap.glyph(0x41) : cmap?.kind]).toStrictEqual([
      [0.25, -0.06, 0.45, 0.35],
      1,
    ]);
    expect(font.embeddedGlyphBounds()).toBe(bounds);
    expect(font.embeddedCmap()).toBe(cmap);
  });

  it('reads no FontFile2 program of a Type 1 font or of a CIDFontType0 descendant', () => {
    const program = syntheticTrueType({ name: 'Test', glyphs: [{ advance: 1000 }, { advance: 1000, box: [0, 0, 500, 500] }], characters: [[0x41, 1]] });
    const objects = [descriptor, fontFile2(program)];
    const type1 = fontOf('<</Type/Font/Subtype/Type1/BaseFont/Test/FontDescriptor 12 0 R>>', objects);
    const cidFontType0 = fontOf(type0Font('/Identity-H', `${JAPAN1}/FontDescriptor 12 0 R`), objects);
    const trueType = fontOf('<</Type/Font/Subtype/TrueType/BaseFont/Test/FontDescriptor 12 0 R>>', objects);
    expect([type1, cidFontType0, trueType].map(font => [font.embeddedCmap()?.kind, font.embeddedGlyphBounds()?.kind])).toStrictEqual([
      [undefined, undefined],
      [undefined, undefined],
      ['cmap', 'bounds'],
    ]);
  });

  it('throws ResourceLimitError for a program that decodes past maxDecodedBytes', () => {
    const program = syntheticTrueType({ name: 'Test', glyphs: [{ advance: 1000 }], characters: [] });
    const load = (maxDecodedBytes: number): FontModel =>
      new FontCache(
        fontDocument([{ number: 10, body: '<</Type/Font/Subtype/TrueType/BaseFont/Test/FontDescriptor 12 0 R>>' }, descriptor, fontFile2(program)], {
          maxDecodedBytes,
        }),
        undefined,
      ).font(pdfReference(10, 0), '10.0');
    expect(load(program.length).embeddedCmap()?.kind).toBe('cmap');
    expect(() => load(program.length - 1).embeddedCmap()).toThrow(ResourceLimitError);
  });
});

describe('font resource owners', () => {
  it('keys a direct font by its Font subdictionary when that is indirect, else by the resource dictionary owner', () => {
    const name = latin1Bytes('F1');
    expect([
      fontResourceOwner(pdfReference(7, 0), '3.0', name),
      fontResourceOwner(pdfDictionary(), '3.0', name),
      fontResourceOwner(undefined, '3.0', name),
    ]).toStrictEqual([
      { owner: '7.0', name },
      { owner: '3.0', name },
      { owner: '3.0', name },
    ]);
  });
});

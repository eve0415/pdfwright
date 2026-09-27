import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { CMapProvider } from './cmap/cmapProvider.ts';
import type { FontGlyph, FontModel } from './fontModel.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { pdfDictionary, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { FontCache, fontKey } from './loadFont.ts';

const documentWith = (objects: readonly TestObject[]): DocumentInternals => {
  const loaded = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }, ...objects],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );
  const parts = internalsOf(loaded);
  if (parts === undefined) throw new Error('the document has no internals');
  return parts;
};

// Object 10 is the font; the other objects are what it refers to.
const fontOf = (font: string, objects: readonly TestObject[] = [], provider?: CMapProvider): FontModel =>
  new FontCache(documentWith([{ number: 10, body: font }, ...objects]), provider).font(pdfReference(10, 0), '10.0');

const glyphsOf = (font: FontModel, string: Uint8Array | string): readonly FontGlyph[] => {
  const result = font.glyphs(typeof string === 'string' ? latin1Bytes(string) : string);
  if (result.kind !== 'glyphs') throw new Error(`the string does not split: ${result.kind}`);
  return result.glyphs;
};

const pick = <K extends keyof FontGlyph>(glyphs: readonly FontGlyph[], field: K): FontGlyph[K][] => glyphs.map(glyph => glyph[field]);

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

  it('fills the undefined entries of a nonsymbolic TrueType font from StandardEncoding', () => {
    const font = fontOf('<</Type/Font/Subtype/TrueType/BaseFont/Test/Encoding<</Differences[65/Euro]>>/FontDescriptor 11 0 R>>', [descriptorObject(32)]);
    expect(pick(glyphsOf(font, 'AB'), 'glyphName')).toStrictEqual(['Euro', 'B']);
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
    const font = new FontCache(documentWith([]), undefined).font({ kind: 'integer', value: 3 }, 'direct:1.0:4631');
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

  it('takes the writing mode from the CMap', () => {
    expect([fontOf(type0Font('/Identity-V', CID_FONT_TYPE2)).writingMode, fontOf(type0Font('/Identity-H', CID_FONT_TYPE2)).writingMode]).toStrictEqual([1, 0]);
  });
});

const type3Font = (extra: string): string =>
  `<</Type/Font/Subtype/Type3/FontBBox[0 0 750 750]/FontMatrix[0.002 0 0 -0.002 0 0]/CharProcs<</a 12 0 R/g0 12 0 R/blank 13 0 R>>/Encoding<</Differences[97/a/b/blank]>>/FirstChar 97/LastChar 99/Widths[500 250 100]${extra}>>`;
const PROCEDURES: readonly TestObject[] = [
  { number: 12, body: streamBody('', '500 0 0 750 750 0 d1 0 0 750 750 re f') },
  { number: 13, body: streamBody('', '100 0 d0 0 0 m') },
];

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
});

// A TrueType program with only a table directory and a cmap table whose (3, 1) format 4 subtable maps U+0041 to glyph 5 and U+3042 to glyph 6.
const PROGRAM =
  '000100000001000000000000636d6170000000000000001c0000003400000001000300010000000c000400280000000600000000000000413042ffff000000413042ffffffc4cfc40001000000000000';

const embeddedGlyphs = (font: FontModel): readonly (number | undefined)[] | string => {
  const reading = font.embeddedCmap();
  if (reading?.kind !== 'cmap') return reading?.kind ?? 'none';
  return [reading.cmap.glyph(0x41), reading.cmap.glyph(0x3042), reading.cmap.glyph(0x42)];
};

describe('embedded TrueType programs', () => {
  it('reads the cmap table of a CIDFontType2 font program through its descendant descriptor', () => {
    const objects: readonly TestObject[] = [
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
    const broken: readonly TestObject[] = [
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
    const cache = new FontCache(documentWith([{ number: 10, body: type0Font('/Identity-H', CID_FONT_TYPE2) }]), undefined);
    expect(cache.font(pdfReference(10, 0), '10.0')).toBe(cache.font(pdfReference(10, 0), '10.0'));
  });

  it('keys an indirect font by its reference and a direct font by its owner and resource name', () => {
    expect([fontKey(pdfReference(10, 0), '3.0', latin1Bytes('F1')), fontKey(pdfDictionary(), '3.0', latin1Bytes('F1'))]).toStrictEqual([
      '10.0',
      'direct:3.0:4631',
    ]);
  });
});

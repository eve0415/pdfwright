import type { CMapCode } from './mappingTable.ts';

import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../../error/resourceLimitError.ts';
import { latin1Bytes } from '../../testing/pdfBuilder.ts';

import { CMap } from './cmap.ts';
import { parseCMap } from './parseCMap.ts';

const parse = (text: string): ReturnType<typeof parseCMap> => parseCMap(latin1Bytes(text), 32);

const cmapOf = (text: string, parent?: CMap): CMap => new CMap(parse(text), parent);

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], pair => Number.parseInt(pair, 16));

// The codes a CMap splits a string into, as hex, with a mark on each invalid one.
const split = (cmap: CMap, hex: string): string[] => {
  const bytes = hexBytes(hex);
  const codes: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const { code, valid } = cmap.read(bytes, offset);
    codes.push(`${code.value.toString(16).padStart(code.length * 2, '0')}${valid ? '' : '!'}`);
    offset += code.length;
  }
  return codes;
};

const code = (hex: string): CMapCode => ({ value: Number.parseInt(hex, 16), length: hex.length / 2 });

// ISO 32000-1:2008, 9.7.5.4, the EXAMPLE's CMap, with the ranges it shows.
const SHIFT_JIS = `%!PS-Adobe-3.0 Resource-CMap
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
3 dict dup begin
/Registry ( Adobe ) def
/Ordering ( Japan1 ) def
/Supplement 2 def
end def
/CMapName /90ms-RKSJ-H def
/CMapVersion 10.001 def
/CMapType 1 def
/UIDOffset 950 def
/XUID [ 1 10 25343 ] def
/WMode 0 def
4 begincodespacerange
< 00 >   < 80 >
< 8140 > < 9FFC >
< A0 >   < DF >
< E040 > < FCFC >
endcodespacerange
1 beginnotdefrange
< 00 >    < 1F >   231
endnotdefrange
3 begincidrange
< 20 >    < 7D >     231
< 7E >    < 7E >     631
< 8140 > < 817E > 633
endcidrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;

// ISO 32000-1:2008, 9.10.3, EXAMPLE 2, verbatim.
const TO_UNICODE = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<< /Registry ( Adobe )
/Ordering ( UCS )
/Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
< 0000 > < FFFF >
endcodespacerange
2 beginbfrange
< 0000 > < 005E >        < 0020 >
< 005F > < 0061 >        [ < 00660066 > < 00660069 > < 00660066006C > ]
endbfrange
1 beginbfchar
<3A51> <D840DC3E>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;

const toUnicode = (body: string): string => `begincmap\n1 begincodespacerange <00> <FF> endcodespacerange\n${body}\nendcmap`;

describe('embedded and ToUnicode CMaps', () => {
  it('reads the name, writing mode and character collection of the specification example', () => {
    const parsed = parse(SHIFT_JIS);
    expect(parsed.name).toBe('90ms-RKSJ-H');
    expect(parsed.writingMode).toBe(0);
    expect(parsed.cidSystemInfo).toStrictEqual({ registry: latin1Bytes(' Adobe '), ordering: latin1Bytes(' Japan1 '), supplement: 2 });
    expect(parsed.problems).toStrictEqual([]);
  });

  it('reads a CIDSystemInfo dictionary and a vertical writing mode', () => {
    const parsed = parse('/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def /WMode 1 def /UniJIS-UCS2-H usecmap');
    expect(parsed.cidSystemInfo).toStrictEqual({ registry: latin1Bytes('Adobe'), ordering: latin1Bytes('Identity'), supplement: 0 });
    expect(parsed.writingMode).toBe(1);
    expect(parsed.useCMap).toBe('UniJIS-UCS2-H');
  });

  it('splits strings by codespace ranges of mixed lengths and maps codes to CIDs', () => {
    const cmap = cmapOf(SHIFT_JIS);
    expect(split(cmap, '41814181427e')).toStrictEqual(['41', '8141', '8142', '7e']);
    expect(cmap.cid(code('41'))).toBe(231 + 0x41 - 0x20);
    expect(cmap.cid(code('8141'))).toBe(634);
    expect(cmap.cid(code('7e'))).toBe(631);
  });

  it('uses notdef mappings for codes without a character mapping, and CID 0 without either', () => {
    const cmap = cmapOf(SHIFT_JIS);
    expect(cmap.cid(code('05'))).toBe(231);
    expect(cmap.cid(code('a1'))).toBe(0);
    expect(cmap.cid(code('9000'))).toBe(0);
  });

  it('matches every byte of a code against its range, not the code as one number', () => {
    // 0x9020 lies numerically between 0x8140 and 0x9FFC, but its second byte is below 0x40.
    expect(split(cmapOf(SHIFT_JIS), '9020')).toStrictEqual(['9020!']);
  });

  it('consumes an invalid code by the partial-match rules of 9.7.6.3', () => {
    const cmap = cmapOf('3 begincodespacerange <00> <7F> <8000> <80FF> <A00000> <A07FFF> endcodespacerange');
    // Rule (a): the first byte matches the first byte of no range, so the range with the shortest codes decides.
    expect(split(cmap, 'f041')).toStrictEqual(['f0!', '41']);
    expect(split(cmap, 'a1014141')).toStrictEqual(['a1!', '01', '41', '41']);
    // Rule (b): A0 matches the first byte of the 3-byte range only, so A0 80 41 is consumed as one invalid code.
    expect(split(cmap, 'a0804141')).toStrictEqual(['a08041!', '41']);
    expect(split(cmap, 'ff')).toStrictEqual(['ff!']);
  });

  it('prefers the shorter of two ranges that match an invalid code equally far', () => {
    const cmap = cmapOf('3 begincodespacerange <00> <7F> <8000> <8010> <800000> <800FFF> endcodespacerange');
    // 80 20 matches no range, and both longer ranges match the first byte only, so the 2-byte range is chosen.
    expect(split(cmap, '80204141')).toStrictEqual(['8020!', '41', '41']);
  });

  it('keeps a code cut short by the end of the string as one invalid code', () => {
    expect(split(cmapOf(SHIFT_JIS), '4181')).toStrictEqual(['41', '81!']);
  });

  it('maps ToUnicode codes to text by bfrange strings, bfrange arrays and bfchar surrogate pairs', () => {
    const parsed = parse(TO_UNICODE);
    expect(parsed.problems).toStrictEqual([]);
    const cmap = new CMap(parsed);
    const codes = ['0000', '005e', '005f', '0060', '0061', '3a51', '3a52', '41'];
    expect(codes.map(hex => cmap.unicode(code(hex)))).toStrictEqual([' ', '~', 'ff', 'fi', 'ffl', '\u{2003E}', undefined, undefined]);
  });

  it('refuses a bfrange array that exceeds the content operand budget', () => {
    const cmap = `1 beginbfrange <00000000> <00004000> [${'<0041> '.repeat(16_385)}] endbfrange`;
    expect(() => parse(cmap)).toThrow(ResourceLimitError);
  });

  it('limits definitions accumulated through usecmap parents', () => {
    const cmap = '5000 begincodespacerange '.concat('<00> <FF> '.repeat(5000), 'endcodespacerange ').repeat(4);
    let parent = new CMap(parse(cmap));
    expect(() => {
      for (let index = 0; index < 3; index++) parent = new CMap(parse(cmap), parent);
    }).toThrow(ResourceLimitError);
  });

  it('counts bfrange destinations across arrays', () => {
    const cmap = `5 beginbfrange ${Array.from({ length: 5 }, (_, index) => `<${index.toString(16).padStart(4, '0')}> <${(index + 15_999).toString(16).padStart(4, '0')}> [${'<0041> '.repeat(16_000)}]`).join(' ')} endbfrange`;
    expect(() => parse(cmap)).toThrow(ResourceLimitError);
  });

  it('accepts a bfrange whose last destination byte stays within 255 and reports one that passes it', () => {
    const atBound = parse(toUnicode('1 beginbfrange <01> <03> <00FD> endbfrange'));
    expect(atBound.problems).toStrictEqual([]);
    expect(new CMap(atBound).unicode(code('03'))).toBe('ÿ');
    const beyond = parse(toUnicode('1 beginbfrange <01> <04> <00FD> endbfrange'));
    expect(beyond.problems.map(problem => problem.kind)).toStrictEqual(['range-overflow']);
    // The last UTF-16 code unit is incremented as an integer.
    expect(new CMap(beyond).unicode(code('04'))).toBe('Ā');
  });

  it('leaves the codes of a short bfrange array unmapped and reports it', () => {
    const parsed = parse(toUnicode('1 beginbfrange <10> <12> [<0041> <0042>] endbfrange'));
    expect(parsed.problems.map(problem => problem.kind)).toStrictEqual(['damaged']);
    const cmap = new CMap(parsed);
    expect([cmap.unicode(code('10')), cmap.unicode(code('11')), cmap.unicode(code('12'))]).toStrictEqual(['A', 'B', undefined]);
  });

  it('decodes an unpaired surrogate as U+FFFD and reports it', () => {
    const parsed = parse(toUnicode('2 beginbfchar <01> <D83DDE00> <02> <0041D800> endbfchar'));
    expect(parsed.problems.map(problem => problem.kind)).toStrictEqual(['damaged']);
    const cmap = new CMap(parsed);
    expect(cmap.unicode(code('01'))).toBe('\u{1F600}');
    expect(cmap.unicode(code('02'))).toBe('A�');
  });

  it('reads multi-character bfchar destinations and lowercase hexadecimal', () => {
    const cmap = cmapOf(toUnicode('1 beginbfchar <1f> <00660066006c> endbfchar'));
    expect(cmap.unicode(code('1f'))).toBe('ffl');
  });

  it('keeps the entries read before a token it cannot lex, and reports the damage', () => {
    const parsed = parse(toUnicode('2 beginbfchar <01> <0041> endbfchar 1 beginbfchar <02> <00zz> endbfchar'));
    expect(parsed.problems.map(problem => problem.kind)).toStrictEqual(['damaged']);
    const cmap = new CMap(parsed);
    expect(cmap.unicode(code('01'))).toBe('A');
    expect(cmap.unicode(code('02'))).toBeUndefined();
  });

  it('skips malformed entries and reports them', () => {
    const parsed = parse('2 begincodespacerange <00> <FFFF> <0000> <FFFF> endcodespacerange 1 begincidrange <0010> <0001> 5 endcidrange');
    expect(parsed.codespaces).toHaveLength(1);
    expect(parsed.problems.map(problem => problem.kind)).toStrictEqual(['damaged', 'damaged']);
  });

  it('looks mappings up in the CMap a usecmap names after its own, and uses the codespace ranges of both', () => {
    const parent = cmapOf('1 begincodespacerange <0000> <FFFF> endcodespacerange 1 begincidrange <0000> <00FF> 100 endcidrange');
    const child = cmapOf('/Parent usecmap 1 begincidchar <0041> 7 endcidchar', parent);
    expect(split(child, '00410042')).toStrictEqual(['0041', '0042']);
    expect(child.cid(code('0041'))).toBe(7);
    expect(child.cid(code('0042'))).toBe(166);
  });

  it('takes the writing mode from the CMap a usecmap names when its own has none', () => {
    const parent = cmapOf('/WMode 1 def');
    expect(cmapOf('/Parent usecmap', parent).writingMode).toBe(1);
    expect(cmapOf('/WMode 0 def /Parent usecmap', parent).writingMode).toBe(0);
    expect(cmapOf('').writingMode).toBe(0);
  });

  it('throws ResourceLimitError past 65,536 entries', () => {
    const entries = Array.from({ length: 65_537 }, (_, index) => `<${index.toString(16).padStart(6, '0')}> 1`).join('\n');
    expect(() => parse(`65537 begincidchar\n${entries}\nendcidchar`)).toThrow(ResourceLimitError);
  });
});

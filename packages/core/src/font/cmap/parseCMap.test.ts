import type { CMapCode } from './mappingTable.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../../error/resourceLimitError.ts';
import { latin1Bytes } from '../../testing/pdfBuilder.ts';

import { CMap } from './cmap.ts';
import { parseCMap, utf16Text } from './parseCMap.ts';

const parse = (text: string): ReturnType<typeof parseCMap> => parseCMap(latin1Bytes(text), 32);

const cmapOf = (text: string, parent?: CMap): CMap => new CMap(parse(text), parent);

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], pair => Number.parseInt(pair, 16));

// The codes a CMap splits a string into, as hex, with a mark on each invalid one.
const split = (cmap: CMap, hex: string): Array<string> => {
  const bytes = hexBytes(hex);
  const codes: Array<string> = [];
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

const CODESPACE = '1 begincodespacerange <0000> <FFFF> endcodespacerange';

const toUnicode = (body: string): string => `begincmap\n1 begincodespacerange <00> <FF> endcodespacerange\n${body}\nendcmap`;

// cidchar blocks of at most 8,000 entries, so that no block passes the content operand budget before the entry count is reached.
const cidChars = (count: number): string => {
  const blocks: Array<string> = [];
  for (let start = 0; start < count; start += 8000) {
    const size = Math.min(8000, count - start);
    const entries = Array.from({ length: size }, (_, index) => `<${(start + index).toString(16).padStart(6, '0')}> 1`);
    blocks.push(`${String(size)} begincidchar\n${entries.join('\n')}\nendcidchar`);
  }
  return blocks.join('\n');
};

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
      for (let index = 0; index < 3; index++) {
        parent = new CMap(parse(cmap), parent);
      }
    }).toThrow(ResourceLimitError);
  });

  it('bounds work for many distinct codespace misses', () => {
    const entries = Array.from({ length: 2000 }, (_, index) => {
      const hex = index.toString(16).padStart(4, '0');
      return `<${hex}> <${hex}>`;
    });
    const cmap = new CMap(parse(`2000 begincodespacerange ${entries.join(' ')} endcodespacerange`));
    expect(() => {
      for (let index = 0; index < 1000; index++) {
        cmap.read(Uint8Array.of(0xff, 0xff), 0);
      }
    }).toThrow(ResourceLimitError);
  });

  describe('the codespace check budget of 1,000,000', () => {
    // 2000 one-code ranges <0000> to <07CF>: the miss FFFF costs 4000 checks (2000 to read, 2000 to consume it as invalid), 07CF costs 2000 and 0000 costs 1.
    const WIDE_RANGES = `2000 begincodespacerange ${Array.from({ length: 2000 }, (_, index) => {
      const hex = index.toString(16).padStart(4, '0');
      return `<${hex}> <${hex}>`;
    }).join(' ')} endcodespacerange`;
    const AT_LIMIT = `${'ffff'.repeat(249)}07cf07cf`;
    const PAST_LIMIT = `${AT_LIMIT}0000`;

    it('splits a string that takes exactly the budget and refuses one that takes one check more', () => {
      expect(split(cmapOf(WIDE_RANGES), AT_LIMIT)).toHaveLength(251);
      expect(() => split(cmapOf(WIDE_RANGES), PAST_LIMIT)).toThrow(ResourceLimitError);
      expect(() => split(cmapOf(WIDE_RANGES), PAST_LIMIT)).toThrow(/codespace checks/u);
    });

    it('checks a codespace range a usecmap child repeats from its parent once', () => {
      const child = cmapOf(`/Parent usecmap ${WIDE_RANGES}`, cmapOf(WIDE_RANGES));
      expect(split(child, AT_LIMIT)).toHaveLength(251);
      expect(() => split(child, PAST_LIMIT)).toThrow(ResourceLimitError);
    });
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
    expect(cmap.unicode(code('02'))).toBe('A\uFFFD');
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

  it('accepts 65,536 entries and throws ResourceLimitError at the next one', () => {
    expect(parse(cidChars(65_536)).cids).toHaveLength(65_536);
    expect(() => parse(cidChars(65_537))).toThrow(ResourceLimitError);
  });
});

// The parts of a parse that tell which entries were kept: how many codespace ranges, CID mappings and Unicode mappings, and the kinds of the problems.
const kept = (text: string): [number, number, number, Array<string>] => {
  const parsed = parse(text);
  return [parsed.codespaces.length, parsed.cids.length, parsed.unicode.length, parsed.problems.map(problem => problem.kind)];
};

describe('damaged CMap entries', () => {
  it.each([
    { label: 'a codespace range without its upper bound', text: '2 begincodespacerange <00> <7F> <80> endcodespacerange', kept: [1, 0, 0, ['damaged']] },
    { label: 'a cidchar without its CID', text: '2 begincidchar <20> 5 <21> endcidchar', kept: [0, 1, 0, ['damaged']] },
    { label: 'a cidrange without its CID', text: '2 begincidrange <20> <21> 5 <22> <23> endcidrange', kept: [0, 1, 0, ['damaged']] },
    { label: 'a bfchar without its destination', text: '2 beginbfchar <41> <0042> <43> endbfchar', kept: [0, 0, 1, ['damaged']] },
    { label: 'a bfrange without its destination', text: '2 beginbfrange <01> <02> <0041> <03> <04> endbfrange', kept: [0, 0, 1, ['damaged']] },
  ])('keeps the complete entries before $label and reports it once', ({ text, kept: expected }) => {
    expect(kept(text)).toStrictEqual(expected);
  });

  it.each([
    { label: 'a 4-byte codespace range', text: '1 begincodespacerange <01020304> <01020304> endcodespacerange', kept: [1, 0, 0, []] },
    { label: 'a 5-byte codespace range', text: '1 begincodespacerange <0102030405> <0102030405> endcodespacerange', kept: [0, 0, 0, ['damaged']] },
    { label: 'an empty codespace bound', text: '1 begincodespacerange <> <FF> endcodespacerange', kept: [0, 0, 0, ['damaged']] },
    { label: 'an empty source code', text: '1 begincidchar <> 5 endcidchar', kept: [0, 0, 0, ['damaged']] },
    { label: 'a 5-byte source code', text: '1 begincidchar <0102030405> 5 endcidchar', kept: [0, 0, 0, ['damaged']] },
    { label: 'CID 0', text: '1 begincidchar <20> 0 endcidchar', kept: [0, 1, 0, []] },
    { label: 'a negative CID', text: '1 begincidchar <20> -5 endcidchar', kept: [0, 0, 0, ['damaged']] },
    { label: 'a bfrange destination that is a number', text: '1 beginbfrange <01> <02> 5 endbfrange', kept: [0, 0, 0, ['damaged']] },
  ])('reads $label', ({ text, kept: expected }) => {
    // ISO 32000-1:2008, 9.7.6.2: "The code length shall not be greater than 4."
    expect(kept(text)).toStrictEqual(expected);
  });

  it('reports a usecmap that follows no name and names no CMap', () => {
    const parsed = parse('5 usecmap');
    expect([parsed.useCMap, parsed.problems.map(problem => problem.kind)]).toStrictEqual([undefined, ['damaged']]);
  });

  it('reads a bfrange array item that is not a string as unmapped', () => {
    const parsed = parse(toUnicode('1 beginbfrange <01> <02> [<0041> 7] endbfrange'));
    const cmap = new CMap(parsed);
    expect([parsed.problems.map(problem => problem.kind), cmap.unicode(code('01')), cmap.unicode(code('02'))]).toStrictEqual([['damaged'], 'A', undefined]);
  });

  it('ignores a WMode other than 0 or 1', () => {
    // 9.7.5.3, Table 120, WMode: "(Optional) A code that shall determine the writing mode for any CIDFont with which this CMap is combined. The possible values shall be 0 for horizontal and 1 for vertical."
    expect([parse('/WMode 2 def').writingMode, parse('/WMode 1 def').writingMode]).toStrictEqual([undefined, 1]);
  });

  it.each([
    { label: 'a 1-byte destination as one code unit', destination: '<41>', text: 'A', problems: [] },
    { label: 'an odd leading byte as a code unit of its own', destination: '<004142>', text: '\u0000䅂', problems: [] },
    { label: 'a lone low surrogate as U+FFFD', destination: '<DC00>', text: '\uFFFD', problems: ['damaged'] },
    { label: 'a high surrogate at the end as U+FFFD', destination: '<0041D83D>', text: 'A\uFFFD', problems: ['damaged'] },
  ])('decodes $label', ({ destination, text, problems }) => {
    // 9.10.3: the destination is "a string of UTF-16BE-encoded Unicode characters".
    const parsed = parse(toUnicode(`1 beginbfchar <01> ${destination} endbfchar`));
    expect([new CMap(parsed).unicode(code('01')), parsed.problems.map(problem => problem.kind)]).toStrictEqual([text, problems]);
  });

  it('throws ResourceLimitError for arrays nested deeper than maxNesting, and reads them at it', () => {
    expect(parseCMap(latin1Bytes('[[1]] pop'), 2).problems).toStrictEqual([]);
    expect(() => parseCMap(latin1Bytes('[[[1]]] pop'), 2)).toThrow(ResourceLimitError);
  });
});

const hex4 = (value: number): string => value.toString(16).padStart(4, '0');

const utf16Hex = (text: string): string => Array.from({ length: text.length }, (_, index) => hex4(text.charCodeAt(index))).join('');

// Entries written as blocks of at most 100, the most a CMap file block holds (9.7.5.4).
const blocks = (operator: string, entries: ReadonlyArray<string>): string => {
  const written: Array<string> = [];
  for (let start = 0; start < entries.length; start += 100) {
    const block = entries.slice(start, start + 100);
    written.push(`${String(block.length)} begin${operator} ${block.join(' ')} end${operator}`);
  }
  return written.join('\n');
};

describe('properties', () => {
  // Disjoint 2-byte code segments, each written as one cidrange or as one cidchar per code, with the CID of its first code.
  const segment = fc.record({
    gap: fc.integer({ min: 0, max: 4 }),
    span: fc.integer({ min: 0, max: 6 }),
    cid: fc.integer({ min: 0, max: 60_000 }),
    range: fc.boolean(),
  });
  const unicodeText = fc.string({ unit: 'binary', minLength: 1, maxLength: 3 });

  it('maps every code as the cidrange, cidchar and bfchar entries written for it say', () => {
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 60 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 400 }), unicodeText), { maxLength: 60 }),
        (segments, texts) => {
          const cids = new Map<number, number>();
          const ranges: Array<string> = [];
          const chars: Array<string> = [];
          let next = 0;
          for (const { gap, span, cid, range } of segments) {
            const low = next + gap;
            for (let offset = 0; offset <= span; offset++) {
              cids.set(low + offset, cid + offset);
              if (!range) {
                chars.push(`<${hex4(low + offset)}> ${String(cid + offset)}`);
              }
            }
            if (range) {
              ranges.push(`<${hex4(low)}> <${hex4(low + span)}> ${String(cid)}`);
            }
            next = low + span + 1;
          }
          const unicode = new Map(texts);
          const bfchars = [...unicode].map(([source, text]) => `<${hex4(source)}> <${utf16Hex(text)}>`);
          const file = [CODESPACE, blocks('cidrange', ranges), blocks('cidchar', chars), blocks('bfchar', bfchars)].join('\n');
          const cmap = new CMap(parse(file));
          const codes = Array.from({ length: Math.max(next, 401) + 2 }, (_, index) => index);
          expect(codes.map(value => [cmap.cid({ value, length: 2 }), cmap.unicode({ value, length: 2 })])).toStrictEqual(
            codes.map(value => [cids.get(value) ?? 0, unicode.get(value)]),
          );
        },
      ),
    );
  });

  it('decodes UTF-16 code units as the platform does, with each lone surrogate as U+FFFD', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.integer({ min: 0, max: 0xff_ff }), fc.integer({ min: 0xd8_00, max: 0xdf_ff })), { maxLength: 24 }), units => {
        const platform = String.fromCharCode(...units);
        expect(utf16Text(units)).toStrictEqual({ text: platform.toWellFormed(), unpaired: !platform.isWellFormed() });
      }),
    );
  });

  it('decodes the UTF-16 code units of any well-formed text back to that text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), text => {
        const units = Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
        expect(utf16Text(units)).toStrictEqual({ text, unpaired: false });
      }),
    );
  });
});

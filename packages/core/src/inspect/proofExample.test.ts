import type { TestObject } from '../testing/pdfBuilder.ts';
import type { TestPage } from '../testing/textPdf.ts';

import { describe, expect, it } from 'vitest';

import { latin1Text, streamBody } from '../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../testing/textPdf.ts';

import { checkProof } from './proofExample.ts';

const NAME = '山田 太郎';

const hex = (value: number): string => value.toString(16).padStart(4, '0');

const UNEMBEDDED: TestObject = { number: 110, body: '<</Type/Font/Subtype/Type1/BaseFont/NotStandard/FirstChar 97/LastChar 97/Widths[500]>>' };

interface Proof {
  readonly embedded: boolean;
  /** Where page 0 shows the name: in its content, or only in an annotation appearance that prints or one that does not. */
  readonly shown?: 'content' | 'printing-annotation' | 'hidden-annotation';
  /** Further fonts of page 0's resources, further content of page 0, objects from 110, and pages after page 0. */
  readonly fonts?: string;
  readonly content?: string;
  readonly objects?: ReadonlyArray<TestObject>;
  readonly pages?: ReadonlyArray<TestPage>;
}

// A proof that shows `NAME` in one line with an Identity-H font whose code n + 1 is glyph n + 1 and maps to the name's character n; the font embeds a TrueType program whose cmap agrees unless `embedded` is false.
const proof = ({ embedded, shown = 'content', fonts = '', content = '', objects = [], pages = [] }: Proof): Uint8Array => {
  const characters = Array.from(NAME, character => character.codePointAt(0) ?? 0);
  const codes = characters.map((_, index) => hex(index + 1));
  const toUnicode = characters.map((character, index) => `<${hex(index + 1)}> <${hex(character)}>`).join(' ');
  const program = syntheticTrueType({
    name: 'Proof',
    glyphs: [{ advance: 1000 }, ...characters.map(() => ({ advance: 1000, box: [100, -100, 900, 800] as const }))],
    characters: characters.map((character, index) => [character, index + 1] as const),
  });
  const name = `BT /F 10 Tf 100 700 Td <${codes.join('')}> Tj ET`;
  // ISO 32000-1:2008, Table 165: flag 4 is Print; an annotation without it does not print.
  const flags = shown === 'printing-annotation' ? '/F 4' : '';
  const annotations = shown === 'content' ? '' : `/Annots[<</Type/Annot/Subtype/Square/Rect[0 0 600 800]${flags}/AP<</N 104 0 R>>>>]`;
  return textPdfBytes({
    pages: [{ content: `${shown === 'content' ? name : ''} ${content}`, resources: `/Font<</F 105 0 R${fonts}>>`, entries: annotations }, ...pages],
    objects: [
      { number: 104, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 600 800]/Resources<</Font<</F 105 0 R>>>>', name) },
      { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/Proof/Encoding/Identity-H/DescendantFonts[106 0 R]/ToUnicode 107 0 R>>' },
      {
        number: 106,
        body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/Proof/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 1000/FontDescriptor 108 0 R>>',
      },
      {
        number: 107,
        body: streamBody(
          '',
          `begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${String(codes.length)} beginbfchar ${toUnicode} endbfchar endcmap`,
        ),
      },
      {
        number: 108,
        body: `<</Type/FontDescriptor/FontName/Proof/Flags 4/FontBBox[0 -120 1000 880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80${embedded ? '/FontFile2 109 0 R' : ''}>>`,
      },
      ...(embedded ? [{ number: 109, body: streamBody('', latin1Text(program)) }] : []),
      ...objects,
    ],
  });
};

describe('readme proof check', () => {
  it('accepts a proof whose embedded font draws the name', () => {
    const { accepted, match, unembedded } = checkProof(proof({ embedded: true }), NAME);
    expect([accepted, match.status, match.evidence, unembedded]).toStrictEqual([true, 'match', 'glyph-checked', []]);
  });

  it('rejects a proof that shows another name', () => {
    const { accepted, match } = checkProof(proof({ embedded: true }), '山田 花子');
    expect([accepted, match.status]).toStrictEqual([false, 'mismatch']);
  });

  it('rejects a proof whose font is not embedded, though its text matches', () => {
    const { accepted, match, unembedded } = checkProof(proof({ embedded: false }), NAME);
    expect([accepted, match.status, unembedded]).toStrictEqual([false, 'match', ['105.0']]);
  });

  it.each([
    ['page 0 only names in its resources', { fonts: '/U 110 0 R' }],
    ['only a later page shows', { pages: [{ content: 'BT /U 10 Tf (a) Tj ET', resources: '/Font<</U 110 0 R>>' }] }],
  ])('accepts a proof with an unembedded font that %s', (_, extra) => {
    const { accepted, unembedded } = checkProof(proof({ embedded: true, ...extra, objects: [UNEMBEDDED] }), NAME);
    expect([accepted, unembedded]).toStrictEqual([true, []]);
  });

  // ISO 32000-1:2008, 9.6.5: a Type 3 font draws its glyphs with its own procedures, so it embeds nothing; one that paints images does not draw the text as vector shapes.
  it.each([
    ['vector shapes', '1000 0 0 0 750 750 d1 0 0 750 750 re f', []],
    ['an image', '1000 0 0 0 750 750 d1 BI /W 1 /H 1 /IM true ID \u0000 EI', ['111.0']],
  ])('lists a Type 3 font page 0 shows as unembedded only when its glyphs paint %s', (_, procedure, expected) => {
    const type3: ReadonlyArray<TestObject> = [
      {
        number: 111,
        body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 112 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]/Resources<<>>>>',
      },
      { number: 112, body: streamBody('', procedure) },
    ];
    const { unembedded } = checkProof(proof({ embedded: true, fonts: '/T3 111 0 R', content: 'BT /T3 10 Tf 100 600 Td (a) Tj ET', objects: type3 }), NAME);
    expect(unembedded).toStrictEqual(expected);
  });

  it.each([
    ['an annotation that prints', 'printing-annotation', true],
    ['an annotation that does not print', 'hidden-annotation', false],
  ] as const)('reads a name page 0 shows only in %s as printed when the annotation prints', (_, shown, accepted) => {
    expect(checkProof(proof({ embedded: true, shown }), NAME).accepted).toBe(accepted);
  });
});

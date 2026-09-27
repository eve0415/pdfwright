import { describe, expect, it } from 'vitest';

import { latin1Text, streamBody } from '../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../testing/textPdf.ts';

import { checkProof } from './proofExample.ts';

const NAME = '山田 太郎';

const hex = (value: number): string => value.toString(16).padStart(4, '0');

// A proof that shows `NAME` in one line with an Identity-H font whose code n + 1 is glyph n + 1 and maps to the name's character n; the font embeds a TrueType program whose cmap agrees unless `embedded` is false.
const proof = ({ embedded }: { embedded: boolean }): Uint8Array => {
  const characters = Array.from(NAME, character => character.codePointAt(0) ?? 0);
  const codes = characters.map((_, index) => hex(index + 1));
  const toUnicode = characters.map((character, index) => `<${hex(index + 1)}> <${hex(character)}>`).join(' ');
  const program = syntheticTrueType({
    name: 'Proof',
    glyphs: [{ advance: 1000 }, ...characters.map(() => ({ advance: 1000, box: [100, -100, 900, 800] as const }))],
    characters: characters.map((character, index) => [character, index + 1] as const),
  });
  return textPdfBytes({
    pages: [{ content: `BT /F 10 Tf 100 700 Td <${codes.join('')}> Tj ET`, resources: '/Font<</F 105 0 R>>' }],
    objects: [
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
});

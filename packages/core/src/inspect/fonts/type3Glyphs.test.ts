import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { FontEntry } from './listFonts.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { streamBody } from '../../testing/pdfBuilder.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { listFonts } from './listFonts.ts';

const IMAGE = streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB/BitsPerComponent 8', 'abc');

// A Type 3 font (object 110) whose glyphs a, b and c are the procedures given, with the font's own Resources entry when one is given.
const type3 = (procedures: readonly string[], resources = '', pageResources = ''): FontEntry => {
  const names = ['a', 'b', 'c'].slice(0, procedures.length);
  const charProcs = names.map((name, index) => `/${name} ${String(111 + index)} 0 R`).join('');
  const objects: TestObject[] = [
    {
      number: 110,
      body: `<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<<${charProcs}>>/Encoding<</Differences[97/${names.join('/')}]>>/FirstChar 97/LastChar ${String(96 + names.length)}/Widths[${names.map(() => '1000').join(' ')}]${resources}>>`,
    },
    ...procedures.map((procedure, index) => ({ number: 111 + index, body: procedure })),
    { number: 120, body: IMAGE },
  ];
  const [font] = listFonts(loadDocument(textPdfBytes({ pages: [{ resources: `/Font<</T3 110 0 R>>${pageResources}` }], objects }))).fonts;
  if (font === undefined) throw new Error('the page has no font');
  return font;
};

const VECTOR = streamBody('', '1000 0 0 0 750 750 d1 0 0 750 750 re f');
const IMAGE_DO = streamBody('', '1000 0 d0 q 750 0 0 750 0 0 cm /Im0 Do Q');
const INLINE = streamBody('', '1000 0 0 0 750 750 d1 BI /W 1 /H 1 /IM true ID \u0000 EI');

describe('glyph procedures of Type 3 fonts', () => {
  it('classifies procedures of paths as vector', () => {
    expect(type3([VECTOR]).type3).toStrictEqual({ glyphs: 'vector', procedures: 1, coloured: 0 });
  });

  it('classifies a procedure that draws an image XObject or an inline image as image, and counts d0 procedures as coloured', () => {
    const drawn = type3([IMAGE_DO], '/Resources<</XObject<</Im0 120 0 R>>>>');
    const inline = type3([INLINE]);
    expect([drawn.type3, inline.type3]).toStrictEqual([
      { glyphs: 'image', procedures: 1, coloured: 1 },
      { glyphs: 'image', procedures: 1, coloured: 0 },
    ]);
  });

  it('classifies a font with both kinds of procedure as mixed', () => {
    expect(type3([VECTOR, IMAGE_DO], '/Resources<</XObject<</Im0 120 0 R>>>>').type3).toStrictEqual({ glyphs: 'mixed', procedures: 2, coloured: 1 });
  });

  it('classifies a font with a procedure that is not a stream as unreadable', () => {
    expect(type3([VECTOR, '42']).type3).toStrictEqual({ glyphs: 'unreadable', procedures: 2, coloured: 0 });
  });

  it('looks up the names of a font without Resources in the page resources, and reports that it does', () => {
    const inherited = type3([IMAGE_DO], '', '/XObject<</Im0 120 0 R>>');
    const unnamed = type3([VECTOR]);
    expect([inherited.type3?.glyphs, inherited.problems.map(problem => problem.code), unnamed.problems]).toStrictEqual([
      'image',
      ['type3-resources-inherited'],
      [],
    ]);
  });

  it('takes the page resources for a font whose Resources is not a dictionary, as content interpretation does', () => {
    const font = type3([IMAGE_DO], '/Resources[]', '/XObject<</Im0 120 0 R>>');
    expect([font.type3?.glyphs, font.problems.map(problem => problem.code)]).toStrictEqual(['image', ['type3-resources-inherited']]);
  });

  it('reports no glyph classification for fonts that are not Type 3', () => {
    const [font] = listFonts(loadDocument(textPdfBytes({ pages: [{ resources: '/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>' }] }))).fonts;
    expect(font?.type3).toBeUndefined();
  });
});

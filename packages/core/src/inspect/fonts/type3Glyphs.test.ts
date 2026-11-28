import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { FontEntry } from './listFonts.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { streamBody } from '../../testing/pdfBuilder.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { listFonts } from './listFonts.ts';

const IMAGE = streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB/BitsPerComponent 8', 'abc');
const FORM = streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]', '0 0 1 1 re f');
const GLYPH_NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];

// A Type 3 font (object 110) whose glyphs a to f are the procedures given, with the font's own Resources entry when one is given; object 120 is an image and 121 a form.
const type3 = (procedures: ReadonlyArray<string>, resources = '', pageResources = ''): FontEntry => {
  const names = GLYPH_NAMES.slice(0, procedures.length);
  const charProcs = names.map((name, index) => `/${name} ${String(111 + index)} 0 R`).join('');
  const objects: Array<TestObject> = [
    {
      number: 110,
      body: `<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<<${charProcs}>>/Encoding<</Differences[97/${names.join('/')}]>>/FirstChar 97/LastChar ${String(96 + names.length)}/Widths[${names.map(() => '1000').join(' ')}]${resources}>>`,
    },
    ...procedures.map((procedure, index) => ({ number: 111 + index, body: procedure })),
    { number: 120, body: IMAGE },
    { number: 121, body: FORM },
  ];
  const [font] = listFonts(loadDocument(textPdfBytes({ pages: [{ resources: `/Font<</T3 110 0 R>>${pageResources}` }], objects }))).fonts;
  if (font === undefined) {
    throw new Error('the page has no font');
  }
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
    const { fonts } = listFonts(loadDocument(textPdfBytes({ pages: [{ resources: '/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>' }] })));
    expect(fonts.map(font => [font.subtype, font.type3])).toStrictEqual([['Type1', undefined]]);
  });

  // ISO 32000-1:2008, 7.8.3: these operators look their name operands up in a resource dictionary; colour space family names and inline dictionaries are not resource names.
  it.each([
    ['/F1 1 Tf', true],
    ['/GS0 gs', true],
    ['/Sh0 sh', true],
    ['/CS0 cs', true],
    ['/CS0 CS', true],
    ['1 /P0 scn', true],
    ['/P0 SCN', true],
    ['/OC /MC0 BDC EMC', true],
    ['/OC /MC0 DP', true],
    ['BI /CS /CS0 /W 1 /H 1 /BPC 8 ID \u0000 EI', true],
    ['BI /ColorSpace /CS0 /W 1 /H 1 /BPC 8 ID \u0000 EI', true],
    ['/DeviceRGB cs', false],
    ['/Pattern CS', false],
    ['0.5 scn', false],
    ['/OC <</Type/OCMD>> BDC EMC', false],
    ['BI /CS /G /W 1 /H 1 /BPC 8 ID \u0000 EI', false],
    ['0 0 1 1 re f', false],
  ])('reports a font without Resources whose procedure runs %s as inheriting the page resources: %s', (operations, inherits) => {
    const font = type3([streamBody('', `1000 0 d0 ${operations}`)]);
    expect(font.problems.map(problem => problem.code)).toStrictEqual(inherits ? ['type3-resources-inherited'] : []);
  });

  it('does not report a font with Resources whose procedures name resources as inheriting', () => {
    expect(type3([streamBody('', '1000 0 d0 /F1 1 Tf')], '/Resources<<>>').problems).toStrictEqual([]);
  });

  // ISO 32000-1:2008, 7.3.7: a null value is the same as an absent entry; 7.3.10: a reference to an object that does not exist is a reference to null.
  it.each([
    ['null', '/Resources null'],
    ['a reference to an object that does not exist', '/Resources 999 0 R'],
  ])('takes the page resources for a font whose Resources is %s', (_, resources) => {
    const font = type3([IMAGE_DO], resources, '/XObject<</Im0 120 0 R>>');
    expect([font.type3?.glyphs, font.problems.map(problem => problem.code)]).toStrictEqual(['image', ['type3-resources-inherited']]);
  });

  it('classifies a procedure that draws a form as vector', () => {
    expect(type3([streamBody('', '1000 0 d0 /Fm0 Do')], '/Resources<</XObject<</Fm0 121 0 R>>>>').type3).toStrictEqual({
      glyphs: 'vector',
      procedures: 1,
      coloured: 1,
    });
  });

  // ISO 32000-1:2008, 9.6.5: d0 or d1 "shall be the first operator in a glyph description".
  it.each([
    ['d0 after another operator', 'q 1000 0 d0 Q'],
    ['nothing', ''],
  ])('counts a procedure of %s as not coloured', (_, procedure) => {
    expect(type3([streamBody('', procedure)]).type3).toStrictEqual({ glyphs: 'vector', procedures: 1, coloured: 0 });
  });

  it.each([
    ['data that does not inflate', streamBody('/Filter/FlateDecode', 'not deflated')],
    ['an object that cannot be read', '<</A [ 1 2'],
  ])('classifies a font with a procedure of %s as unreadable', (_, procedure) => {
    expect(type3([VECTOR, procedure]).type3).toStrictEqual({ glyphs: 'unreadable', procedures: 2, coloured: 0 });
  });

  it('classifies a font with an image procedure and an unreadable one as unreadable', () => {
    expect(type3([IMAGE_DO, '42'], '/Resources<</XObject<</Im0 120 0 R>>>>').type3).toStrictEqual({ glyphs: 'unreadable', procedures: 2, coloured: 1 });
  });

  it('classifies a font without CharProcs as vector with no procedures', () => {
    const body =
      '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]>>';
    const { fonts } = listFonts(loadDocument(textPdfBytes({ pages: [{ resources: '/Font<</T3 110 0 R>>' }], objects: [{ number: 110, body }] })));
    expect(fonts.map(font => font.type3)).toStrictEqual([{ glyphs: 'vector', procedures: 0, coloured: 0 }]);
  });
});

describe('properties', () => {
  // Each kind of procedure, whether it begins with d0, and what it paints.
  const KINDS = {
    'd1 path': { procedure: VECTOR, coloured: false, paints: 'vector' },
    'd0 path': { procedure: streamBody('', '1000 0 d0 0 0 1 1 re f'), coloured: true, paints: 'vector' },
    'd0 image': { procedure: IMAGE_DO, coloured: true, paints: 'image' },
    'd1 inline image': { procedure: INLINE, coloured: false, paints: 'image' },
    'd0 form': { procedure: streamBody('', '1000 0 d0 /Fm0 Do'), coloured: true, paints: 'vector' },
    'not a stream': { procedure: '42', coloured: false, paints: 'unreadable' },
  } as const;
  const kinds = fc.array(fc.constantFrom(...Object.values(KINDS)), { minLength: 1, maxLength: GLYPH_NAMES.length });

  it('summarises the procedures whatever their order: their number, the d0 ones, and what they paint', () => {
    fc.assert(
      fc.property(kinds, chosen => {
        const paints = new Set(chosen.map(kind => kind.paints));
        let glyphs = 'vector';
        if (paints.has('unreadable')) {
          glyphs = 'unreadable';
        } else if (paints.has('image')) {
          glyphs = paints.has('vector') ? 'mixed' : 'image';
        }
        const expected = { glyphs, procedures: chosen.length, coloured: chosen.filter(kind => kind.coloured).length };
        const resources = '/Resources<</XObject<</Im0 120 0 R/Fm0 121 0 R>>>>';
        const summaries = [chosen, chosen.toReversed()].map(
          order =>
            type3(
              order.map(kind => kind.procedure),
              resources,
            ).type3,
        );
        expect(summaries).toStrictEqual([expected, expected]);
      }),
    );
  });
});

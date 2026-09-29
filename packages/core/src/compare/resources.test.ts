import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PdfDifference } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { cmyk } from '../document/color.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const pdfBytes = (resources: string, extra: readonly TestObject[] = []): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
        { number: 3, body: `<</Type/Page/Parent 2 0 R/Resources ${resources}>>` },
        ...extra,
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

const load = (resources: string, extra: readonly TestObject[] = []): ReturnType<typeof loadDocument> => loadDocument(pdfBytes(resources, extra));

const kinds = (differences: readonly PdfDifference[]): string[] => differences.map(difference => difference.kind);

const helvetica = { number: 8, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>' };
const courier = { number: 9, body: '<</Type/Font/Subtype/Type1/BaseFont/Courier>>' };
const form = (data: string, filter = ''): TestObject => ({ number: 10, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 1 1]${filter}`, data) });

const image = (data: string): ReturnType<typeof load> =>
  load('<</XObject<</I1 10 0 R>>>>', [{ number: 10, body: streamBody('/Subtype/Image/Filter/DCTDecode', data) }]);

const filtered = (filter: string): ReturnType<typeof load> =>
  load('<</XObject<</X1 10 0 R>>>>', [form('302030206D>', '/Filter 6 0 R'), { number: 6, body: filter }]);

const encoded = (encoding: string, extra: readonly TestObject[] = []): ReturnType<typeof load> =>
  load('<</Font<</F1 8 0 R>>>>', [{ number: 8, body: `<</Type/Font/Subtype/Type1/BaseFont/Custom/Encoding${encoding}>>` }, ...extra]);

describe('resource and font comparison', () => {
  it('compares resources as values, whether direct or indirect and however numbered', () => {
    const direct = load('<</Font<</F1 8 0 R>>/ExtGState<</GS1<</CA 1>>>>>>', [helvetica]);
    const indirect = load('7 0 R', [
      { number: 7, body: '<</ExtGState<</GS1<</CA 1.0>>>>/Font<</F1 11 0 R>>>>' },
      { ...helvetica, number: 11 },
    ]);
    expect(compareDocuments(direct, indirect).differences).toStrictEqual([]);
  });

  it('reports an added colour space with its path from the page', () => {
    const source = load('<<>>');
    const edited = load('<<>>');
    const spot = edited.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 1) });
    edited.page(0).appendContent(builder => {
      builder.fillColor(spot, 1);
    });
    const saved = loadDocument(edited.save().chunks);
    const differences = compareDocuments(source, saved).differences.filter(difference => difference.kind === 'page-resources');
    expect(differences).toMatchObject([
      { kind: 'page-resources', page: 0, path: ['Resources', 'ColorSpace'], a: { kind: 'absent' }, b: { kind: 'dictionary' } },
    ]);
  });

  it('descends into referenced objects whose own bytes a save left in place', () => {
    const objects = [{ number: 7, body: '<</ColorSpace 9 0 R/Font<</F1 8 0 R>>>>' }, { number: 9, body: '<<>>' }, helvetica];
    const bytes = pdfBytes('7 0 R', objects);
    const edited = loadDocument(bytes);
    const spot = edited.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 1) });
    edited.page(0).appendContent(builder => {
      builder.fillColor(spot, 1);
    });
    const saved = loadDocument(edited.save().chunks);
    const { differences } = compareDocuments(loadDocument(bytes), saved, { include: ['resources'] });
    expect(differences).toMatchObject([{ kind: 'page-resources', page: 0, path: ['Resources', 'ColorSpace', 'CS1'], a: { kind: 'absent' } }]);
  });

  it('reports a change to an object that an unchanged resource dictionary references', () => {
    const objects = [{ number: 7, body: '<</Font<</F1 8 0 R>>>>' }, helvetica];
    const bytes = pdfBytes('7 0 R', objects);
    const edited = loadDocument(bytes);
    const font = { kind: 'reference', objectNumber: 8, generation: 0 } as const;
    edited.set(font, { kind: 'dictionary', entries: new PdfDictionaryEntries([[pdfName('Subtype').bytes, pdfName('TrueType')]]) });
    const { differences } = compareDocuments(loadDocument(bytes), edited, { include: ['resources'] });
    expect(differences).toContainEqual(expect.objectContaining({ kind: 'page-resources', path: ['Resources', 'Font', 'F1', 'Subtype'] }));
  });

  it('compares the filters a form names indirectly by what they resolve to', () => {
    const [hex, plain] = [filtered('/ASCIIHexDecode'), filtered('null')];
    expect(kinds(compareDocuments(hex, plain).differences)).toStrictEqual(['page-resources']);
  });

  it('reports fonts added to a page and to the document', () => {
    const one = load('<</Font<</F1 8 0 R>>>>', [helvetica]);
    const two = load('<</Font<</F1 8 0 R/F2 9 0 R>>>>', [helvetica, courier]);
    const fonts = compareDocuments(one, two, { include: ['fonts'] }).differences;
    const added = { subtype: 'Type1', baseFont: 'Courier', encoding: '', program: '' };
    expect(fonts).toStrictEqual([
      { kind: 'font-set', page: 0, added: [added], removed: [] },
      { kind: 'font-set', page: 'document', added: [added], removed: [] },
    ]);
  });

  it('identifies a font encoding by value, however ordered or numbered', () => {
    const one = encoded('<</Type/Encoding/BaseEncoding/WinAnsiEncoding/Differences[32/space/a#00b]>>');
    const two = encoded('<</Differences 12 0 R/BaseEncoding/WinAnsiEncoding/Type/Encoding>>', [{ number: 12, body: '[32/space/a#00b]' }]);
    expect(compareDocuments(one, two, { include: ['fonts'] }).differences).toStrictEqual([]);
  });

  it('finds fonts through graphics states, soft masks and annotation appearances', () => {
    const appearance = { number: 13, body: streamBody('/Subtype/Form/BBox[0 0 1 1]/Resources<</Font<</F1 9 0 R>>>>', '') };
    const withFonts = [
      loadDocument(pdfBytes('<</ExtGState<</GS1<</Font[9 0 R 12]>>>>>>', [courier])),
      loadDocument(pdfBytes('<</ExtGState<</GS1<</SMask<</S/Luminosity/G 13 0 R>>>>>>>>', [courier, appearance])),
      loadDocument(pdfBytes('<<>>/Annots[<</Subtype/Square/Rect[0 0 1 1]/AP<</N<</On 13 0 R>>>>>>]', [courier, appearance])),
    ];
    const empty = load('<<>>');
    const fonts = withFonts.map(document => compareDocuments(empty, document, { include: ['fonts'] }).differences.length);
    expect(fonts).toStrictEqual([2, 2, 2]);
  });

  it('includes pages only one document has in the document font set', () => {
    const one = load('<<>>');
    const two = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 100 100]>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R/Resources<<>>>>' },
            { number: 4, body: '<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 9 0 R>>>>>>' },
            courier,
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect(compareDocuments(one, two, { include: ['fonts'] }).differences).toMatchObject([
      { kind: 'font-set', page: 'document', added: [{ baseFont: 'Courier' }] },
    ]);
  });

  it('treats a form recompressed or respaced as equal, and reports data it cannot decode', () => {
    const plain = load('<</XObject<</X1 10 0 R>>>>', [form('0 0 m 1 1 l S')]);
    const deflated = latin1Text(deflateZlib(latin1Bytes('0  0 m\n1 1 l S')));
    const compressed = load('<</XObject<</X1 10 0 R>>>>', [form(deflated, '/Filter/FlateDecode')]);
    const [first, same, other] = [image('aa'), image('aa'), image('ab')];
    const recompressed = compareDocuments(plain, compressed).differences;
    const unchanged = compareDocuments(first, same).differences;
    const changed = compareDocuments(first, other).differences;
    expect([kinds(recompressed), kinds(unchanged), kinds(changed)]).toStrictEqual([[], [], ['undecodable', 'undecodable']]);
  });
});

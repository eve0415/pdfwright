import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PdfDifference } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { cmyk } from '../document/color.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const load = (resources: string, extra: readonly TestObject[] = []): ReturnType<typeof loadDocument> =>
  loadDocument(
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
    ]).bytes,
  );

const kinds = (differences: readonly PdfDifference[]): string[] => differences.map(difference => difference.kind);

const helvetica = { number: 8, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>' };
const courier = { number: 9, body: '<</Type/Font/Subtype/Type1/BaseFont/Courier>>' };
const form = (data: string, filter = ''): TestObject => ({ number: 10, body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 1 1]${filter}`, data) });

const image = (data: string): ReturnType<typeof load> =>
  load('<</XObject<</I1 10 0 R>>>>', [{ number: 10, body: streamBody('/Subtype/Image/Filter/DCTDecode', data) }]);

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

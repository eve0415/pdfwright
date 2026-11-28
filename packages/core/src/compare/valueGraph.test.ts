import type { LoadedDocument } from '../document/loadDocument.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { ValueSummary } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { PdfDictionaryEntries, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const catalog = (extra: string): TestObject => ({ number: 1, body: `<</Type/Catalog/Pages 2 0 R${extra}>>` });

const pdf = (objects: ReadonlyArray<TestObject>): Uint8Array => buildPdf([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }]).bytes;

const outline = (items: number, lastTitle: string): Uint8Array => {
  const objects: Array<TestObject> = [
    catalog('/Outlines 4 0 R'),
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]/Resources<<>>>>' },
    { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    { number: 4, body: `<</Type/Outlines/First 10 0 R/Last ${String(9 + items)} 0 R/Count ${String(items)}>>` },
  ];
  for (let index = 0; index < items; index++) {
    const links = [index > 0 ? `/Prev ${String(9 + index)} 0 R` : '', index < items - 1 ? `/Next ${String(11 + index)} 0 R` : ''].join('');
    const title = index === items - 1 ? lastTitle : `item ${String(index)}`;
    objects.push({ number: 10 + index, body: `<</Title(${title})/Parent 4 0 R/Dest[3 0 R/Fit]${links}>>` });
  }
  return pdf(objects);
};

const sharedResources = (font: string): Uint8Array =>
  pdf([
    catalog(''),
    { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]/Resources 7 0 R>>' },
    { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
    { number: 7, body: '<</Font<</F1 8 0 R>>>>' },
    { number: 8, body: font },
  ]);

const withPage = (entries: string, objects: ReadonlyArray<TestObject> = []): LoadedDocument =>
  loadDocument(
    pdf([
      catalog(''),
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]/Resources<<>>>>' },
      { number: 3, body: `<</Type/Page/Parent 2 0 R${entries}>>` },
      ...objects,
    ]),
  );

const chained = (target: string): Uint8Array =>
  pdf([
    catalog(''),
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]>>' },
    { number: 3, body: '<</Type/Page/Parent 2 0 R/Tabs 5 0 R>>' },
    { number: 5, body: '6 0 R' },
    { number: 6, body: target },
  ]);

const cyclic = (body: string): LoadedDocument => withPage('/Foo 20 0 R', [{ number: 20, body }]);

const cycle = (value: string): LoadedDocument =>
  loadDocument(
    pdf([
      catalog(''),
      { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/Foo 20 0 R>>' },
      { number: 4, body: '<</Type/Page/Parent 2 0 R/Foo 21 0 R>>' },
      { number: 20, body: '[21 0 R 22 0 R]' },
      { number: 21, body: '[20 0 R]' },
      { number: 22, body: `(${value})` },
    ]),
  );

const xObject = (subtype: string, data: string): LoadedDocument =>
  withPage('/Resources<</XObject<</X1 10 0 R>>>>', [{ number: 10, body: streamBody(`/Subtype/${subtype}/BBox[0 0 1 1]/Width 1/Height 1`, data) }]);

// The summary of the first document's side of a page attribute whose serialized text has the given length.
const summary = (length: number): ValueSummary | undefined => {
  const [difference] = compareDocuments(withPage(`/Foo(${'a'.repeat(length - 2)})`), withPage('/Foo 1')).differences;
  return difference?.kind === 'page-attribute' ? difference.a : undefined;
};

const image = (): LoadedDocument =>
  withPage('/Resources<</XObject<</I1 10 0 R>>>>', [{ number: 10, body: streamBody('/Subtype/Image/Width 1/Height 1', 'abc') }]);

// The image replaced by a stream that the document produces on save, as image colour conversion replaces one.
const produced = (data: string): LoadedDocument => {
  const document = image();
  const dictionary = new PdfDictionaryEntries([
    [pdfName('Subtype').bytes, pdfName('Image')],
    [pdfName('Width').bytes, pdfInteger(1)],
    [pdfName('Height').bytes, pdfInteger(1)],
  ]);
  internalsOf(document)?.objects.setProduced(pdfReference(10, 0), dictionary, function* produce() {
    yield latin1Bytes(data);
  });
  return document;
};

describe('value graph comparison', () => {
  it('follows reference chains far deeper than a call stack allows', () => {
    const one = loadDocument(outline(10_000, 'last'));
    const two = loadDocument(outline(10_000, 'changed'));
    const { differences } = compareDocuments(one, two, { include: ['documentAttributes'] });
    expect(differences).toMatchObject([{ kind: 'document-attribute', a: { text: '(last)' }, b: { text: '(changed)' } }]);
    expect(differences[0]).toHaveProperty('path.length', 10_003);
  });

  it('reports a change to a shared object on every page that reaches it', () => {
    const one = loadDocument(sharedResources('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'));
    const two = loadDocument(sharedResources('<</Type/Font/Subtype/Type1/BaseFont/Courier>>'));
    const { differences } = compareDocuments(one, two, { include: ['resources'] });
    expect(differences).toMatchObject([
      { kind: 'page-resources', page: 0, path: ['Resources', 'Font', 'F1', 'BaseFont'] },
      { kind: 'page-resources', page: 1, path: ['Resources', 'Font', 'F1', 'BaseFont'] },
    ]);
  });

  it('reports an object that cannot be parsed as undecodable', () => {
    const bytes = sharedResources('<</Type/Font/Subtype [1 2>>');
    const { differences } = compareDocuments(loadDocument(bytes), loadDocument(Uint8Array.from(bytes)), { include: ['resources'] });
    expect(differences).toMatchObject([
      { kind: 'undecodable', where: ['page', 0, 'Resources', 'Font', 'F1'], document: 'a' },
      { kind: 'undecodable', where: ['page', 0, 'Resources', 'Font', 'F1'], document: 'b' },
      { kind: 'undecodable', where: ['page', 1, 'Resources', 'Font', 'F1'], document: 'a' },
      { kind: 'undecodable', where: ['page', 1, 'Resources', 'Font', 'F1'], document: 'b' },
    ]);
  });

  it('follows an object whose value is a reference to what that names', () => {
    const { differences } = compareDocuments(loadDocument(chained('/R')), loadDocument(chained('/S')), { include: ['pageAttributes'] });
    expect(differences).toMatchObject([{ kind: 'page-attribute', path: ['Tabs'], a: { text: '/R' }, b: { text: '/S' } }]);
  });

  it('reports arrays of different lengths once, without comparing their items', () => {
    expect(compareDocuments(withPage('/Foo[1 2]'), withPage('/Foo[1 2 3]')).differences).toStrictEqual([
      { kind: 'page-attribute', page: 0, path: ['Foo'], a: { kind: 'array', text: '2 items' }, b: { kind: 'array', text: '3 items' } },
    ]);
  });

  it('compares objects in a reference cycle and ends the cycle', () => {
    expect([
      compareDocuments(cyclic('[20 0 R]'), cyclic('[20 0 R]')).differences,
      compareDocuments(cyclic('[20 0 R 1]'), cyclic('[20 0 R 2]')).differences,
    ]).toStrictEqual([[], [{ kind: 'page-attribute', page: 0, path: ['Foo', 1], a: { kind: 'integer', text: '1' }, b: { kind: 'integer', text: '2' } }]]);
  });

  it('does not settle a pair that was compared while a pair it leads back to was still open', () => {
    const change = { a: { kind: 'string', text: '(v1)' }, b: { kind: 'string', text: '(v2)' } };
    expect(compareDocuments(cycle('v1'), cycle('v2'), { include: ['pageAttributes'] }).differences).toStrictEqual([
      { kind: 'page-attribute', page: 0, path: ['Foo', 1], ...change },
      { kind: 'page-attribute', page: 1, path: ['Foo', 0, 1], ...change },
    ]);
  });

  // ISO 32000-1:2008, 7.3.10: a reference that leads back to itself names no object, so it reads as absent.
  it('reads a reference chain that returns to itself as absent', () => {
    const looped = withPage('/Tabs 5 0 R', [{ number: 5, body: '5 0 R' }]);
    expect([compareDocuments(looped, withPage('')).differences, compareDocuments(looped, withPage('/Tabs/R')).differences]).toStrictEqual([
      [],
      [{ kind: 'page-attribute', page: 0, path: ['Tabs'], a: { kind: 'absent', text: '' }, b: { kind: 'name', text: '/R' } }],
    ]);
  });

  // ISO 32000-1:2008, 8.10: a form's data is a content stream, so only a form compares operation by operation.
  it('compares the data of a form by operations and of other streams by decoded bytes', () => {
    expect([
      compareDocuments(xObject('Form', '0 0 m'), xObject('Form', '0  0 m')).differences,
      compareDocuments(xObject('Image', '0 0 m'), xObject('Image', '0  0 m')).differences,
    ]).toStrictEqual([
      [],
      [
        {
          kind: 'page-resources',
          page: 0,
          path: ['Resources', 'XObject', 'X1'],
          a: { kind: 'stream', text: '5 decoded bytes' },
          b: { kind: 'stream', text: '6 decoded bytes' },
        },
      ],
    ]);
  });

  // ISO 32000-1:2008, 7.3.4 and 7.3.5: a literal and a hexadecimal string with the same bytes are the same string, and a name is not a string.
  it.each([
    { a: '/Foo(abc)', b: '/Foo<616263>', differences: [] },
    {
      a: '/Foo(abc)',
      b: '/Foo/abc',
      differences: [{ kind: 'page-attribute', page: 0, path: ['Foo'], a: { kind: 'string', text: '(abc)' }, b: { kind: 'name', text: '/abc' } }],
    },
  ])('compares $a with $b', ({ a, b, differences }) => {
    expect(compareDocuments(withPage(a), withPage(b)).differences).toStrictEqual(differences);
  });

  it('summarizes a value of 120 characters whole and a longer one cut to 117 characters', () => {
    expect([summary(120), summary(121)]).toStrictEqual([
      { kind: 'string', text: `(${'a'.repeat(118)})` },
      { kind: 'string', text: `(${'a'.repeat(116)}...` },
    ]);
  });

  it('summarizes a name that cannot be written back by its kind', () => {
    expect(compareDocuments(withPage('/Foo/a#00b'), withPage('/Foo/a#00c')).differences).toStrictEqual([
      { kind: 'page-attribute', page: 0, path: ['Foo'], a: { kind: 'name', text: 'name' }, b: { kind: 'name', text: 'name' } },
    ]);
  });

  it('compares a stream a document produces on save by the bytes it produces', () => {
    expect([
      compareDocuments(image(), produced('abc'), { include: ['resources'] }).differences,
      compareDocuments(image(), produced('abcd'), { include: ['resources'] }).differences,
    ]).toStrictEqual([
      [],
      [
        {
          kind: 'page-resources',
          page: 0,
          path: ['Resources', 'XObject', 'I1'],
          a: { kind: 'stream', text: '3 stored bytes' },
          b: { kind: 'stream', text: '4 stored bytes' },
        },
      ],
    ]);
  });
});

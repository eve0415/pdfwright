import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { LoadedDocument } from './loadDocument.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { PdfDictionaryEntries, pdfArray, pdfName, pdfReference } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { buildPdf, latin1Text } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';

const load = (objects: ReadonlyArray<TestObject>): LoadedDocument =>
  loadDocument(buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, ...objects], trailer: '/Root 1 0 R' }]).bytes);

const text = (value: PdfObject): string => latin1Text(serializeObject(value, { fractionDigits: 5 }));

const object = (document: LoadedDocument, number: number): string => text(document.get(pdfReference(number, 0)));

const spot = pdfArray([pdfName('Separation'), pdfName('Spot'), pdfName('DeviceCMYK'), pdfReference(20, 0)]);

const twoPages = (resources: string): Array<TestObject> => [
  { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]>>' },
  { number: 3, body: `<</Type/Page/Parent 2 0 R${resources}>>` },
  { number: 4, body: `<</Type/Page/Parent 2 0 R${resources}>>` },
];

const name = (bytes: Uint8Array): string => latin1Text(bytes);

describe('page resources', () => {
  it('adds to the page’s own resources under the first free name', () => {
    const document = load(twoPages('/Resources<</ColorSpace<</CS1 [/DeviceGray]>>>>'));
    expect([name(document.page(0).addResource('ColorSpace', spot)), name(document.page(0).addResource('ColorSpace', spot, { prefix: 'Plate' }))]).toStrictEqual(
      ['CS2', 'Plate1'],
    );
    expect(object(document, 3)).toBe(
      '<</Type/Page/Parent 2 0 R/Resources<</ColorSpace<</CS1[/DeviceGray]/CS2[/Separation /Spot /DeviceCMYK 20 0 R]/Plate1[/Separation /Spot /DeviceCMYK 20 0 R]>>>>>>',
    );
    expect(object(document, 4)).toBe('<</Type/Page/Parent 2 0 R/Resources<</ColorSpace<</CS1[/DeviceGray]>>>>>>');
  });

  it('copies inherited resources into the page and leaves the ancestor alone', () => {
    const objects = twoPages('');
    const document = load([
      { ...objects[0], number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]/Resources<</Font<</F1 9 0 R>>>>>>' },
      ...objects.slice(1),
    ]);
    document.page(0).addResource('ColorSpace', spot);
    expect(object(document, 3)).toBe('<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 9 0 R>>/ColorSpace<</CS1[/Separation /Spot /DeviceCMYK 20 0 R]>>>>>>');
    expect([object(document, 2), document.page(1).resources().has(pdfName('ColorSpace').bytes)]).toStrictEqual([
      '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]/Resources<</Font<</F1 9 0 R>>>>>>',
      false,
    ]);
  });

  it('copies a resources object other pages share and changes an unshared one in place', () => {
    const shared = load([...twoPages('/Resources 9 0 R'), { number: 9, body: '<</ProcSet[/PDF]>>' }]);
    shared.page(0).addResource('ColorSpace', spot);
    expect([object(shared, 3), object(shared, 9), object(shared, 10)]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Resources 10 0 R>>',
      '<</ProcSet[/PDF]>>',
      '<</ProcSet[/PDF]/ColorSpace<</CS1[/Separation /Spot /DeviceCMYK 20 0 R]>>>>',
    ]);
    const [root, first] = twoPages('');
    const single = load([
      { ...root, number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]>>' },
      { ...first, number: 3, body: '<</Type/Page/Parent 2 0 R/Resources 9 0 R>>' },
      { number: 9, body: '<<>>' },
    ]);
    single.page(0).addResource('ColorSpace', spot);
    expect([object(single, 3), object(single, 9)]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Resources 9 0 R>>',
      '<</ColorSpace<</CS1[/Separation /Spot /DeviceCMYK 20 0 R]>>>>',
    ]);
  });

  it('copies a shared category dictionary', () => {
    const document = load([...twoPages('/Resources<</ColorSpace 8 0 R>>'), { number: 8, body: '<</CS1[/DeviceGray]>>' }]);
    document.page(1).addResource('ColorSpace', spot);
    expect([object(document, 4), object(document, 8), object(document, 9)]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Resources<</ColorSpace 9 0 R>>>>',
      '<</CS1[/DeviceGray]>>',
      '<</CS1[/DeviceGray]/CS2[/Separation /Spot /DeviceCMYK 20 0 R]>>',
    ]);
  });

  it('adds a stream value as a new object', () => {
    const document = load(twoPages('/Resources<<>>'));
    const form = {
      kind: 'stream',
      dictionary: new PdfDictionaryEntries([[pdfName('Subtype').bytes, pdfName('Form')]]),
      data: new Uint8Array([0x71, 0x0a]),
    } as const;
    expect(name(document.page(0).addResource('XObject', form))).toBe('X1');
    expect([object(document, 3), document.get(pdfReference(5, 0)).kind]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Resources<</XObject<</X1 5 0 R>>>>>>',
      'stream',
    ]);
  });

  it('changes a category object that no other page reaches in place', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/Resources<</ColorSpace 8 0 R>>>>' },
      { number: 8, body: '<</CS1[/DeviceGray]>>' },
    ]);
    document.page(0).addResource('ColorSpace', spot);
    expect([object(document, 3), object(document, 8), document.get(pdfReference(9, 0))]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Resources<</ColorSpace 8 0 R>>>>',
      '<</CS1[/DeviceGray]/CS2[/Separation /Spot /DeviceCMYK 20 0 R]>>',
      { kind: 'null' },
    ]);
  });

  it.each([
    {
      resources: 'a reference to a missing object, read as absent',
      node: '/Resources<</Font<<>>>>',
      page: '/Resources 9 0 R',
      objects: [],
      unchanged: [],
      stored: 'dictionary',
    },
    {
      resources: 'an indirect dictionary the page shares with its parent node',
      node: '/Resources 9 0 R',
      page: '/Resources 9 0 R',
      objects: [{ number: 9, body: '<</Font<<>>>>' }],
      unchanged: [9],
      stored: 'reference',
    },
    {
      resources: 'an indirect dictionary inherited from the parent node',
      node: '/Resources 9 0 R',
      page: '',
      objects: [{ number: 9, body: '<</Font<<>>>>' }],
      unchanged: [9],
      stored: 'dictionary',
    },
  ])('writes a changed copy onto the page when its resources are $resources', ({ node, page, objects, unchanged, stored }) => {
    const document = load([
      { number: 2, body: `<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]${node}>>` },
      { number: 3, body: `<</Type/Page/Parent 2 0 R${page}>>` },
      { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
      ...objects,
    ]);
    const before = [2, 4, ...unchanged].map(number => object(document, number));
    expect(name(document.page(0).addResource('ColorSpace', spot))).toBe('CS1');
    // ISO 32000-1:2008, 7.7.3.4: a page's own Resources replaces the inherited value, so the page holds the copy and the other pages keep theirs.
    const own = document.get(pdfReference(3, 0));
    expect([
      own.kind === 'dictionary' ? own.entries.get(pdfName('Resources').bytes)?.kind : undefined,
      document.page(0).resources(),
      [2, 4, ...unchanged].map(number => object(document, number)),
    ]).toStrictEqual([
      stored,
      new PdfDictionaryEntries([
        [pdfName('Font').bytes, { kind: 'dictionary', entries: new PdfDictionaryEntries() }],
        [pdfName('ColorSpace').bytes, { kind: 'dictionary', entries: new PdfDictionaryEntries([[pdfName('CS1').bytes, spot]]) }],
      ]),
      before,
    ]);
  });

  it('refuses to add to a page whose ColorSpace category is not a dictionary', () => {
    const document = load(twoPages('/Resources<</ColorSpace 5>>'));
    expect(() => document.page(0).addResource('ColorSpace', spot)).toThrow(ParseError);
  });

  it('refuses to add to a page edited to have Resources that is not a dictionary', () => {
    const document = load(twoPages('/Resources<<>>'));
    const page = document.get(pdfReference(3, 0));
    if (page.kind !== 'dictionary') {
      throw new Error('expected the page to be a dictionary');
    }
    page.entries.set(pdfName('Resources').bytes, { kind: 'integer', value: 5 });
    document.set(pdfReference(3, 0), page);
    expect(() => document.page(0).addResource('ColorSpace', spot)).toThrow(ParseError);
  });

  it.each([
    { taken: 'a null category', resources: '/Resources<</ColorSpace null>>', expected: 'CS1' },
    { taken: 'a reference to a missing object', resources: '/Resources<</ColorSpace 9 0 R>>', expected: 'CS1' },
    { taken: 'CS1 and CS3', resources: '/Resources<</ColorSpace<</CS1[/DeviceGray]/CS3[/DeviceGray]>>>>', expected: 'CS2' },
    { taken: 'CS2 alone', resources: '/Resources<</ColorSpace<</CS2[/DeviceGray]>>>>', expected: 'CS1' },
  ])('names a resource with the lowest free ordinal when the category holds $taken', ({ resources, expected }) => {
    const document = load(twoPages(resources));
    expect(name(document.page(0).addResource('ColorSpace', spot))).toBe(expected);
  });

  it('counts inherited names as taken', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]/Resources<</ColorSpace<</CS1[/DeviceGray]>>>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    ]);
    expect(name(document.page(0).addResource('ColorSpace', spot))).toBe('CS2');
  });
});

type Layout = 'own' | 'shared-object' | 'shared-category' | 'inherited' | 'inherited-object';

const layoutPages = (resources: string): Array<TestObject> => [
  { number: 3, body: `<</Type/Page/Parent 2 0 R${resources}>>` },
  { number: 4, body: `<</Type/Page/Parent 2 0 R${resources}>>` },
];

const layoutNode = (resources: string): TestObject => ({ number: 2, body: `<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]${resources}>>` });

// Two pages under one node whose ColorSpace resources hold `taken`, arranged as `layout` describes.
const layoutObjects = (layout: Layout, taken: string): Array<TestObject> => {
  const category = `<<${taken}>>`;
  if (layout === 'own') {
    return [layoutNode(''), ...layoutPages(`/Resources<</ColorSpace${category}>>`)];
  }
  if (layout === 'shared-object') {
    return [layoutNode(''), ...layoutPages('/Resources 9 0 R'), { number: 9, body: `<</ColorSpace${category}>>` }];
  }
  if (layout === 'shared-category') {
    return [layoutNode(''), ...layoutPages('/Resources<</ColorSpace 8 0 R>>'), { number: 8, body: category }];
  }
  if (layout === 'inherited') {
    return [layoutNode(`/Resources<</ColorSpace${category}>>`), ...layoutPages('')];
  }
  return [layoutNode('/Resources 9 0 R'), ...layoutPages(''), { number: 9, body: `<</ColorSpace${category}>>` }];
};

// The names in a page's ColorSpace resources, following a reference to the category.
const colorSpaceNames = (document: LoadedDocument, index: number): Array<string> => {
  const spaces = document.page(index).resources().get(pdfName('ColorSpace').bytes);
  const resolved = spaces?.kind === 'reference' ? document.get(spaces) : spaces;
  return resolved?.kind === 'dictionary' ? [...resolved.entries.entries()].map(([key]) => name(key)).toSorted() : [];
};

describe('properties', () => {
  it('adds under the lowest free ordinal and leaves the other page’s resources as they were, whatever the sharing', () => {
    fc.assert(
      fc.property(
        fc.subarray([1, 2, 3, 4, 5, 6]),
        fc.constantFrom<Layout>('own', 'shared-object', 'shared-category', 'inherited', 'inherited-object'),
        fc.constantFrom(0, 1),
        (ordinals, layout, index) => {
          const document = load(layoutObjects(layout, ordinals.map(ordinal => `/CS${String(ordinal)}[/DeviceGray]`).join('')));
          const other = [document.page(1 - index).resources(), colorSpaceNames(document, 1 - index)];
          const added = name(document.page(index).addResource('ColorSpace', spot));
          const lowest = [1, 2, 3, 4, 5, 6, 7].find(ordinal => !ordinals.includes(ordinal));
          expect([added, colorSpaceNames(document, index), [document.page(1 - index).resources(), colorSpaceNames(document, 1 - index)]]).toStrictEqual([
            `CS${String(lowest)}`,
            [...ordinals.map(ordinal => `CS${String(ordinal)}`), added].toSorted(),
            other,
          ]);
        },
      ),
    );
  });
});

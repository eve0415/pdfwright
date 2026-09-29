import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { LoadedDocument } from './loadDocument.ts';

import { describe, expect, it } from 'vitest';

import { PdfDictionaryEntries, pdfArray, pdfName, pdfReference } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { buildPdf, latin1Text } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';

const load = (objects: readonly TestObject[]): LoadedDocument =>
  loadDocument(buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, ...objects], trailer: '/Root 1 0 R' }]).bytes);

const text = (value: PdfObject): string => latin1Text(serializeObject(value, { fractionDigits: 5 }));

const object = (document: LoadedDocument, number: number): string => text(document.get(pdfReference(number, 0)));

const spot = pdfArray([pdfName('Separation'), pdfName('Spot'), pdfName('DeviceCMYK'), pdfReference(20, 0)]);

const twoPages = (resources: string): TestObject[] => [
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
});

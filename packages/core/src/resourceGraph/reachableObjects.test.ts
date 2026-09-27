import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it, vi } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { reachableObjects } from './reachableObjects.ts';

const PAGES = [
  { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
  { number: 3, body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R>>' },
  { number: 4, body: streamBody('/Filter 5 0 R', '') },
  { number: 5, body: 'null' },
];

const load = (catalog: string, objects: readonly TestObject[], trailer = ''): LoadedDocument =>
  loadDocument(
    buildPdf([
      { xref: 'classic', objects: [{ number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` }, ...PAGES, ...objects], trailer: `/Root 1 0 R${trailer}` },
    ]).bytes,
  );

const internals = (document: LoadedDocument): DocumentInternals => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new Error('the document has no internals');
  return parts;
};

const numbers = (document: LoadedDocument): readonly number[] =>
  [...reachableObjects(internals(document)).objects.keys()].toSorted((left, right) => left - right);

describe('objects reachable from the trailer', () => {
  it('follows references from the trailer, dictionaries, arrays and stream dictionaries, and not unreferenced objects', () => {
    const document = load(
      '/Metadata 6 0 R',
      [
        { number: 6, body: streamBody('/Type/Metadata/Subtype/XML', '') },
        { number: 7, body: '<</Type/Metadata>>' },
        { number: 8, body: '(info)' },
      ],
      '/Info<</Title 8 0 R>>',
    );
    expect(numbers(document)).toStrictEqual([1, 2, 3, 4, 5, 6, 8]);
  });

  it('counts a reference only when it names the current generation of an in-use object', () => {
    const document = load('/A 6 1 R/B 9 0 R', [{ number: 6, body: '<<>>' }]);
    expect(numbers(document)).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it('walks the document as edited', () => {
    const document = load('/Metadata 6 0 R', [
      { number: 6, body: '<</Next 7 0 R>>' },
      { number: 7, body: '<<>>' },
    ]);
    const added = document.object({ kind: 'dictionary', entries: new PdfDictionaryEntries([]) });
    const catalog = document.catalog();
    catalog.set(pdfName('Added').bytes, added);
    document.set({ kind: 'reference', objectNumber: 1, generation: 0 }, { kind: 'dictionary', entries: catalog });
    document.delete({ kind: 'reference', objectNumber: 6, generation: 0 });
    expect(numbers(document)).toStrictEqual([1, 2, 3, 4, 5, added.objectNumber]);
  });

  it('resolves each object once however often it is referenced', () => {
    const document = load('/A[6 0 R 6 0 R]/B<</C 6 0 R>>', [{ number: 6, body: '<</Self 6 0 R>>' }]);
    const parts = internals(document);
    const resolve = vi.spyOn(parts.objects, 'resolve');
    reachableObjects(parts);
    expect(resolve.mock.calls.filter(([objectNumber]) => objectNumber === 6)).toHaveLength(1);
  });

  it('walks a long chain of references without recursion', () => {
    const chain = Array.from({ length: 20_000 }, (_, index) => ({ number: 10 + index, body: `<</Next ${String(11 + index)} 0 R>>` }));
    expect(numbers(load('/Chain 10 0 R', chain))).toHaveLength(5 + 20_000);
  });

  it('reports a reachable object that cannot be parsed and keeps walking', () => {
    const document = load('/A 6 0 R/B 7 0 R', [
      { number: 6, body: '<</Broken (unterminated' },
      { number: 7, body: '<<>>' },
    ]);
    const { objects, unreadable } = reachableObjects(internals(document));
    expect([objects.has(6), objects.has(7), unreadable.map(({ reference }) => reference.objectNumber)]).toStrictEqual([true, true, [6]]);
  });
});

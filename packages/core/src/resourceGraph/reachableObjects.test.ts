import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it, vi } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { PdfDictionaryEntries, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { reachableObjects } from './reachableObjects.ts';

const PAGES = [
  { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
  { number: 3, body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R>>' },
  { number: 4, body: streamBody('/Filter 5 0 R', '') },
  { number: 5, body: 'null' },
];

const load = (catalog: string, objects: ReadonlyArray<TestObject>, trailer = ''): LoadedDocument =>
  loadDocument(
    buildPdf([
      { xref: 'classic', objects: [{ number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` }, ...PAGES, ...objects], trailer: `/Root 1 0 R${trailer}` },
    ]).bytes,
  );

const internals = (document: LoadedDocument): DocumentInternals => {
  const parts = internalsOf(document);
  if (parts === undefined) {
    throw new Error('the document has no internals');
  }
  return parts;
};

const numbers = (document: LoadedDocument): ReadonlyArray<number> =>
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

  it('starts from the trailer as edited', () => {
    const document = load('', [{ number: 6, body: '<</Producer(new)>>' }], '/Info 7 0 R');
    internals(document).objects.setTrailerEntry(pdfName('Info').bytes, pdfReference(6, 0));
    expect(numbers(document)).toStrictEqual([1, 2, 3, 4, 5, 6]);
  });
  it('does not follow reference syntax inside stream data', () => {
    // ISO 32000-1:2008, 7.3.8.1: a stream's data is a sequence of bytes, so `6 0 R` in it references nothing.
    const document = load('/Metadata 7 0 R', [
      { number: 6, body: '<<>>' },
      { number: 7, body: streamBody('/Type/Metadata/Subtype/XML', '6 0 R') },
    ]);
    expect(numbers(document)).toStrictEqual([1, 2, 3, 4, 5, 7]);
  });

  it('lists an object stored in an object stream with generation 0', () => {
    // ISO 32000-1:2008, 7.5.7: "The generation number of an object stream and of any compressed object shall be zero."
    const document = loadDocument(
      buildPdf([
        {
          xref: 'stream',
          objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R/A 6 0 R>>' }, ...PAGES],
          objectStreams: [{ number: 9, members: [{ number: 6, body: '<</B 7 0 R>>' }] }],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    expect([...reachableObjects(internals(document)).objects].toSorted(([left], [right]) => left - right)).toStrictEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, 0],
    ]);
  });

  it('lists the objects in the order it resolved them', () => {
    const document = load('/A 6 0 R/B 7 0 R', [
      { number: 6, body: '<</C 8 0 R>>' },
      { number: 7, body: '<</D 9 0 R>>' },
      { number: 8, body: '<<>>' },
      { number: 9, body: '<<>>' },
    ]);
    const parts = internals(document);
    const resolve = vi.spyOn(parts.objects, 'resolve');
    const listed = [...reachableObjects(parts).objects.keys()];
    expect(listed).toStrictEqual(resolve.mock.calls.map(([objectNumber]) => objectNumber));
  });
});

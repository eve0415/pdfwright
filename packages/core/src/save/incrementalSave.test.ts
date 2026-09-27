import type { TestSection } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { md5 } from '../hash/md5.ts';
import { pt } from '../length/length.ts';
import { pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const illustratorPage =
  "<</Type/Page/Parent 2 0 R/ArtBox[0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')/MediaBox[0 0 612 792]/Resources<<>>>>";

const base = (extra: Partial<TestSection> = {}): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: illustratorPage },
        { number: 4, body: '(delete me)' },
        { number: 5, body: '<</Producer(test)>>' },
      ],
      trailer: `/Root 1 0 R/Info 5 0 R/ID[<${'11'.repeat(16)}><${'22'.repeat(16)}>]/Private(kept)`,
      ...extra,
    },
  ]).bytes;

const editedBytes = (): Uint8Array => {
  const document = loadDocument(base());
  document.set(pdfReference(5, 0), { kind: 'dictionary', entries: document.catalog() });
  return document.save().toBytes();
};

const lastTrailer = (bytes: Uint8Array): string => latin1Text(bytes).split('trailer').at(-1) ?? '';

describe('incremental save', () => {
  it('returns the source unchanged when nothing changed', () => {
    const source = base();
    const saved = loadDocument(source).save({ mode: 'incremental' });
    expect([saved.mode, saved.chunks.length, saved.chunks[0] === source]).toStrictEqual(['incremental', 1, true]);
  });

  it('writes an update carrying a supplied file identifier even without changes', () => {
    const source = base();
    const pair: [Uint8Array, Uint8Array] = [new Uint8Array(16).fill(0xaa), new Uint8Array(16).fill(0xbb)];
    const saved = loadDocument(source).save({ mode: 'incremental', fileIdentifier: pair });
    const appended = latin1Text(saved.toBytes().subarray(source.length));
    expect(appended).toMatch(/^xref\n0 0\ntrailer\n<<.*\/ID\[<A{32}><B{32}>\]>>/u);
    expect(loadDocument(saved.chunks).structure.sections).toHaveLength(2);
  });

  it('appends changed objects, a classic section and a trailer that copies the previous one', () => {
    const source = base();
    const document = loadDocument(source);
    document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    const saved = document.save();
    const text = latin1Text(saved.toBytes());
    const appended = text.slice(source.length);
    expect([saved.mode, saved.chunks[0] === source, text.startsWith(latin1Text(source))]).toStrictEqual(['incremental', true, true]);
    expect(appended).toContain(
      "3 0 obj\n<</Type/Page/Parent 2 0 R/ArtBox[0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')",
    );
    expect(appended).toMatch(
      /\nxref\n3 1\n\d{10} 00000 n \ntrailer\n<<\/Size 6\/Root 1 0 R\/Info 5 0 R\/Private\(kept\)\/Prev \d+\/ID\[<1{32}><[0-9A-F]{32}>\]>>\nstartxref\n\d+\n%%EOF\n$/u,
    );
    const reloaded = loadDocument(saved.chunks);
    expect([reloaded.structure.status, reloaded.structure.sections.length, reloaded.page(0).boxes().TrimBox.rect]).toStrictEqual([
      'intact',
      2,
      [10, 10, 600, 780],
    ]);
  });

  it('links deleted objects into the free list and numbers new objects above the old Size', () => {
    const document = loadDocument(base());
    document.delete(pdfReference(4, 0));
    const added = document.object(pdfInteger(7));
    const saved = document.save();
    const appended = latin1Text(saved.toBytes().subarray(base().length));
    expect(appended).toMatch(/xref\n0 1\n0000000004 65535 f \n4 1\n0000000000 00001 f \n6 1\n\d{10} 00000 n \n/u);
    const reloaded = loadDocument(saved.chunks);
    expect([added, reloaded.get(pdfReference(4, 0)), reloaded.get(added)]).toStrictEqual([pdfReference(6, 0), { kind: 'null' }, pdfInteger(7)]);
  });

  it('writes identical bytes for identical edits and derives the second file identifier from the update', () => {
    const first = hex(md5(editedBytes()));
    const second = hex(md5(editedBytes()));
    expect(first).toBe(second);
    expect(first).toBe('5b731d37657fe7a600d5dc419af8156c');
  });

  it('keeps XRefStm out of an update to a hybrid file and refuses to update a reconstructed file', () => {
    const hybrid = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
        ],
        trailer: '/Root 1 0 R',
      },
      { xref: 'hybrid', objects: [], objectStreams: [{ number: 4, members: [{ number: 3, body: '(hidden)' }] }], trailer: '/Root 1 0 R' },
    ]);
    const document = loadDocument(hybrid.bytes);
    document.set(pdfReference(3, 0), pdfName('Changed'));
    const saved = document.save();
    const trailer = lastTrailer(saved.toBytes());
    expect([trailer.includes('XRefStm'), loadDocument(saved.chunks).get(pdfReference(3, 0))]).toStrictEqual([false, pdfName('Changed')]);
    const damaged = latin1Text(base()).replace(/startxref\n\d+/u, 'startxref\n3');
    const broken = loadDocument(latin1Bytes(damaged));
    expect(() => broken.save({ mode: 'incremental' })).toThrow(InvalidArgumentError);
  });

  it('appends a cross-reference stream after a cross-reference stream, keeping the PieceInfo bytes of a compressed page', () => {
    const source = buildPdf([
      {
        xref: 'stream',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 9, body: '(private data)' },
        ],
        objectStreams: [
          {
            number: 6,
            members: [
              { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
              { number: 3, body: illustratorPage },
              { number: 4, body: '(gone)' },
            ],
          },
        ],
        trailer: `/Root 1 0 R/ID[<${'33'.repeat(16)}><${'44'.repeat(16)}>]/Private(kept)`,
      },
    ]).bytes;
    const document = loadDocument(source);
    document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    document.delete(pdfReference(4, 0));
    const saved = document.save();
    const appended = latin1Text(saved.toBytes().subarray(source.length));
    expect(appended).toContain(
      "3 0 obj\n<</Type/Page/Parent 2 0 R/ArtBox[0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')",
    );
    expect(appended).toMatch(
      /\n11 0 obj\n<<\/Type\/XRef\/Size 12\/Root 1 0 R\/Private\(kept\)\/Prev \d+\/Index\[0 1 3 2 11 1\]\/W\[1 2 2\]\/ID\[<3{32}><[0-9A-F]{32}>\]\/Length 20>>\nstream\n/u,
    );
    const reloaded = loadDocument(saved.chunks);
    expect([reloaded.structure.sections.map(section => section.kind), reloaded.page(0).boxes().TrimBox.rect, reloaded.get(pdfReference(4, 0))]).toStrictEqual([
      ['stream', 'stream'],
      [10, 10, 600, 780],
      { kind: 'null' },
    ]);
  });
});

import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject, TestSection } from '../testing/pdfBuilder.ts';

import { describe, expect, inject, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { md5 } from '../hash/md5.ts';
import { pt } from '../length/length.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' };
const page = { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792.0]/Contents 4 0 R/Resources<<>>>>' };
const content = { number: 4, body: streamBody('', '0 0 m 10 10 l S') };

// A PDF 1.4 file with one classic section, which a full rewrite writes with a classic table.
const classic = (objects: readonly TestObject[], trailer = '/Root 1 0 R'): Uint8Array =>
  buildPdf([{ xref: 'classic', objects, trailer }], { header: '%PDF-1.4' }).bytes;

const text = (bytes: Uint8Array): string => latin1Text(bytes);

// The number of rows a cross-reference stream holds, from its decoded length and W.
const streamRows = (xref: PdfObject): number => {
  if (xref.kind !== 'stream') return 0;
  const widths = xref.dictionary.get(pdfName('W').bytes);
  const rowBytes = widths?.kind === 'array' ? widths.items.reduce((sum, item) => sum + (item.kind === 'integer' ? item.value : 0), 0) : 0;
  return inflateZlib(xref.data).data.length / rowBytes;
};

const kind = (sections: readonly TestSection[], header: string): string | undefined =>
  loadDocument(loadDocument(buildPdf(sections, { header }).bytes).save({ mode: 'full' }).chunks).structure.lastSectionKind;

// A classic PDF 1.4 file whose update adds one object far above the others, so that no section lists the numbers between.
const sparse = (high: number): Uint8Array =>
  buildPdf(
    [
      { xref: 'classic', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R' },
      { xref: 'classic', objects: [{ number: high, body: '(high)' }], trailer: '/Root 1 0 R' },
    ],
    { header: '%PDF-1.4' },
  ).bytes;

describe('full rewrite', () => {
  it('covers every object number up to a high one with a compressed cross-reference stream', () => {
    const source = buildPdf([{ xref: 'stream', objects: [catalog, pages, page, content, { number: 10_000, body: '(high)' }], trailer: '/Root 1 0 R' }]).bytes;
    const saved = loadDocument(source).save({ mode: 'full' });
    const output = text(saved.toBytes());
    const reloaded = loadDocument(saved.chunks);
    const rows = streamRows(reloaded.get(pdfReference(10_001, 0)));
    expect([
      output.length < 2000,
      output.includes('/Size 10002'),
      output.includes('/Filter/FlateDecode'),
      output.includes('/Index'),
      rows,
      reloaded.get(pdfReference(10_000, 0)),
    ]).toStrictEqual([true, true, true, false, 10_002, { kind: 'string', bytes: latin1Bytes('high'), encoding: 'literal' }]);
  });

  it('covers every object number with a classic table for a classic PDF 1.4 source', () => {
    const saved = loadDocument(sparse(50)).save({ mode: 'full' });
    const output = text(saved.toBytes());
    const unused = output.split('0000000000 65535 f \n').length - 1;
    expect([output.includes('xref\n0 51\n'), unused, loadDocument(saved.chunks).structure.lastSectionKind]).toStrictEqual([true, 46, 'classic']);
  });

  it('writes a cross-reference stream when the source header is 1.5 or later or the source used one', () => {
    const objects = [catalog, pages, page, content];
    const classicSource = [{ xref: 'classic', objects, trailer: '/Root 1 0 R' }] as const;
    const streamSource = [{ xref: 'stream', objects, trailer: '/Root 1 0 R' }] as const;
    const hybridSource = [
      ...classicSource,
      { xref: 'hybrid', objects: [], objectStreams: [{ number: 6, members: [{ number: 5, body: '(hidden)' }] }], trailer: '/Root 1 0 R' },
    ] as const;
    expect([
      kind(classicSource, '%PDF-1.4'),
      kind(classicSource, '%PDF-1.5'),
      kind(classicSource, '%PDF-1.7'),
      kind(streamSource, '%PDF-1.4'),
      kind(hybridSource, '%PDF-1.4'),
    ]).toStrictEqual(['classic', 'stream', 'stream', 'stream', 'stream']);
  });

  it('refuses a classic table that would hold more entries for unused numbers than the limit allows', () => {
    expect(() => loadDocument(sparse(200_000)).save({ mode: 'full' })).toThrow(ResourceLimitError);
    expect(() => loadDocument(sparse(1000)).save({ mode: 'full', maxTableGapEntries: 100 })).toThrow(
      new ResourceLimitError('the cross-reference table would hold 995 entries for unused object numbers, more than maxTableGapEntries (100)'),
    );
    const raised = loadDocument(sparse(200_000)).save({ mode: 'full', maxTableGapEntries: 200_000 });
    expect(loadDocument(raised.chunks).get(pdfReference(200_000, 0))).toStrictEqual({ kind: 'string', bytes: latin1Bytes('high'), encoding: 'literal' });
  });

  it.runIf(inject('runtime') === 'node')(
    'covers eight million object numbers in a small cross-reference stream',
    () => {
      const source = buildPdf([
        { xref: 'stream', objects: [catalog, pages, page, content, { number: 8_000_000, body: '(high)' }], trailer: '/Root 1 0 R' },
      ]).bytes;
      const start = performance.now();
      const saved = loadDocument(source).save({ mode: 'full' });
      const elapsed = performance.now() - start;
      const bytes = saved.toBytes();
      expect([bytes.length < 256 * 1024, elapsed < 20_000, loadDocument(saved.chunks).get(pdfReference(8_000_000, 0)).kind]).toStrictEqual([
        true,
        true,
        'string',
      ]);
    },
    30_000,
  );

  it('sets Size from objects retained after dropping a cross-reference stream', () => {
    const source = buildPdf([{ xref: 'stream', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R', xrefStreamNumber: 10 }]).bytes;
    const output = text(loadDocument(source).save({ mode: 'full' }).toBytes());
    // Objects 1 to 4, and the rewrite's own cross-reference stream as object 5.
    expect(output).toContain('/Size 6');
  });

  it('copies unchanged objects as one run, keeping their numbers', () => {
    const source = classic([catalog, pages, page, content, { number: 7, body: '(seven)' }]);
    const saved = loadDocument(source).save({ mode: 'full' });
    const output = text(saved.toBytes());
    const reloaded = loadDocument(saved.chunks);
    expect([saved.mode, saved.chunks.filter(chunk => chunk.buffer === source.buffer).length, reloaded.structure.status]).toStrictEqual(['full', 1, 'intact']);
    expect(output).toContain('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n');
    expect([reloaded.get(pdfReference(7, 0)), reloaded.structure.lastSectionKind]).toStrictEqual([
      { kind: 'string', bytes: latin1Bytes('seven'), encoding: 'literal' },
      'classic',
    ]);
  });

  it('writes changed and repaired objects after the runs and frees deleted ones', () => {
    const source = classic([catalog, pages, page, { number: 4, body: '<</Length 99>>\nstream\n0 0 m 10 10 l S\nendstream' }, { number: 7, body: '(seven)' }]);
    const document = loadDocument(source);
    document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(100), pt(100)));
    document.delete(pdfReference(7, 0));
    const saved = document.save({ mode: 'full' });
    const output = text(saved.toBytes());
    expect(output).toContain(
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792.0]/Contents 4 0 R/Resources<<>>/TrimBox[10 10 100 100]>>\nendobj\n4 0 obj\n<</Length 15>>\nstream\n0 0 m 10 10 l S\nendstream\nendobj\n',
    );
    const reloaded = loadDocument(saved.chunks);
    reloaded.get(pdfReference(4, 0));
    expect([reloaded.warnings, reloaded.get(pdfReference(7, 0)), output]).toStrictEqual([
      [],
      { kind: 'null' },
      expect.stringMatching(/xref\n0 8\n0000000005 65535 f \n(?:.*\n){6}0000000000 00001 f \ntrailer/u),
    ]);
  });

  it('keeps untouched object streams and unpacks touched ones', () => {
    const source = buildPdf([
      {
        xref: 'stream',
        objects: [catalog],
        objectStreams: [
          { number: 5, members: [pages, page] },
          {
            number: 6,
            members: [
              { number: 8, body: '(eight)' },
              { number: 9, body: '(nine)' },
            ],
          },
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes;
    const document = loadDocument(source);
    document.set(pdfReference(9, 0), pdfName('Changed'));
    const saved = document.save({ mode: 'full' });
    const output = text(saved.toBytes());
    const reloaded = loadDocument(saved.chunks);
    expect([
      output.includes('5 0 obj'),
      output.includes('6 0 obj'),
      output.includes('8 0 obj\n(eight)\nendobj'),
      reloaded.structure.lastSectionKind,
    ]).toStrictEqual([true, false, true, 'stream']);
    expect([reloaded.pageCount, reloaded.get(pdfReference(9, 0)), reloaded.get(pdfReference(6, 0))]).toStrictEqual([1, pdfName('Changed'), { kind: 'null' }]);
  });

  it('keeps an object that reuses the number of an older cross-reference stream', () => {
    const source = buildPdf([
      { xref: 'stream', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R', xrefStreamNumber: 9 },
      { xref: 'stream', objects: [{ number: 9, body: '(reused)' }], trailer: '/Root 1 0 R', xrefStreamNumber: 10 },
    ]).bytes;
    const reloaded = loadDocument(loadDocument(source).save({ mode: 'full' }).chunks);
    expect(reloaded.get(pdfReference(9, 0))).toStrictEqual({ kind: 'string', bytes: latin1Bytes('reused'), encoding: 'literal' });
  });

  it('unpacks an object stream whose member was replaced by a later copy', () => {
    const source = buildPdf([
      {
        xref: 'stream',
        objects: [catalog],
        objectStreams: [{ number: 5, members: [pages, { ...page, body: page.body.replace('612', '200') }] }],
        trailer: '/Root 1 0 R',
      },
      { xref: 'stream', objects: [page, content], trailer: '/Root 1 0 R' },
    ]).bytes;
    const output = text(loadDocument(source).save({ mode: 'full' }).toBytes());
    expect([output.includes('/Type/ObjStm'), output.includes('MediaBox[0 0 200'), output.includes('2 0 obj')]).toStrictEqual([false, false, true]);
  });

  it('drops linearization data and bytes around the file with warnings', () => {
    const linearized = buildPdf(
      [{ xref: 'classic', objects: [{ number: 9, body: '<</Linearized 1/L 999/H[800 20]>>' }, catalog, pages, page, content], trailer: '/Root 1 0 R' }],
      { prefix: 'JUNK' },
    );
    const saved = loadDocument(latin1Bytes(`${linearized.text}garbage`)).save({ mode: 'full' });
    const reloaded = loadDocument(saved.chunks);
    expect([
      saved.warnings.map(warning => warning.code),
      text(saved.toBytes()).startsWith('%PDF-1.7\n'),
      reloaded.get(pdfReference(9, 0)),
      reloaded.structure.status,
    ]).toStrictEqual([['linearization-removed', 'junk-dropped'], true, { kind: 'null' }, 'intact']);
  });

  it('keeps the first file identifier, derives the second, and adds none to a file without one', () => {
    const withId = classic([catalog, pages, page, content], `/Root 1 0 R/ID[<${'aa'.repeat(16)}><${'bb'.repeat(16)}>]`);
    const output = text(loadDocument(withId).save({ mode: 'full' }).toBytes());
    const plain = loadDocument(classic([catalog, pages, page, content]));
    const withoutId = text(plain.save({ mode: 'full' }).toBytes());
    expect([/\/ID\[<A{32}> <[0-9A-F]{32}>\]/u.test(output), withoutId.includes('/ID')]).toStrictEqual([true, false]);
    const again = loadDocument(withId).save({ mode: 'full' }).toBytes();
    const first = hex(md5(latin1Bytes(output)));
    expect(first).toBe(hex(md5(again)));
  });

  it('keeps trailer entries that begin with ID and leaves the stream keys of a reconstructed stream trailer out', () => {
    const seeded = text(
      loadDocument(classic([catalog, pages, page, content], '/Root 1 0 R/IDSeed(keep)'))
        .save({ mode: 'full' })
        .toBytes(),
    );
    const stream = buildPdf([{ xref: 'stream', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R' }]).text.replace(
      /startxref\n\d+/u,
      'startxref\n3',
    );
    const rewritten = text(loadDocument(latin1Bytes(stream)).save({ mode: 'full' }).toBytes());
    const streamKeys = /\/W|\/Index|\/XRef/u.test(rewritten.slice(rewritten.lastIndexOf('trailer')));
    expect([seeded.includes('/IDSeed(keep)'), streamKeys]).toStrictEqual([true, false]);
  });

  it('rewrites a reconstructed file by default', () => {
    const damaged = text(classic([catalog, pages, page, content])).replace(/startxref\n\d+/u, 'startxref\n3');
    const document = loadDocument(latin1Bytes(damaged));
    const saved = document.save();
    expect([document.structure.status, saved.mode, loadDocument(saved.chunks).structure.status]).toStrictEqual(['reconstructed', 'full', 'intact']);
  });
});

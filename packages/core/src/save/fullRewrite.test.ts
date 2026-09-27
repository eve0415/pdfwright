import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { md5 } from '../hash/md5.ts';
import { pt } from '../length/length.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' };
const page = { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792.0]/Contents 4 0 R/Resources<<>>>>' };
const content = { number: 4, body: streamBody('', '0 0 m 10 10 l S') };

const classic = (objects: readonly TestObject[], trailer = '/Root 1 0 R'): Uint8Array => buildPdf([{ xref: 'classic', objects, trailer }]).bytes;

const text = (bytes: Uint8Array): string => latin1Text(bytes);

describe('full rewrite', () => {
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
    expect([output.includes('5 0 obj'), output.includes('MediaBox[0 0 200'), output.includes('2 0 obj')]).toStrictEqual([false, false, true]);
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

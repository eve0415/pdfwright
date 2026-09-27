import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { pt } from '../length/length.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };

const pdf = (objects: readonly TestObject[]): Uint8Array => buildPdf([{ xref: 'classic', objects: [catalog, ...objects], trailer: '/Root 1 0 R' }]).bytes;

const twoPages = pdf([
  { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 600 800]/Resources<<>>>>' },
  { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
  { number: 4, body: '<</Type/Page/Parent 2 0 R/Rotate 90>>' },
]);

describe('document comparison: pages and boxes', () => {
  it('finds no difference between a document and its saves', () => {
    const source = loadDocument(twoPages);
    const incremental = loadDocument(twoPages);
    incremental.page(0).setBox('MediaBox', rect(pt(0), pt(0), pt(600), pt(800)));
    const saved = loadDocument(incremental.save({ mode: 'incremental' }).chunks);
    const full = loadDocument(loadDocument(twoPages).save({ mode: 'full' }).chunks);
    expect([compareDocuments(source, saved), compareDocuments(source, full)]).toStrictEqual([
      { equal: true, differences: [] },
      { equal: true, differences: [] },
    ]);
  });

  it('reports a changed box, Rotate and page count', () => {
    const edited = loadDocument(twoPages);
    edited.page(1).setBox('TrimBox', rect(pt(10), pt(10), pt(500), pt(700)));
    const onePage = loadDocument(
      pdf([
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 600 800]/Resources<<>>>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/Rotate 180>>' },
      ]),
    );
    expect(compareDocuments(loadDocument(twoPages), edited).differences).toStrictEqual([
      { kind: 'page-box', page: 1, box: 'TrimBox', a: { value: [0, 0, 600, 800], explicit: false }, b: { value: [10, 10, 500, 700], explicit: true } },
    ]);
    expect(compareDocuments(loadDocument(twoPages), onePage, { include: ['pages', 'boxes'] }).differences).toStrictEqual([
      { kind: 'page-count', a: 2, b: 1 },
      { kind: 'page-box', page: 0, box: 'Rotate', a: { value: 0, explicit: true }, b: { value: 180, explicit: true } },
    ]);
  });

  it('refuses values that are not loaded documents', () => {
    const source = loadDocument(twoPages);
    expect(() => compareDocuments(source, { ...source })).toThrow(InvalidArgumentError);
  });
});

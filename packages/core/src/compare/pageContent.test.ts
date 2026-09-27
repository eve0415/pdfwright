import type { TestObject } from '../testing/pdfBuilder.ts';
import type { DocumentComparison, PdfDifference } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';
import { operationHashes } from './contentTokens.ts';

const document = (contents: string, streams: readonly TestObject[]): ReturnType<typeof loadDocument> =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]/Resources<<>>>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/Contents ${contents}>>` },
          ...streams,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

const content = (comparison: DocumentComparison): readonly PdfDifference[] => comparison.differences;

const single = document('4 0 R', [{ number: 4, body: streamBody('', '0 0 m 10 10 l S 0.50 g') }]);

describe('page content comparison', () => {
  it('treats content split, compressed or spelled differently as equal', () => {
    const split = document('[4 0 R 5 0 R]', [
      { number: 4, body: streamBody('', '0 0 m 10 10 l') },
      { number: 5, body: streamBody('', 'S .5 g') },
    ]);
    const deflated = latin1Text(deflateZlib(latin1Bytes('0 0 m\n10 10 l\nS\n0.5 g')));
    const compressed = document('4 0 R', [{ number: 4, body: streamBody('/Filter/FlateDecode', deflated) }]);
    expect([content(compareDocuments(single, split)), content(compareDocuments(single, compressed))]).toStrictEqual([[], []]);
  });

  it('reports operation counts and the common prefix and suffix', () => {
    const appended = document('[4 0 R 5 0 R]', [
      { number: 4, body: streamBody('', '0 0 m 10 10 l S 0.50 g') },
      { number: 5, body: streamBody('', '/CS1 cs 1 scn 0 0 5 5 re f') },
    ]);
    const changed = document('4 0 R', [{ number: 4, body: streamBody('', '0 0 m 20 20 l S 0.5 g') }]);
    expect([content(compareDocuments(single, appended)), content(compareDocuments(single, changed))]).toStrictEqual([
      [{ kind: 'page-content', page: 0, operationsA: 4, operationsB: 8, commonPrefix: 4, commonSuffix: 0 }],
      [{ kind: 'page-content', page: 0, operationsA: 4, operationsB: 4, commonPrefix: 1, commonSuffix: 2 }],
    ]);
  });

  it('reads content streams that refer to missing objects as empty', () => {
    const missing = document('[4 0 R 9 0 R]', [{ number: 4, body: streamBody('', '0 0 m 10 10 l S 0.50 g') }]);
    expect(content(compareDocuments(single, missing))).toStrictEqual([]);
  });

  it('reports content that cannot be decoded instead of passing it', () => {
    const encoded = document('4 0 R', [{ number: 4, body: streamBody('/Filter/DCTDecode', 'xx') }]);
    expect(content(compareDocuments(single, encoded))).toStrictEqual([
      { kind: 'undecodable', where: ['page', 0, 'Contents'], document: 'b', reason: 'the DCTDecode filter is not supported for decoding' },
    ]);
  });

  it('hashes inline image data as raw bytes and ignores comments', () => {
    const [first] = operationHashes(latin1Bytes('BI /W 1 /H 1 ID\nab EI % comment\nQ'));
    const same = operationHashes(latin1Bytes('BI /W 1 /H 1 ID\nab EI\nQ'));
    const other = operationHashes(latin1Bytes('BI /W 1 /H 1 ID\nac EI\nQ'));
    expect([same.length, same[0] === first, other[1] === same[1], other[2] === same[2]]).toStrictEqual([3, true, false, true]);
  });
});

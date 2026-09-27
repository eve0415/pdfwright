import type { TestObject } from '../testing/pdfBuilder.ts';
import type { DocumentComparison, PdfDifference } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';
import { contentOperations } from './contentTokens.ts';

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

const filtered = (filter: string): ReturnType<typeof document> =>
  document('4 0 R', [
    { number: 4, body: streamBody('/Filter 6 0 R', '302030206D>') },
    { number: 6, body: filter },
  ]);

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

  it('compares the filters content names indirectly by what they resolve to', () => {
    const [hex, plain] = [filtered('/ASCIIHexDecode'), filtered('null')];
    expect(content(compareDocuments(hex, plain))).toMatchObject([{ kind: 'page-content', page: 0 }]);
  });

  it('holds the joined content of a page under maxDecodedBytes', () => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/Contents[4 0 R 4 0 R 4 0 R]>>' },
          { number: 4, body: streamBody('', '0 0 m 10 10 l S') },
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes;
    const repeated = loadDocument(pdf, { maxDecodedBytes: 40 });
    expect(() => compareDocuments(single, repeated)).toThrow(ResourceLimitError);
  });

  it('treats identical Contents values that are not streams as the same', () => {
    const dictionary = document('4 0 R', [{ number: 4, body: '<</Length 0/Filter[]>>' }]);
    const same = document('4 0 R', [{ number: 4, body: '<</Filter[]/Length 0>>' }]);
    const other = document('4 0 R', [{ number: 4, body: '<</Length 1>>' }]);
    expect([content(compareDocuments(dictionary, same)), content(compareDocuments(dictionary, other)).length]).toStrictEqual([[], 2]);
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

  it('reads inline image data as raw bytes and ignores comments', () => {
    const [first] = contentOperations(latin1Bytes('BI /W 1 /H 1 ID\nab EI % comment\nQ'), 32);
    const same = contentOperations(latin1Bytes('BI /W 1 /H 1 ID\nab EI\nQ'), 32);
    const other = contentOperations(latin1Bytes('BI /W 1 /H 1 ID\nac EI\nQ'), 32);
    expect([same.length, same[0] === first, other[1] === same[1], other[2] === same[2]]).toStrictEqual([3, true, false, true]);
  });

  it('keeps the first byte of ASCII base-85 inline image data that follows ID directly', () => {
    const [, direct] = contentOperations(latin1Bytes('BI /F /A85 ID<~9j~> EI'), 32);
    const [, spaced] = contentOperations(latin1Bytes('BI /F /A85 ID\n<~9j~> EI'), 32);
    expect([direct, spaced]).toStrictEqual(['/46 /413835 ID3c7e396a7e3e ID', '/46 /413835 ID3c7e396a7e3e ID']);
  });

  it('compares operations exactly, so strings no digest could tell apart still differ', () => {
    const thueMorse = Array.from({ length: 32 }, (_, index) => index.toString(2).split('1').length % 2);
    const text = (low: string, high: string): string => thueMorse.map(bit => `${high}${low}`.charAt(bit)).join('');
    const one = document('4 0 R', [{ number: 4, body: streamBody('', `BT <${text('a', 'b')}> Tj ET`) }]);
    const two = document('4 0 R', [{ number: 4, body: streamBody('', `BT <${text('b', 'a')}> Tj ET`) }]);
    expect(content(compareDocuments(one, two))).toMatchObject([{ kind: 'page-content', commonPrefix: 1, commonSuffix: 1 }]);
  });

  it('reports content with operands it cannot read as undecodable', () => {
    const one = document('4 0 R', [{ number: 4, body: streamBody('', '(abc Tj') }]);
    const two = document('4 0 R', [{ number: 4, body: streamBody('', '(abd Tj') }]);
    expect(content(compareDocuments(one, two)).map(difference => difference.kind)).toStrictEqual(['undecodable', 'undecodable']);
  });
});

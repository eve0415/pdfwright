import type { LoadOptions, LoadedDocument } from '../document/loadDocument.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { DocumentComparison, PdfDifference } from './pdfDifference.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';
import { contentOperations } from './contentTokens.ts';

const page = (entries: string, objects: ReadonlyArray<TestObject>, options: LoadOptions = {}): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]/Resources<<>>>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R${entries}>>` },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
    options,
  );

const document = (contents: string, streams: ReadonlyArray<TestObject>): LoadedDocument => page(`/Contents ${contents}`, streams);

const stream = (data: string, options: LoadOptions = {}): LoadedDocument => page('/Contents 4 0 R', [{ number: 4, body: streamBody('', data) }], options);

const content = (comparison: DocumentComparison): ReadonlyArray<PdfDifference> => comparison.differences;

const single = document('4 0 R', [{ number: 4, body: streamBody('', '0 0 m 10 10 l S 0.50 g') }]);

const filtered = (filter: string): ReturnType<typeof document> =>
  document('4 0 R', [
    { number: 4, body: streamBody('/Filter 6 0 R', '302030206D>') },
    { number: 6, body: filter },
  ]);

// A Contents array that names one 15-byte stream three times, so that the joined content is 45 bytes.
const repeated = (maxDecodedBytes: number): LoadedDocument =>
  page('/Contents[4 0 R 4 0 R 4 0 R]', [{ number: 4, body: streamBody('', '0 0 m 10 10 l S') }], { maxDecodedBytes });

// Filter parameters reached through a chain of references, each object an array naming the next.
const chained = (references: number): LoadedDocument => {
  const links = Array.from({ length: references - 1 }, (_, index): TestObject => ({ number: 10 + index, body: `[${String(11 + index)} 0 R]` }));
  return page('/Contents 4 0 R', [{ number: 4, body: streamBody('/DecodeParms 10 0 R', '0 0 m') }, ...links, { number: 9 + references, body: '1' }]);
};

describe('page content comparison', () => {
  it('compares content bytes across stream boundaries without inserting whitespace', () => {
    const split = document('[4 0 R 5 0 R]', [
      { number: 4, body: streamBody('', '1') },
      { number: 5, body: streamBody('', '0 0 m') },
    ]);
    const changed = document('4 0 R', [{ number: 4, body: streamBody('', '1 0 0 m') }]);
    expect(content(compareDocuments(split, changed))).toMatchObject([{ kind: 'page-content', page: 0 }]);
  });

  it('treats content split, compressed or spelled differently as equal', () => {
    const split = document('[4 0 R 5 0 R]', [
      { number: 4, body: streamBody('', '0 0 m 10 10 l ') },
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

  it('resolves filter parameters that share objects or nest deeply without repeated work or call stack', () => {
    const shared = Array.from({ length: 40 }, (_, index): TestObject => ({
      number: 10 + index,
      body: `[${String(11 + index)} 0 R ${String(11 + index)} 0 R]`,
    }));
    const nested = Array.from({ length: 20 }, (_, index): TestObject => ({
      number: 60 + index,
      body: `${'['.repeat(250)}${String(61 + index)} 0 R${']'.repeat(250)}`,
    }));
    const streams = [{ number: 4, body: streamBody('/DecodeParms[10 0 R 60 0 R]', '0 0 m') }, ...shared, ...nested];
    const [one, two] = [document('4 0 R', streams), document('4 0 R', streams)];
    expect(content(compareDocuments(one, two))).toStrictEqual([]);
  });

  it('reads content streams that refer to missing objects as empty', () => {
    const missing = document('[4 0 R 9 0 R]', [{ number: 4, body: streamBody('', '0 0 m 10 10 l S 0.50 g') }]);
    expect(content(compareDocuments(single, missing))).toStrictEqual([]);
  });

  it('reports content that cannot be decoded instead of passing it', () => {
    const encoded = document('4 0 R', [{ number: 4, body: streamBody('/Filter/DCTDecode', 'xx') }]);
    expect(content(compareDocuments(single, encoded))).toMatchObject([{ kind: 'undecodable', where: ['page', 0, 'Contents'], document: 'b' }]);
  });

  it('reads inline image data as raw bytes and ignores comments', () => {
    const commented = contentOperations(latin1Bytes('BI /W 1 /H 1 ID\nab EI % comment\nQ'), 32);
    const same = contentOperations(latin1Bytes('BI /W 1 /H 1 ID\nab EI\nQ'), 32);
    const other = contentOperations(latin1Bytes('BI /W 1 /H 1 ID\nac EI\nQ'), 32);
    expect(commented).toStrictEqual(same);
    expect([same.length, other[0] === same[0], other[1] === same[1], other[2] === same[2]]).toStrictEqual([3, true, false, true]);
  });

  it('keeps an EI sequence inside unfiltered inline image samples', () => {
    const operations = contentOperations(latin1Bytes('BI /W 6 /H 1 /BPC 8 /CS /G ID\nA EI B EI Q'), 32);
    expect(operations).toHaveLength(3);
    expect(operations[1]).toContain('412045492042');
  });

  it('keeps the first byte of ASCII base-85 inline image data that follows ID directly', () => {
    const [, direct] = contentOperations(latin1Bytes('BI /F /A85 ID<~9j~> EI'), 32);
    const [, spaced] = contentOperations(latin1Bytes('BI /F /A85 ID\n<~9j~> EI'), 32);
    expect([direct, spaced]).toStrictEqual(['/46 /413835 ID3c7e396a7e3e ID', '/46 /413835 ID3c7e396a7e3e ID']);
  });

  it('compares operations exactly, so strings that a checksum could not tell apart still differ', () => {
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

  it.each([
    { a: 'q Q', b: 'q Q q Q', difference: { operationsA: 2, operationsB: 4, commonPrefix: 2, commonSuffix: 0 } },
    { a: '0 0 m S', b: '0 0 m S S', difference: { operationsA: 2, operationsB: 3, commonPrefix: 2, commonSuffix: 0 } },
    { a: '1 g', b: '2 g', difference: { operationsA: 1, operationsB: 1, commonPrefix: 0, commonSuffix: 0 } },
    { a: '/P <</MCID 1>> BDC EMC', b: '/P <</MCID 0>> BDC EMC', difference: { operationsA: 2, operationsB: 2, commonPrefix: 0, commonSuffix: 1 } },
    { a: 'BT (a) Tj ET', b: 'BT <62> Tj ET', difference: { operationsA: 3, operationsB: 3, commonPrefix: 1, commonSuffix: 1 } },
    { a: '] Q', b: 'Q', difference: { operationsA: 1, operationsB: 1, commonPrefix: 0, commonSuffix: 0 } },
  ])('reports $a against $b with a common prefix and suffix that do not overlap', ({ a, b, difference }) => {
    expect(content(compareDocuments(stream(a), stream(b)))).toStrictEqual([{ kind: 'page-content', page: 0, ...difference }]);
  });

  it.each([
    ['1 g', '1.0 g'],
    ['/P <</MCID 0/X 1>> BDC EMC', '/P <</X 1/MCID 0>> BDC EMC'],
    ['BT (a) Tj ET', 'BT <61> Tj ET'],
  ])('treats %s and %s as the same operations', (a, b) => {
    expect(content(compareDocuments(stream(a), stream(b)))).toStrictEqual([]);
  });

  it('holds the joined content at exactly maxDecodedBytes and refuses one byte more', () => {
    expect(content(compareDocuments(single, repeated(45))).map(difference => difference.kind)).toStrictEqual(['page-content']);
    expect(() => compareDocuments(single, repeated(44))).toThrow(ResourceLimitError);
  });

  it('treats a page without Contents like one with empty content', () => {
    expect([content(compareDocuments(page('', []), stream(''))), content(compareDocuments(page('', []), page('', [])))]).toStrictEqual([[], []]);
  });

  // ISO 32000-1:2008, 7.7.3.3, Table 30: Contents is a stream or an array of streams.
  it('reports a Contents value that is not a stream in the document that holds it', () => {
    const integer = page('/Contents 4 0 R', [{ number: 4, body: '7' }]);
    expect(content(compareDocuments(integer, stream('0 0 m')))).toMatchObject([{ kind: 'undecodable', where: ['page', 0, 'Contents'], document: 'a' }]);
  });

  it('reads operands nested exactly maxNesting deep and refuses one level more', () => {
    expect(content(compareDocuments(stream('[[[[1]]]] Tj', { maxNesting: 4 }), stream('0 0 m'))).map(difference => difference.kind)).toStrictEqual([
      'page-content',
    ]);
    expect(() => compareDocuments(stream('[[[[[1]]]]] Tj', { maxNesting: 4 }), stream('0 0 m'))).toThrow(ResourceLimitError);
  });

  it('follows filter parameters through exactly 64 references and refuses 65', () => {
    expect(content(compareDocuments(chained(64), chained(64)))).toStrictEqual([]);
    expect(() => compareDocuments(chained(65), chained(65))).toThrow(ResourceLimitError);
  });
});

describe('content operations', () => {
  it.each([
    ['0 0 m 1 1', ['n0 n0 m', 'n1 n1']],
    ['] Q', ['?5d Q']],
    ['true null x', ['true null x']],
    ['false x', ['false x']],
  ])('splits %s into operations', (text, operations) => {
    expect(contentOperations(latin1Bytes(text), 32)).toStrictEqual(operations);
  });
});

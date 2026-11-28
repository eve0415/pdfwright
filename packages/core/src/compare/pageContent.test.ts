import type { LoadOptions, LoadedDocument } from '../document/loadDocument.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { DocumentComparison, PdfDifference } from './pdfDifference.ts';

import fc from 'fast-check';
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

type Operand =
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'real'; readonly hundredths: number }
  | { readonly kind: 'string'; readonly bytes: Uint8Array }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'dictionary'; readonly entries: ReadonlyArray<readonly [string, number]> };

interface Operation {
  readonly operands: ReadonlyArray<Operand>;
  readonly operator: string;
}

const operand: fc.Arbitrary<Operand> = fc.oneof(
  fc.record({ kind: fc.constant('integer'), value: fc.integer({ min: -999, max: 999 }) }),
  fc.record({ kind: fc.constant('real'), hundredths: fc.integer({ min: -9999, max: 9999 }) }),
  fc.record({ kind: fc.constant('string'), bytes: fc.uint8Array({ maxLength: 4 }) }),
  fc.record({ kind: fc.constant('name'), name: fc.constantFrom('F1', 'CS0', 'P') }),
  fc.record({
    kind: fc.constant('dictionary'),
    entries: fc.uniqueArray(fc.tuple(fc.constantFrom('A', 'B', 'MCID', 'X'), fc.integer({ min: 0, max: 9 })), { selector: ([key]) => key, maxLength: 3 }),
  }),
);

const operation: fc.Arbitrary<Operation> = fc.record({
  operands: fc.array(operand, { maxLength: 3 }),
  operator: fc.constantFrom('m', 'l', 'S', 'g', 'Tj', 'BDC', 're', 'cm', 'w'),
});

const hexText = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

// One spelling of an operand: the plain one, or a respelled one that has the same value.
const spell = (value: Operand, respelled: boolean): ReadonlyArray<string> => {
  switch (value.kind) {
    case 'integer': {
      // ISO 32000-1:2008, 7.3.3: an integer written as a real has the same value.
      return [respelled ? `${String(value.value)}.0` : String(value.value)];
    }
    case 'real': {
      return [respelled ? (value.hundredths / 100).toFixed(3) : String(value.hundredths / 100)];
    }
    case 'string': {
      // ISO 32000-1:2008, 7.3.4.2 and 7.3.4.3: a literal string of octal escapes and a hexadecimal string hold the same bytes.
      return [respelled ? `(${[...value.bytes].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('')})` : `<${hexText(value.bytes)}>`];
    }
    case 'name': {
      return [`/${value.name}`];
    }
    default: {
      // ISO 32000-1:2008, 7.3.7: the order of dictionary entries carries no meaning.
      const entries = respelled ? value.entries.toReversed() : value.entries;
      return ['<<', ...entries.flatMap(([key, item]) => [`/${key}`, String(item)]), '>>'];
    }
  }
};

const tokens = (operations: ReadonlyArray<Operation>, respelled: boolean): Array<string> =>
  operations.flatMap(({ operands, operator }) => [...operands.flatMap(value => spell(value, respelled)), operator]);

const contentStreams = (parts: ReadonlyArray<{ readonly text: string; readonly compressed: boolean }>): LoadedDocument => {
  const streams = parts.map(({ text, compressed }, index): TestObject => ({
    number: 4 + index,
    body: compressed ? streamBody('/Filter/FlateDecode', latin1Text(deflateZlib(latin1Bytes(text)))) : streamBody('', text),
  }));
  return page(`/Contents[${streams.map(({ number }) => `${String(number)} 0 R`).join(' ')}]`, streams);
};

const plainContent = (operations: ReadonlyArray<Operation>): LoadedDocument =>
  contentStreams([{ text: tokens(operations, false).join(' '), compressed: false }]);

const joinedContent = (operations: ReadonlyArray<string>): LoadedDocument => contentStreams([{ text: operations.join(' '), compressed: false }]);

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => JSON.stringify(left) === JSON.stringify(right);

// The longest common prefix, and the longest common suffix within what the prefix leaves of the shorter list, found by trying every length.
interface SharedEnds {
  readonly prefix: number;
  readonly suffix: number;
}

const sharedEnds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): SharedEnds => {
  const lengths = Array.from({ length: Math.min(a.length, b.length) + 1 }, (_, length) => length);
  const prefix = Math.max(...lengths.filter(length => sameList(a.slice(0, length), b.slice(0, length))));
  const suffix = Math.max(
    ...lengths.filter(length => length <= Math.min(a.length, b.length) - prefix && sameList(a.slice(a.length - length), b.slice(b.length - length))),
  );
  return { prefix, suffix };
};

const separator = fc.constantFrom(' ', '\n', '  ', '\t', '\r\n', ' % note\n');

const respelling = fc.array(operation, { maxLength: 8 }).chain(operations => {
  const count = tokens(operations, true).length;
  return fc.record({
    operations: fc.constant(operations),
    separators: fc.array(separator, { minLength: count, maxLength: count }),
    cuts: fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, count - 1) }), { maxLength: 3 }),
    compressed: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  });
});

const changedOperation = fc
  .array(operation, { minLength: 1, maxLength: 8 })
  .chain(operations => fc.record({ operations: fc.constant(operations), index: fc.integer({ min: 0, max: operations.length - 1 }) }));

const operationList = fc.array(fc.constantFrom('q', 'Q', '0 g'), { maxLength: 4 });

// Unrelated lists, and lists that share a start and an end around different middles, where a prefix and a suffix found independently would overlap.
const operationLists = fc.oneof(
  fc.tuple(operationList, operationList),
  fc.tuple(operationList, operationList, operationList).map(
    ([start, end, middle]) =>
      [
        [...start, ...end],
        [...start, ...middle, ...end],
      ] as const,
  ),
);

describe('properties', () => {
  it('finds no content difference however the same operations are spaced, spelled, split or compressed', () => {
    fc.assert(
      fc.property(respelling, ({ operations, separators, cuts, compressed }) => {
        const spelled = tokens(operations, true).map((token, index) => `${token}${separators[index] ?? ' '}`);
        const bounds = [0, ...cuts.filter(cut => cut < spelled.length).toSorted((left, right) => left - right), spelled.length];
        const parts = bounds.slice(1).map((end, index) => ({ text: spelled.slice(bounds[index], end).join(''), compressed: compressed[index] ?? false }));
        expect(compareDocuments(plainContent(operations), contentStreams(parts), { include: ['content'] }).differences).toStrictEqual([]);
      }),
    );
  });

  it('reports one content difference, placed at the operation, when one operation gains an operand', () => {
    fc.assert(
      fc.property(changedOperation, ({ operations, index }) => {
        const extra: Operand = { kind: 'integer', value: 1000 };
        const edited = operations.map((each, position) => (position === index ? { ...each, operands: [extra, ...each.operands] } : each));
        const [a, b] = [plainContent(operations), plainContent(edited)];
        expect(compareDocuments(a, b, { include: ['content'] }).differences).toStrictEqual([
          {
            kind: 'page-content',
            page: 0,
            operationsA: operations.length,
            operationsB: operations.length,
            commonPrefix: index,
            commonSuffix: operations.length - 1 - index,
          },
        ]);
      }),
    );
  });

  it('reports the longest common prefix and the longest suffix that does not overlap it', () => {
    fc.assert(
      fc.property(operationLists, ([a, b]) => {
        const { prefix, suffix } = sharedEnds(a, b);
        const expected = sameList(a, b)
          ? []
          : [{ kind: 'page-content', page: 0, operationsA: a.length, operationsB: b.length, commonPrefix: prefix, commonSuffix: suffix }];
        const [first, second] = [joinedContent(a), joinedContent(b)];
        expect(compareDocuments(first, second, { include: ['content'] }).differences).toStrictEqual(expected);
      }),
    );
  });
});

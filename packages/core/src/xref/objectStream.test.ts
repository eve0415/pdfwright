import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { DecodedObjectStream } from './objectStream.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { PdfDictionaryEntries, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

import { decodeObjectStream, parseMember } from './objectStream.ts';

interface Decoded {
  stream: DecodedObjectStream;
  warnings: Array<LoadWarning>;
}

const context = (warnings: Array<LoadWarning>, maxObjectStreamMembers = 100): Parameters<typeof decodeObjectStream>[2] => ({
  warn: warning => {
    warnings.push(warning);
  },
  names: new Map(),
  maxNesting: 256,
  maxDecodedBytes: 1_048_576,
  maxObjectStreamMembers,
});

const rawStream = (entries: ReadonlyArray<readonly [string, PdfDirectObject]>, data: string): PdfObject => ({
  kind: 'stream',
  dictionary: new PdfDictionaryEntries(entries.map(([key, value]) => [pdfName(key).bytes, value] as const)),
  data: latin1Bytes(data),
});

const objectStream = (header: string, body: string, entries: Array<[string, number]> = []): PdfObject =>
  rawStream(
    [
      ['Type', pdfName('ObjStm')],
      ['N', pdfInteger(header.trim().split(/\s+/u).length / 2)],
      ['First', pdfInteger(header.length)],
      ...entries.map(([key, value]) => [key, pdfInteger(value)] as const),
    ],
    header + body,
  );

const decode = (stream: PdfObject, maxObjectStreamMembers = 100): Decoded => {
  const warnings: Array<LoadWarning> = [];
  return { stream: decodeObjectStream(12, stream, context(warnings, maxObjectStreamMembers)), warnings };
};

const member = (decoded: DecodedObjectStream, objectNumber: number, index: number, warnings: Array<LoadWarning> = []): string => {
  const value = parseMember(decoded, { objectNumber, index }, context(warnings));
  return latin1Text(serializeObject(value, { fractionDigits: 6 }));
};

describe('object streams', () => {
  it('locates members by the header offsets relative to First', () => {
    const { stream, warnings } = decode(objectStream('11 0 12 12 13 17 ', '<</A 1 0 R>>(abc) [1 2]\n'));
    expect(stream.members).toStrictEqual([
      { objectNumber: 11, start: 17, end: 29 },
      { objectNumber: 12, start: 29, end: 34 },
      { objectNumber: 13, start: 34, end: 40 },
    ]);
    expect([member(stream, 11, 0), member(stream, 12, 1), member(stream, 13, 2), warnings]).toStrictEqual(['<</A 1 0 R>>', '(abc)', '[1 2]', []]);
  });

  it('derives member spans from sorted offsets when the header is unsorted', () => {
    const { stream, warnings } = decode(objectStream('21 4 20 0 ', '(a) (b)'));
    expect([member(stream, 20, 1), member(stream, 21, 0), warnings.map(warning => warning.code)]).toStrictEqual(['(a)', '(b)', ['objstm-offsets-unsorted']]);
  });

  it('rejects a member whose object number differs from the cross-reference entry', () => {
    const { stream } = decode(objectStream('11 0 ', '5'));
    expect(() => member(stream, 99, 0)).toThrow(ParseError);
    expect(() => member(stream, 11, 1)).toThrow(ParseError);
  });

  it('rejects a member with bytes after its value', () => {
    const { stream } = decode(objectStream('11 0 12 4 ', '5 6 (b)'));
    expect([member(stream, 12, 1)]).toStrictEqual(['(b)']);
    expect(() => member(stream, 11, 0)).toThrow(ParseError);
  });

  it('reports the lexer warnings of a member with the member object number', () => {
    const { stream } = decode(objectStream('11 0 ', '/A#zz'));
    const warnings: Array<LoadWarning> = [];
    member(stream, 11, 0, warnings);
    expect(warnings.map(warning => [warning.code, warning.objectNumber])).toStrictEqual([['malformed-name-escape', 11]]);
  });

  it('reads the stream an Extends reference names and ignores an Extends that is not a reference', () => {
    // ISO 32000-1:2008, 7.5.7, Table 16: Extends is "(Optional) A reference to another object stream".
    const reference = decode(
      rawStream(
        [
          ['Type', pdfName('ObjStm')],
          ['N', pdfInteger(1)],
          ['First', pdfInteger(5)],
          ['Extends', pdfReference(9, 0)],
        ],
        '11 0 5',
      ),
    ).stream;
    const integer = decode(objectStream('11 0 ', '5', [['Extends', 9]])).stream;
    expect([reference.extends, 'extends' in integer]).toStrictEqual([9, false]);
  });

  it.each([
    ['a value that is not a stream', { kind: 'integer', value: 1 } as const],
    [
      'a stream of another Type',
      rawStream(
        [
          ['Type', pdfName('XObject')],
          ['N', pdfInteger(1)],
          ['First', pdfInteger(5)],
        ],
        '11 0 5',
      ),
    ],
    [
      'a stream without N',
      rawStream(
        [
          ['Type', pdfName('ObjStm')],
          ['First', pdfInteger(5)],
        ],
        '11 0 5',
      ),
    ],
    [
      'a stream without First',
      rawStream(
        [
          ['Type', pdfName('ObjStm')],
          ['N', pdfInteger(1)],
        ],
        '11 0 5',
      ),
    ],
    ['a header shorter than N pairs', objectStream('11 0 ', '5', [['N', 2]])],
    [
      'a First beyond the decoded data',
      rawStream(
        [
          ['Type', pdfName('ObjStm')],
          ['N', pdfInteger(0)],
          ['First', pdfInteger(7)],
        ],
        '11 0 5',
      ),
    ],
  ])('rejects %s', (_, stream) => {
    expect(() => decode(stream)).toThrow(ParseError);
  });

  it('accepts a First at the end of the decoded data', () => {
    expect(
      decode(
        rawStream(
          [
            ['Type', pdfName('ObjStm')],
            ['N', pdfInteger(0)],
            ['First', pdfInteger(6)],
          ],
          '11 0 5',
        ),
      ).stream.members,
    ).toStrictEqual([]);
  });

  it('reads as many members as maxObjectStreamMembers and refuses one more', () => {
    // House limit, not a PDF rule.
    const stream = objectStream('11 0 12 1 ', '56');
    expect(decode(stream, 2).stream.members.map(item => item.objectNumber)).toStrictEqual([11, 12]);
    expect(() => decode(stream, 1)).toThrow(ResourceLimitError);
  });
});

describe('properties', () => {
  // Values whose serialization is the text they are written as.
  const body = fc.constantFrom('5', '-3', 'null', 'true', '(abc)', '/Name', '[1 2]', '<</A 1>>', '<</A[1 (x)]>>', '2 0 R');

  it('parses every member back to its body, and warns exactly when the header lists offsets out of order', () => {
    fc.assert(
      fc.property(
        fc
          .array(body, { minLength: 1, maxLength: 8 })
          .chain(bodies => fc.tuple(fc.constant(bodies), fc.shuffledSubarray([...bodies.keys()], { minLength: bodies.length, maxLength: bodies.length }))),
        ([bodies, order]) => {
          let data = '';
          const offsets: Array<number> = [];
          for (const text of bodies) {
            offsets.push(data.length);
            data += `${text}\n`;
          }
          const header = order.map(position => `${String(100 + position)} ${String(offsets[position] ?? 0)} `).join('');
          const { stream, warnings } = decode(objectStream(header, data));
          const sorted = order.every((position, index) => index === 0 || (order[index - 1] ?? 0) < position);
          expect([order.map((position, index) => member(stream, 100 + position, index)), warnings.map(warning => warning.code)]).toStrictEqual([
            order.map(position => bodies[position]),
            sorted ? [] : ['objstm-offsets-unsorted'],
          ]);
        },
      ),
    );
  });
});

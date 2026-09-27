import type { PdfObject } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { DecodedObjectStream } from './objectStream.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { PdfDictionaryEntries, pdfInteger, pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

import { decodeObjectStream, parseMember } from './objectStream.ts';

interface Decoded {
  stream: DecodedObjectStream;
  warnings: LoadWarning[];
}

const context = (warnings: LoadWarning[], maxObjectStreamMembers = 100): Parameters<typeof decodeObjectStream>[2] => ({
  warn: warning => {
    warnings.push(warning);
  },
  names: new Map(),
  maxNesting: 256,
  maxDecodedBytes: 1_048_576,
  maxObjectStreamMembers,
});

const objectStream = (header: string, body: string, entries: [string, number][] = []): PdfObject => {
  const dictionary = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('ObjStm')],
    [pdfName('N').bytes, pdfInteger(header.trim().split(/\s+/u).length / 2)],
    [pdfName('First').bytes, pdfInteger(header.length)],
    ...entries.map(([key, value]) => [pdfName(key).bytes, pdfInteger(value)] as const),
  ]);
  return { kind: 'stream', dictionary, data: latin1Bytes(header + body) };
};

const decode = (stream: PdfObject, maxObjectStreamMembers = 100): Decoded => {
  const warnings: LoadWarning[] = [];
  return { stream: decodeObjectStream(12, stream, context(warnings, maxObjectStreamMembers)), warnings };
};

const member = (decoded: DecodedObjectStream, objectNumber: number, index: number): string => {
  const value = parseMember(decoded, { objectNumber, index }, context([]));
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

  it('rejects streams that are not object streams, short headers and too many members', () => {
    expect(() => decode({ kind: 'integer', value: 1 })).toThrow(ParseError);
    expect(() => decode(objectStream('11 0 ', '5', [['N', 2]]))).toThrow(ParseError);
    expect(() => decode(objectStream('11 0 12 1 ', '56'), 1)).toThrow(ResourceLimitError);
  });
});

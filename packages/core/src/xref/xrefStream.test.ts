import type { LoadWarning } from '../parse/loadWarning.ts';
import type { Entry } from '../save/xrefWriter.ts';
import type { StreamSection } from './xrefStream.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { fieldWidths, indexRuns, streamData } from '../save/xrefWriter.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { readXrefStream } from './xrefStream.ts';

// The offset a ParseError reports, or a description of the other outcome, so that one equality checks both the class and the offset.
const parseErrorOffset = (run: () => void): { readonly offset: number } | string => {
  try {
    run();
  } catch (error: unknown) {
    return error instanceof ParseError ? { offset: error.offset } : String(error);
  }
  return 'no error';
};

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCodePoint(byte);
  }
  return text;
};

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

interface Read {
  section: StreamSection;
  warnings: Array<LoadWarning>;
  text: string;
}

// Writes "prefix n 0 obj <<dictionary /Length …>> stream … endstream endobj" and reads the section at the object header.
const read = (dictionary: string, data: Uint8Array, prefix = ''): Read => {
  const warnings: Array<LoadWarning> = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const text = `${prefix}9 0 obj\n<<${dictionary}/Length ${String(data.length)}>>\nstream\n${latin1(data)}\nendstream\nendobj\n`;
  const section = readXrefStream(new ByteSource(encode(text)), prefix.length, { warn, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576 });
  return { section, warnings, text };
};

// PNG Up filtering (RFC 2083, 6.3): each byte minus the byte above it, after a tag byte of 2.
const upRows = (rows: ReadonlyArray<Array<number>>): Array<number> => {
  const encoded: Array<number> = [];
  let previous: ReadonlyArray<number> = [];
  for (const row of rows) {
    encoded.push(2);
    for (const [index, byte] of row.entries()) {
      encoded.push((byte - (previous[index] ?? 0) + 256) % 256);
    }
    previous = row;
  }
  return encoded;
};

// A Flate stream of `count` free entries of one byte each, all zero, and the length of the file read() writes for it.
const zeroRows = (count: number): readonly [string, Uint8Array] => [
  `/Type/XRef/Size ${String(count)}/W[1 0 0]/Index[0 ${String(count)}]/Filter/FlateDecode`,
  deflateZlib(new Uint8Array(count)),
];

const zeroRowsLength = (count: number): number => {
  const [dictionary, data] = zeroRows(count);
  return `9 0 obj\n<<${dictionary}/Length ${String(data.length)}>>\nstream\n${latin1(data)}\nendstream\nendobj\n`.length;
};

const readZeroRows = (count: number): StreamSection => read(...zeroRows(count)).section;

const entries = (section: StreamSection): Array<Array<number | string>> =>
  section.entries.map(entry => [entry.objectNumber, entry.type, entry.location, entry.generation]);

describe('cross-reference streams', () => {
  it('reads W [1 2 1] entries of every type with the default Index', () => {
    const data = Uint8Array.of(0, 0, 0, 255, 1, 0, 17, 0, 2, 0, 9, 3, 1, 1, 2, 5);
    const { section, text } = read('/Type/XRef/Size 4/W[1 2 1]/Root 1 0 R', data, 'junk ');
    expect(entries(section)).toStrictEqual([
      [0, 'free', 0, 255],
      [1, 'file', 17, 0],
      [2, 'compressed', 9, 3],
      [3, 'file', 258, 5],
    ]);
    expect([section.kind, section.offset, section.objectNumber]).toStrictEqual(['stream', 5, 9]);
    expect(text.slice(section.trailerStart, section.trailerEnd)).toBe('<</Type/XRef/Size 4/W[1 2 1]/Root 1 0 R/Length 16>>');
  });

  it('defaults an absent type field to 1 and an absent generation to 0', () => {
    const { section } = read('/Type/XRef/Size 3/W[0 2 0]/Index[1 2]', Uint8Array.of(0, 17, 1, 0));
    expect(entries(section)).toStrictEqual([
      [1, 'file', 17, 0],
      [2, 'file', 256, 0],
    ]);
  });

  it('reads several Index subsections, wide fields and a Flate stream with Predictor 12', () => {
    const rows = [
      [1, 0, 0, 0, 16, 0, 0],
      [1, 0, 1, 0, 0, 0, 1],
      [2, 0, 0, 0, 7, 0, 4],
    ];
    const data = deflateZlib(Uint8Array.from(upRows(rows)));
    const { section } = read('/Type/XRef/Size 30/W[1 4 2]/Index[3 1 20 2]/Filter/FlateDecode/DecodeParms<</Columns 7/Predictor 12>>', data);
    expect(entries(section)).toStrictEqual([
      [3, 'file', 16, 0],
      [20, 'file', 65_536, 1],
      [21, 'compressed', 7, 4],
    ]);
  });

  it('reads an unknown entry type as a free entry and warns', () => {
    const { section, warnings } = read('/Type/XRef/Size 2/W[1 1 1]/Index[1 1]', Uint8Array.of(7, 1, 1));
    expect([entries(section), warnings.map(warning => warning.code)]).toStrictEqual([[[1, 'free', 0, 0]], ['unknown-xref-entry-type']]);
  });

  it('warns about trailing data and unsorted subsections', () => {
    const { warnings } = read('/Type/XRef/Size 9/W[1 1 1]/Index[5 1 2 1]', Uint8Array.of(1, 1, 0, 1, 2, 0, 9));
    expect(warnings.map(warning => warning.code)).toStrictEqual(['xref-stream-trailing-data', 'xref-stream-index-order']);
  });

  // ISO 32000-1:2008, 7.5.8.2, Table 17, Index: "Subsections cannot overlap"; one that starts where the previous one ends does not.
  it('warns about subsections that overlap but not about adjacent ones', () => {
    expect(read('/Type/XRef/Size 3/W[1 1 1]/Index[1 1 2 1]', Uint8Array.of(1, 1, 0, 1, 2, 0)).warnings).toStrictEqual([]);
    expect(read('/Type/XRef/Size 3/W[1 1 1]/Index[1 2 2 1]', Uint8Array.of(1, 1, 0, 1, 2, 0, 1, 3, 0)).warnings.map(warning => warning.code)).toStrictEqual([
      'xref-stream-index-order',
    ]);
  });

  // Every refusal reports the offset of the stream's object header, here 5 after the prefix.
  it.each([
    ['an object that is not a cross-reference stream', '/Type/ObjStm/Size 1/W[1 1 1]', Uint8Array.of(1, 1, 0)],
    ['data shorter than its entries', '/Type/XRef/Size 2/W[1 1 1]', Uint8Array.of(1, 1, 0)],
    ['a width above 8 bytes', '/Type/XRef/Size 1/W[1 9 1]', new Uint8Array(11)],
    ['W of two widths', '/Type/XRef/Size 1/W[1 2]', new Uint8Array(3)],
    ['W given as a reference', '/Type/XRef/Size 1/W 3 0 R', new Uint8Array(4)],
    ['no Size', '/Type/XRef/W[1 1 1]', Uint8Array.of(1, 1, 0)],
    ['a negative Size', '/Type/XRef/Size -1/W[1 1 1]/Index[0 1]', Uint8Array.of(1, 1, 0)],
    ['an Index of odd length', '/Type/XRef/Size 1/W[1 1 1]/Index[0 1 3]', Uint8Array.of(1, 1, 0)],
    ['a negative Index element', '/Type/XRef/Size 1/W[1 1 1]/Index[-1 1]', Uint8Array.of(1, 1, 0)],
    ['an Index beyond 2^31 - 1', '/Type/XRef/Size 1/W[1 1 1]/Index[2147483647 2]', Uint8Array.of(1, 1, 0, 1, 1, 0)],
    ['entries without width', '/Type/XRef/Size 1/W[0 0 0]/Index[0 1]', new Uint8Array()],
    // ISO 32000-1:2008, 7.5.8.3: a field holds an unsigned integer; 2^53 has no exact number.
    ['a second field of 2^53', '/Type/XRef/Size 1/W[1 8 1]', Uint8Array.of(1, 0, 0x20, 0, 0, 0, 0, 0, 0, 0)],
    ['an in-use generation of 2^32', '/Type/XRef/Size 1/W[1 1 5]', Uint8Array.of(1, 9, 1, 0, 0, 0, 0)],
  ])('rejects %s at the object header', (_, dictionary, data) => {
    expect(parseErrorOffset(() => read(dictionary, data, 'junk '))).toStrictEqual({ offset: 5 });
  });

  it('reads fields at the widest width, the exact range and the highest generation', () => {
    const wide = read('/Type/XRef/Size 1/W[1 8 1]', Uint8Array.of(1, 0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0)).section;
    const generation = read('/Type/XRef/Size 1/W[1 1 5]', Uint8Array.of(1, 9, 0, 0xff, 0xff, 0xff, 0xff)).section;
    const last = read('/Type/XRef/Size 1/W[1 1 1]/Index[2147483647 1]', Uint8Array.of(1, 9, 0)).section;
    expect([entries(wide), entries(generation), entries(last)]).toStrictEqual([
      [[0, 'file', 9_007_199_254_740_991, 0]],
      [[0, 'file', 9, 4_294_967_295]],
      [[2_147_483_647, 'file', 9, 0]],
    ]);
  });

  it('reads an empty Index without entries, even with no width', () => {
    expect(read('/Type/XRef/Size 0/W[0 0 0]/Index[]', new Uint8Array()).section.entries).toStrictEqual([]);
  });

  it('reads a type field wider than one byte as one number', () => {
    // 0x0100 is type 256, not type 0 or 1 from a single byte.
    const { section, warnings } = read('/Type/XRef/Size 2/W[2 1 1]/Index[1 1]', Uint8Array.of(1, 0, 5, 0));
    expect([entries(section), warnings.map(warning => warning.code)]).toStrictEqual([[[1, 'free', 0, 0]], ['unknown-xref-entry-type']]);
  });

  it('accepts as many entries as the file has bytes plus 1,024 and refuses one more', () => {
    // Zero rows compress to a few bytes, so the count can exceed the file length; the limit is found where count = file length + 1024.
    let limit = 2000;
    for (let step = 0; step < 10; step++) {
      limit = zeroRowsLength(limit) + 1024;
    }
    expect([zeroRowsLength(limit) + 1024, zeroRowsLength(limit + 1) + 1024, readZeroRows(limit).entries.length]).toStrictEqual([limit, limit, limit]);
    expect(parseErrorOffset(() => readZeroRows(limit + 1))).toStrictEqual({ offset: 0 });
  });

  it('rejects more entries than the file has bytes before decoding them', () => {
    const zeros = deflateZlib(new Uint8Array(100_000));
    expect(parseErrorOffset(() => read('/Type/XRef/Size 100000/W[1 0 0]/Filter/FlateDecode', zeros))).toStrictEqual({ offset: 0 });
  });
});

describe('properties', () => {
  // Sorted, distinct object numbers with entries of each type whose fields fit a cross-reference stream.
  const streamEntries = fc
    .uniqueArray(
      fc.record({
        objectNumber: fc.integer({ min: 0, max: 5000 }),
        type: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
        field: fc.integer({ min: 0, max: 2 ** 40 - 1 }),
        generation: fc.integer({ min: 0, max: 65_535 }),
      }),
      { selector: entry => entry.objectNumber, minLength: 1, maxLength: 30 },
    )
    .map(list => list.toSorted((left, right) => left.objectNumber - right.objectNumber));
  const names = { 0: 'free', 1: 'file', 2: 'compressed' } as const;

  it('reads back the entries the writer encodes', () => {
    fc.assert(
      fc.property(streamEntries, (list: ReadonlyArray<Entry>) => {
        const [second, third] = fieldWidths(list);
        const index = latin1(serializeObject(indexRuns(list), { fractionDigits: 0 }));
        const size = (list.at(-1)?.objectNumber ?? 0) + 1;
        const { section, warnings } = read(
          `/Type/XRef/Size ${String(size)}/W[1 ${String(second)} ${String(third)}]/Index${index}`,
          streamData(list, [second, third]),
        );
        expect([entries(section), warnings]).toStrictEqual([list.map(entry => [entry.objectNumber, names[entry.type], entry.field, entry.generation]), []]);
      }),
    );
  });
});

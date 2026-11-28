import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { XrefEntry } from '../xref/xrefSection.ts';
import type { Entry } from './xrefWriter.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';
import { readClassicSection } from '../xref/classicSection.ts';
import { readXrefStream } from '../xref/xrefStream.ts';

import { byteWidth, coveringStreamData, fieldWidths, indexRuns, streamData, writeCoveringTable, writeTable } from './xrefWriter.ts';

const ignore = (): void => {
  // The sections written here are well formed; a warning would show in the entries compared.
};

const context = { warn: ignore, names: new Map<string, Uint8Array>(), maxNesting: 256, maxDecodedBytes: 1 << 26 };

const written = (write: (writer: ByteWriter) => void): string => {
  const writer = new ByteWriter();
  write(writer);
  return latin1Text(writer.toUint8Array());
};

const integers = (value: PdfDirectObject): ReadonlyArray<number> =>
  value.kind === 'array' ? value.items.map(item => (item.kind === 'integer' ? item.value : Number.NaN)) : [];

const TYPES = { 0: 'free', 1: 'file', 2: 'compressed' } as const;

// The entry a reader gives back for a written one (ISO 32000-1:2008, 7.5.8.3, Table 18).
const asRead = (entry: Entry): XrefEntry => ({
  objectNumber: entry.objectNumber,
  type: TYPES[entry.type],
  location: entry.field,
  generation: entry.generation,
});

// ISO 32000-1:2008, 7.5.4: the unused entry "0000000000 65535 f" that fills a number without an object.
const UNUSED = { type: 0, field: 0, generation: 65_535 } as const;

// The rows of a covering stream built independently: every number from 0 to size - 1, the given entry or the unused one.
const filled = (entries: ReadonlyMap<number, Entry>, size: number): Array<Entry> =>
  Array.from({ length: size }, (_, objectNumber) => entries.get(objectNumber) ?? { objectNumber, ...UNUSED });

const entryOf = (objectNumber: number, type: 0 | 1 | 2, field: number, generation: number): Entry => ({ objectNumber, type, field, generation });

// Entries with unique, ascending object numbers, as both writers receive them.
const entryLists = (types: fc.Arbitrary<0 | 1 | 2>, maxField: number): fc.Arbitrary<Array<Entry>> =>
  fc
    .uniqueArray(fc.nat({ max: 100_000 }), { maxLength: 40 })
    .chain(numbers =>
      fc.tuple(
        ...numbers
          .toSorted((left, right) => left - right)
          .map(objectNumber =>
            fc
              .tuple(types, fc.nat({ max: maxField }), fc.nat({ max: 65_535 }))
              .map(([type, field, generation]) => entryOf(objectNumber, type, field, generation)),
          ),
      ),
    );

describe('cross-reference writing', () => {
  it('finds field widths for more entries than a spread argument list holds', () => {
    const entries = Array.from({ length: 200_000 }, (_, objectNumber) => ({ objectNumber, type: 1, field: objectNumber * 300, generation: 0 }) as const);
    expect(fieldWidths(entries)).toStrictEqual([4, 1]);
  });

  it.each([
    [0, 1],
    [255, 1],
    [256, 2],
    [65_535, 2],
    [65_536, 3],
    [2 ** 32 - 1, 4],
    [2 ** 32, 5],
  ])('gives %i a field %i bytes wide', (value, width) => {
    expect(byteWidth(value)).toBe(width);
  });

  it('writes a table of one empty subsection for no entries, and one subsection per run of consecutive numbers', () => {
    const entries = [
      { objectNumber: 0, type: 0, field: 3, generation: 65_535 },
      { objectNumber: 1, type: 1, field: 15, generation: 2 },
      { objectNumber: 3, type: 0, field: 0, generation: 1 },
    ] as const;
    // ISO 32000-1:2008, 7.5.4: a subsection header gives the first number and the count, and each entry is "nnnnnnnnnn ggggg n eol", 20 bytes.
    expect([
      written(writer => {
        writeTable(writer, []);
      }),
      written(writer => {
        writeTable(writer, entries);
      }),
    ]).toStrictEqual(['xref\n0 0\n', 'xref\n0 2\n0000000003 65535 f \n0000000015 00002 n \n3 1\n0000000000 00001 f \n']);
  });

  it('writes a covering table with a line for every number below size, filling the gaps with unused entries', () => {
    const entries = new Map([
      [0, { objectNumber: 0, type: 0, field: 0, generation: 65_535 }],
      [2, { objectNumber: 2, type: 1, field: 1234, generation: 0 }],
    ] as const);
    expect(
      written(writer => {
        writeCoveringTable(writer, entries, 4);
      }),
    ).toBe('xref\n0 4\n0000000000 65535 f \n0000000000 65535 f \n0000001234 00000 n \n0000000000 65535 f \n');
  });

  it('gives Index pairs for each run of consecutive numbers', () => {
    const runs = [[], [0, 1, 2, 5, 6], [4]].map(numbers => integers(indexRuns(numbers.map(objectNumber => entryOf(objectNumber, 1, 0, 0)))));
    expect(runs).toStrictEqual([[], [0, 3, 5, 2], [4, 1]]);
  });

  // Rows of 5 bytes fill a 64 KiB piece after 13,107 rows, so these sizes end just before, at and after one or more piece boundaries.
  it.each([13_106, 13_107, 13_108, 26_214, 26_215, 40_000])('compresses a covering stream of %i rows to the rows written one by one', size => {
    const entries = new Map([
      [0, { objectNumber: 0, type: 0, field: 7, generation: 65_535 }],
      [7, { objectNumber: 7, type: 0, field: 0, generation: 1 }],
      [13_107, { objectNumber: 13_107, type: 1, field: 65_000, generation: 0 }],
      [size - 1, { objectNumber: size - 1, type: 2, field: 9, generation: 4 }],
    ] as const);
    const widths = [2, 2] as const;
    expect(inflateZlib(coveringStreamData(entries, size, widths)).data).toStrictEqual(streamData(filled(entries, size), widths));
  });
});

describe('properties', () => {
  it('reads back every entry of a cross-reference stream written from its entries', () => {
    fc.assert(
      fc.property(entryLists(fc.constantFrom(0, 1, 2), 2 ** 40 - 1), entries => {
        const widths = fieldWidths(entries);
        const data = latin1Text(streamData(entries, widths));
        const size = (entries.at(-1)?.objectNumber ?? 0) + 1;
        // ISO 32000-1:2008, 7.5.8.2, Table 17: Size, W and Index describe the rows.
        const dictionary = `/Type/XRef/Size ${String(size)}/W[1 ${String(widths[0])} ${String(widths[1])}]/Index[${integers(indexRuns(entries)).join(' ')}]/Length ${String(data.length)}`;
        const bytes = latin1Bytes(`9 0 obj\n<<${dictionary}>>\nstream\n${data}\nendstream\nendobj\n`);
        expect(readXrefStream(new ByteSource(bytes), 0, context).entries).toStrictEqual(entries.map(entry => asRead(entry)));
      }),
    );
  });

  it('reads back every entry of a classic table written from its entries, each 20 bytes long', () => {
    fc.assert(
      fc.property(entryLists(fc.constantFrom(0, 1), 9_999_999_999), entries => {
        const table = written(writer => {
          writeTable(writer, entries);
        });
        const section = readClassicSection(new ByteSource(latin1Bytes(`${table}trailer\n<</Size 1>>\n`)), 0, context);
        expect([section.entries, section.entryLengths]).toStrictEqual([entries.map(entry => asRead(entry)), entries.length === 0 ? [] : [20]]);
      }),
    );
  });

  it('compresses a covering stream to the rows of every number with the gaps filled, across piece boundaries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30_000 }),
        fc.uniqueArray(fc.tuple(fc.nat({ max: 29_999 }), fc.constantFrom(0, 1, 2), fc.nat({ max: 2 ** 24 - 1 }), fc.nat({ max: 65_535 })), {
          selector: ([objectNumber]) => objectNumber,
          maxLength: 30,
        }),
        (size, rows) => {
          const entries = new Map(
            rows
              .filter(([objectNumber]) => objectNumber < size)
              .map(([objectNumber, type, field, generation]) => [objectNumber, entryOf(objectNumber, type, field, generation)]),
          );
          const widths = fieldWidths([...entries.values(), { objectNumber: 0, ...UNUSED }]);
          expect(inflateZlib(coveringStreamData(entries, size, widths)).data).toStrictEqual(streamData(filled(entries, size), widths));
        },
      ),
    );
  });
});

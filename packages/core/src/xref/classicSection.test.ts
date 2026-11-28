import type { Entry } from '../save/xrefWriter.ts';
import type { ClassicSection } from './classicSection.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { writeTable } from '../save/xrefWriter.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { readClassicSection } from './classicSection.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const sourceOf = (text: string, chunk: number): ByteSource => {
  const bytes = encode(text);
  if (chunk === 0) {
    return new ByteSource(bytes);
  }
  const chunks: Array<Uint8Array> = [];
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    chunks.push(bytes.subarray(offset, offset + chunk));
  }
  return new ByteSource(chunks);
};

interface ReadOptions {
  readonly offset?: number;
  readonly chunk?: number;
  readonly maxNesting?: number;
}

const read = (text: string, { offset = 0, chunk = 0, maxNesting = 256 }: ReadOptions = {}): ClassicSection =>
  readClassicSection(sourceOf(text, chunk), offset, {
    warn: () => {
      // Classic sections report entry lengths through the result, not through warnings.
    },
    names: new Map(),
    maxNesting,
  });

// The offset a ParseError reports, or a description of the other outcome, so that one equality checks both the class and the offset.
const parseErrorOffset = (run: () => void): { readonly offset: number } | string => {
  try {
    run();
  } catch (error: unknown) {
    return error instanceof ParseError ? { offset: error.offset } : String(error);
  }
  return 'no error';
};

const entries = (section: ClassicSection): Array<Array<number | string>> =>
  section.entries.map(entry => [entry.objectNumber, entry.type, entry.location, entry.generation]);

const size = (section: ClassicSection): number | undefined => {
  const value = section.trailer.get(pdfName('Size').bytes);
  return value?.kind === 'integer' ? value.value : undefined;
};

describe('classic cross-reference sections', () => {
  it('reads subsections of 20-byte entries and the trailer', () => {
    const text = 'xx\nxref\n0 3\n0000000003 65535 f \n0000000017 00000 n \n0000000081 00002 n\r\n7 1\n0000000331 00000 n \ntrailer\n<</Size 8>>\nstartxref';
    const section = read(text, { offset: 3 });
    expect(entries(section)).toStrictEqual([
      [0, 'free', 3, 65_535],
      [1, 'file', 17, 0],
      [2, 'file', 81, 2],
      [7, 'file', 331, 0],
    ]);
    expect([section.kind, section.offset, size(section), section.entryLengths]).toStrictEqual(['classic', 3, 8, [20]]);
    expect(text.slice(section.trailerStart, section.trailerEnd)).toBe('<</Size 8>>');
  });

  it('records 19- and 21-byte entries and CR-only lines', () => {
    expect(read('xref\n0 2\n0000000000 65535 f\n0000000017 00000 n\ntrailer<<>>').entryLengths).toStrictEqual([19]);
    expect(read('xref\n0 2\n0000000000 65535 f \r\n0000000017 00000 n \r\ntrailer<<>>').entryLengths).toStrictEqual([21]);
    const cr = read('xref\r595 2\r0000000000 65535 f\r0000000017 00000 n\rtrailer\r<</Size 597>>');
    expect([entries(cr), cr.entryLengths]).toStrictEqual([
      [
        [595, 'free', 0, 65_535],
        [596, 'file', 17, 0],
      ],
      [19],
    ]);
  });

  it('reports each distinct entry length once, in ascending order', () => {
    // ISO 32000-1:2008, 7.5.4: every entry is exactly 20 bytes; a 20-byte entry before a 19-byte one gives both lengths, sorted.
    const section = read('xref\n0 3\n0000000000 65535 f \n0000000017 00000 n\n0000000040 00000 n \ntrailer<<>>');
    expect(section.entryLengths).toStrictEqual([19, 20]);
  });

  // The last entry of a subsection ends at its end-of-line, not at the next token, so white space after it is not counted.
  it.each([
    ['a 20-byte entry and a blank line before the trailer', '0000000000 65535 f \n\ntrailer<<>>', [20]],
    ['a 20-byte entry and a blank line before the next subsection', '0000000000 65535 f \n\n5 1\n0000000017 00000 n \ntrailer<<>>', [20]],
    ['a CR LF entry and spaces before the trailer', '0000000000 65535 f\r\n   trailer<<>>', [20]],
    ['a 19-byte entry and a blank line', '0000000000 65535 f\n\ntrailer<<>>', [19]],
    ['a CR-only entry and a second CR', '0000000000 65535 f\r\rtrailer<<>>', [19]],
    ['a 21-byte entry and a blank line', '0000000000 65535 f \r\n\r\ntrailer<<>>', [21]],
  ])('measures the last entry of a subsection to its end-of-line, for %s', (_, rest, lengths) => {
    const text = `xref\n0 1\n${rest}`;
    expect([0, 1, 7].map(chunk => read(text, { chunk }).entryLengths)).toStrictEqual([lengths, lengths, lengths]);
  });

  it('accepts an empty section', () => {
    expect(entries(read('xref\n0 0\ntrailer\n<</Size 1>>'))).toStrictEqual([]);
  });

  it.each([1, 7])('reads a section split into %i-byte segments as it reads one segment', chunk => {
    const text = 'xref\n0 3\n0000000000 65535 f \n0000000017 00000 n \n0000000081 00002 n \n9 1\n0000000331 00000 n \ntrailer\n<</Size 10/Root 1 0 R>>\n';
    const whole = read(text);
    const segmented = read(text, { chunk });
    expect([entries(segmented), segmented.entryLengths, segmented.trailerStart, segmented.trailerEnd, size(segmented)]).toStrictEqual([
      entries(whole),
      whole.entryLengths,
      whole.trailerStart,
      whole.trailerEnd,
      10,
    ]);
  });

  it.each([
    ['an entry of type x', 'xref\n0 2\n0000000000 65535 f \n0000000017 00000 x \ntrailer<<>>', 29],
    ['fewer entries than the subsection declares', 'xref\n0 2\n0000000000 65535 f \ntrailer<<>>', 29],
    ['a type of two letters', 'xref\n0 1\n0000000000 65535 nn \ntrailer<<>>', 9],
    ['an uppercase type', 'xref\n0 1\n0000000017 00000 N \ntrailer<<>>', 9],
    ['a negative offset', 'xref\n0 1\n-000000017 00000 n \ntrailer<<>>', 9],
    ['no keyword trailer', 'xref\n0 1\n0000000000 65535 f \n<<>>', 29],
    ['a trailer that is not a dictionary', 'xref\n0 1\n0000000000 65535 f \ntrailer 5', 37],
    ['no keyword xref', '  1 0 obj', 2],
  ])('rejects %s at the offset of the offending token', (_, text, offset) => {
    expect(parseErrorOffset(() => read(text))).toStrictEqual({ offset });
  });

  it('rejects a section that ends before its trailer without reading past the end', () => {
    expect(parseErrorOffset(() => read('xref\n0 1\n0000000000 65535 f \n'))).toStrictEqual({ offset: 29 });
  });

  // MAX_OBJECT_NUMBER is 2^31 - 1, the largest reference number the object model accepts.
  it.each([
    ['2147483647 1', [2_147_483_647]],
    ['2147483646 2', [2_147_483_646, 2_147_483_647]],
  ])('accepts the subsection %s, whose last number is 2^31 - 1', (header, numbers) => {
    const lines = numbers.map(() => '0000000017 00000 n \n').join('');
    expect(read(`xref\n${header}\n${lines}trailer<<>>`).entries.map(entry => entry.objectNumber)).toStrictEqual(numbers);
  });

  it.each(['2147483647 2', '2147483646 3', '4294967297 1', '-1 1'])('rejects the subsection %s at its header', header => {
    expect(parseErrorOffset(() => read(`xref\n${header}\n0000000017 00000 n \n0000000017 00000 n \n0000000017 00000 n \ntrailer<<>>`))).toStrictEqual({
      offset: 5,
    });
  });

  it('parses the trailer within maxNesting', () => {
    const text = 'xref\n0 0\ntrailer\n<</A<</B<<>>>>>>';
    expect(read(text, { maxNesting: 3 }).trailer.has(pdfName('A').bytes)).toBe(true);
    expect(() => read(text, { maxNesting: 2 })).toThrow(ResourceLimitError);
  });
});

describe('properties', () => {
  // Ascending, distinct object numbers with in-use and free entries whose fields fit the fixed widths of ISO 32000-1:2008, 7.5.4.
  const tableEntries = fc
    .uniqueArray(
      fc.record({
        objectNumber: fc.integer({ min: 0, max: 100_000 }),
        type: fc.constantFrom<0 | 1>(0, 1),
        field: fc.integer({ min: 0, max: 9_999_999_999 }),
        generation: fc.integer({ min: 0, max: 65_535 }),
      }),
      { selector: entry => entry.objectNumber, minLength: 1, maxLength: 40 },
    )
    .map(list => list.toSorted((left, right) => left.objectNumber - right.objectNumber));

  it('reads back the entries the writer writes, each 20 bytes long', () => {
    fc.assert(
      fc.property(tableEntries, (list: ReadonlyArray<Entry>) => {
        const writer = new ByteWriter();
        writeTable(writer, list);
        const section = read(`${latin1Text(writer.toUint8Array())}trailer\n<<>>`);
        expect([entries(section), section.entryLengths]).toStrictEqual([
          list.map(entry => [entry.objectNumber, entry.type === 1 ? 'file' : 'free', entry.field, entry.generation]),
          [20],
        ]);
      }),
    );
  });
});

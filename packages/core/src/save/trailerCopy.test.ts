import type { TrailerChange } from '../document/editedObjects.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfInteger, pdfName } from '../object/pdfObject.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { copiedTrailerEntries, withTrailerChanges } from './trailerCopy.ts';

const entries = (pairs: ReadonlyArray<readonly [string, number]>): PdfDictionaryEntries =>
  parsedDictionaryEntries(pairs.map(([key, value]) => [pdfName(key).bytes, pdfInteger(value)]));

const pairsOf = (dictionary: PdfDictionaryEntries): ReadonlyArray<readonly [string, PdfDirectObject]> =>
  [...dictionary.entries()].map(([key, value]) => [latin1Text(key), value]);

const change = (key: string, value: number | undefined): TrailerChange => ({
  key: pdfName(key).bytes,
  value: value === undefined ? undefined : pdfInteger(value),
});

// Every key a cross-reference stream dictionary can hold besides the document's own trailer entries (ISO 32000-1:2008, 7.3.8.2, Table 5, and 7.5.8.2, Table 17).
const STREAM_KEYS = ['Type', 'Length', 'Filter', 'DecodeParms', 'F', 'FFilter', 'FDecodeParms', 'DL', 'Index', 'W'] as const;

describe('trailer copying', () => {
  it('applies changes in order: a set keeps its key in place or adds it at the end, and a removal drops it', () => {
    // C follows B untouched, so B keeping its place and B moving to the end give different orders.
    const base = entries([
      ['A', 1],
      ['B', 2],
      ['C', 3],
      ['X', 9],
    ]);
    const changed = withTrailerChanges(base, [
      change('B', 20),
      change('D', 4),
      change('X', 30),
      change('X', undefined),
      change('A', undefined),
      change('A', 10),
      change('E', undefined),
    ]);
    expect([pairsOf(changed), pairsOf(base)]).toStrictEqual([
      [
        ['B', pdfInteger(20)],
        ['C', pdfInteger(3)],
        ['D', pdfInteger(4)],
        ['A', pdfInteger(10)],
      ],
      [
        ['A', pdfInteger(1)],
        ['B', pdfInteger(2)],
        ['C', pdfInteger(3)],
        ['X', pdfInteger(9)],
      ],
    ]);
  });

  // ISO 32000-1:2008, 7.5.6: an added trailer carries every entry of the previous one except Prev; 7.5.8.4 ties XRefStm to its own section.
  it.each([
    ['classic', ['Size', 'Root', 'Type', 'Length', 'Filter', 'DecodeParms', 'F', 'FFilter', 'FDecodeParms', 'DL', 'Index', 'W', 'ID', 'Private']],
    ['stream', ['Size', 'Root', 'ID', 'Private']],
  ] as const)('carries the document entries of a %s trailer over in their order', (kind, kept) => {
    const base = entries(['Size', 'Prev', 'Root', 'XRefStm', ...STREAM_KEYS, 'ID', 'Private'].map((key, index) => [key, index] as const));
    expect(pairsOf(copiedTrailerEntries(base, kind)).map(([key]) => key)).toStrictEqual(kept);
  });
});

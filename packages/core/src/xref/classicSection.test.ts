import type { LoadWarning } from '../parse/loadWarning.ts';
import type { ClassicSection } from './classicSection.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';

import { readClassicSection } from './classicSection.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const read = (text: string, offset = 0): ClassicSection => {
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  return readClassicSection(new ByteSource(encode(text)), offset, { warn, names: new Map(), maxNesting: 256 });
};

const entries = (section: ClassicSection): (number | string)[][] =>
  section.entries.map(entry => [entry.objectNumber, entry.type, entry.location, entry.generation]);

const size = (section: ClassicSection): number | undefined => {
  const value = section.trailer.get(pdfName('Size').bytes);
  return value?.kind === 'integer' ? value.value : undefined;
};

describe('classic cross-reference sections', () => {
  it('reads subsections of 20-byte entries and the trailer', () => {
    const text = 'xx\nxref\n0 3\n0000000003 65535 f \n0000000017 00000 n \n0000000081 00002 n\r\n7 1\n0000000331 00000 n \ntrailer\n<</Size 8>>\nstartxref';
    const section = read(text, 3);
    expect(entries(section)).toStrictEqual([
      [0, 'free', 3, 65535],
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
        [595, 'free', 0, 65535],
        [596, 'file', 17, 0],
      ],
      [19],
    ]);
  });

  it('accepts an empty section', () => {
    expect(entries(read('xref\n0 0\ntrailer\n<</Size 1>>'))).toStrictEqual([]);
  });

  it('rejects an entry that is not offset, generation and n or f', () => {
    expect(() => read('xref\n0 2\n0000000000 65535 f \n0000000017 00000 x \ntrailer<<>>')).toThrow(ParseError);
    expect(() => read('xref\n0 2\n0000000000 65535 f \ntrailer<<>>')).toThrow(new ParseError('malformed cross-reference entry', 29));
    expect(() => read('xref\n0 1\n0000000000 65535 f \n<<>>')).toThrow(ParseError);
    expect(() => read('xref\n0 1\n0000000000 65535 f \ntrailer 5')).toThrow(new ParseError('the trailer is not a dictionary', 37));
    expect(() => read('  1 0 obj')).toThrow(new ParseError('expected the keyword xref', 2));
  });
});

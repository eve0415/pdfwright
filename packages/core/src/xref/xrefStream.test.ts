import type { LoadWarning } from '../parse/loadWarning.ts';
import type { StreamSection } from './xrefStream.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { ByteSource } from '../parse/byteSource.ts';

import { readXrefStream } from './xrefStream.ts';

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

interface Read {
  section: StreamSection;
  warnings: LoadWarning[];
  text: string;
}

// Writes "prefix n 0 obj <<dictionary /Length …>> stream … endstream endobj" and reads the section at the object header.
const read = (dictionary: string, data: Uint8Array, prefix = ''): Read => {
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const text = `${prefix}9 0 obj\n<<${dictionary}/Length ${String(data.length)}>>\nstream\n${latin1(data)}\nendstream\nendobj\n`;
  const section = readXrefStream(new ByteSource(encode(text)), prefix.length, { warn, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576 });
  return { section, warnings, text };
};

// PNG Up filtering (RFC 2083, 6.3): each byte minus the byte above it, after a tag byte of 2.
const upRows = (rows: readonly number[][]): number[] => {
  const encoded: number[] = [];
  let previous: readonly number[] = [];
  for (const row of rows) {
    encoded.push(2);
    for (const [index, byte] of row.entries()) encoded.push((byte - (previous[index] ?? 0) + 256) % 256);
    previous = row;
  }
  return encoded;
};

const entries = (section: StreamSection): (number | string)[][] =>
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
      [20, 'file', 65536, 1],
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

  it('rejects objects that are not cross-reference streams and data shorter than its entries', () => {
    expect(() => read('/Type/ObjStm/Size 1/W[1 1 1]', Uint8Array.of(1, 1, 0))).toThrow(new ParseError('not a cross-reference stream', 0));
    expect(() => read('/Type/XRef/Size 2/W[1 1 1]', Uint8Array.of(1, 1, 0))).toThrow(ParseError);
    expect(() => read('/Type/XRef/Size 1/W[1 9 1]', new Uint8Array(11))).toThrow(ParseError);
    expect(() => read('/Type/XRef/Size 1/W[1 2]', new Uint8Array(3))).toThrow(ParseError);
    expect(() => read('/Type/XRef/Size 1/W 3 0 R', new Uint8Array(3))).toThrow(ParseError);
  });

  it('rejects entries without width and more entries than the file has bytes', () => {
    expect(() => read('/Type/XRef/Size 4/W[0 0 0]/Index[0 200000000]', new Uint8Array())).toThrow(
      new ParseError('the cross-reference stream W entry gives entries no width', 0),
    );
    const zeros = deflateZlib(new Uint8Array(100_000));
    expect(() => read('/Type/XRef/Size 100000/W[1 0 0]/Filter/FlateDecode', zeros)).toThrow(ParseError);
  });
});

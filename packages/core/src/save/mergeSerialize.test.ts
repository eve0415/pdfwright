import type { Length } from '../length/length.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { SourceNode } from '../parse/parseObject.ts';
import type { SaveWarning } from './saveWarning.ts';

import { describe, expect, it } from 'vitest';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { mm } from '../length/length.ts';
import { cloneObject } from '../object/cloneObject.ts';
import { PdfDictionaryEntries, pdfArray, pdfInteger, pdfName, pdfReal } from '../object/pdfObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseAnnotated } from '../parse/parseObject.ts';
import { latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

import { mergeSerialize } from './mergeSerialize.ts';

interface Parsed {
  node: SourceNode;
  bytes: Uint8Array;
}

const ignore = (): void => {
  // Warnings are not under test here.
};

const parse = (text: string): Parsed => {
  const bytes = latin1Bytes(text);
  return { node: parseAnnotated(new Lexer({ bytes, base: 0, final: true }, 0, { warn: ignore, names: new Map() }), 256), bytes };
};

interface Merged {
  text: string;
  warnings: SaveWarning[];
}

const merge = (value: PdfObject, original?: Parsed): Merged => {
  const writer = new ByteWriter();
  const warnings: SaveWarning[] = [];
  const warn = (warning: SaveWarning): void => {
    warnings.push(warning);
  };
  mergeSerialize(writer, value, { original: original?.node, bytes: original?.bytes ?? new Uint8Array(), fractionDigits: 5, warn });
  return { text: latin1Text(writer.toUint8Array()), warnings };
};

const box = (values: readonly (Length | number)[]): PdfDirectObject =>
  pdfArray(values.map(value => (typeof value === 'number' ? pdfInteger(value) : pdfReal(value))));

const entriesOf = (parsed: Parsed): PdfDictionaryEntries => {
  const copy = cloneObject(parsed.node.value);
  return copy.kind === 'dictionary' ? copy.entries : new PdfDictionaryEntries();
};

const edited = (parsed: Parsed, edit: (entries: Extract<PdfDirectObject, { kind: 'dictionary' }>['entries']) => void): PdfObject => {
  const copy = cloneObject(parsed.node.value);
  if (copy.kind === 'dictionary') edit(copy.entries);
  return copy;
};

// The shape of an Illustrator page dictionary: a direct PieceInfo, six-digit reals, a real written as 792.0 and a key spelled with an escape.
const page =
  "<< /Type /Page /ArtBox [0.242187 2.38184 611.611 792.0]  /PieceInfo<</Illustrator 21501 0 R>>/LastModified(D:20070624192720-05'00')/Odd#20Key 1 /MediaBox [ 0 0 612 792 ] >>";

describe('merge serializer', () => {
  it('copies an unchanged value byte for byte', () => {
    const parsed = parse(page);
    expect(merge(cloneObject(parsed.node.value), parsed).text).toBe(page);
  });

  it('keeps the bytes of every unchanged entry when a sibling changes', () => {
    const parsed = parse(page);
    const value = edited(parsed, entries => {
      entries.set(pdfName('TrimBox').bytes, box([mm(5), mm(5), mm(100), mm(100)]));
      entries.set(pdfName('MediaBox').bytes, box([0, 0, 612, 800]));
    });
    expect(merge(value, parsed).text).toBe(
      "<</Type /Page/ArtBox [0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 21501 0 R>>/LastModified(D:20070624192720-05'00')/Odd#20Key 1/MediaBox [ 0 0 612 800 ]/TrimBox[14.17323 14.17323 283.46457 283.46457]>>",
    );
  });

  it('drops removed entries and keeps one occurrence of a duplicate key with a warning', () => {
    const parsed = parse('<</A 1/K (first) /B 2/K (last)>>');
    const value = edited(parsed, entries => {
      entries.delete(pdfName('A').bytes);
      entries.set(pdfName('C').bytes, pdfInteger(3));
    });
    const { text, warnings } = merge(value, parsed);
    expect([text, warnings.map(warning => warning.code)]).toStrictEqual(['<</K (last)/B 2/C 3>>', ['duplicate-key-resolved']]);
  });

  it('keeps a changed value that begins with a regular character apart from the token before it', () => {
    const parsed = parse('<</Foo/Bar/Arr[/A/B]/List[(a)7]>>');
    const value = edited(parsed, entries => {
      entries.set(pdfName('Foo').bytes, pdfInteger(5));
      entries.set(pdfName('Arr').bytes, pdfArray([pdfName('A'), pdfInteger(7)]));
      entries.set(pdfName('List').bytes, pdfArray([pdfInteger(5), pdfInteger(7)]));
    });
    expect(merge(value, parsed).text).toBe('<</Foo 5/Arr[/A 7]/List[5 7]>>');
  });

  it('serializes values without an original with the plain serializer', () => {
    const fresh = pdfArray([pdfReal(0.1234567), pdfName('X')]);
    const longer = pdfArray([pdfInteger(1), pdfReal(2.5), pdfInteger(4), pdfInteger(5)]);
    const parsed = parse('[1 2.50 3]');
    expect(merge(fresh).text).toBe('[0.12346 /X]');
    expect(merge(longer, parsed).text).toBe('[1 2.50 4 5]');
    expect(merge(pdfName('Other'), parsed).text).toBe('/Other');
  });

  it('writes a stream with its Length set to the data length and keeps the other dictionary bytes', () => {
    const dictionary = parse('<< /Filter /FlateDecode /Length 9 0 R /DecodeParms <</Columns 4>> >>');
    const indirect = { kind: 'stream', dictionary: entriesOf(dictionary), data: latin1Bytes('abc') } as const;
    expect(merge(indirect, dictionary).text).toBe('<</Filter /FlateDecode/Length 3/DecodeParms <</Columns 4>>>>\nstream\nabc\nendstream');
    const same = parse('<</Length 3>>');
    expect(merge({ kind: 'stream', dictionary: entriesOf(same), data: latin1Bytes('abc') }, same).text).toBe('<</Length 3>>\nstream\nabc\nendstream');
  });
});

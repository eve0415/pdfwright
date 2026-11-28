import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';

import { decodeStream } from './decodeStream.ts';

type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

const stream = (data: Uint8Array, entries: Array<[string, PdfDirectObject]>): PdfStream => ({
  kind: 'stream',
  dictionary: new PdfDictionaryEntries(entries.map(([key, value]) => [pdfName(key).bytes, value])),
  data,
});

const ignore = (): void => {
  // Warnings are not under test here.
};

const dictionary = (entries: Array<[string, PdfDirectObject]>): PdfDirectObject =>
  pdfDictionary(new PdfDictionaryEntries(entries.map(([key, value]) => [pdfName(key).bytes, value])));

const NULL: PdfDirectObject = { kind: 'null' };

// PNG Up rows of four columns (a tag byte, then the difference from the row above) and the rows they decode to.
const upRows = Uint8Array.of(2, 1, 0, 16, 0, 2, 0, 0, 58, 0);
const upDecoded = Uint8Array.of(1, 0, 16, 0, 1, 0, 74, 0);
const pngColumns4 = dictionary([
  ['Predictor', pdfInteger(12)],
  ['Columns', pdfInteger(4)],
]);

// Resolves 9 0 R to the name ASCIIHexDecode, 10 0 R to the Predictor 12, Columns 4 dictionary, 11 0 R to the null object, 12 0 R to the name Identity and 13 0 R to the name StdCF; any other reference names no object.
const objects = new Map<string, PdfObject>([
  ['9 0', pdfName('ASCIIHexDecode')],
  ['10 0', pngColumns4],
  ['11 0', NULL],
  ['12 0', pdfName('Identity')],
  ['13 0', pdfName('StdCF')],
]);
const deref = (value: PdfDirectObject | undefined): PdfObject | undefined =>
  value?.kind === 'reference' ? objects.get(`${String(value.objectNumber)} ${String(value.generation)}`) : value;

interface Decoded {
  data: Uint8Array;
  warnings: Array<LoadWarning>;
}

const decode = (input: PdfStream, maxDecodedBytes = 1_048_576): Decoded => {
  const warnings: Array<LoadWarning> = [];
  const data = decodeStream(input, {
    maxDecodedBytes,
    warn: warning => {
      warnings.push(warning);
    },
  });
  return { data, warnings };
};

const text = new TextEncoder().encode('BT /F1 12 Tf (Hello) Tj ET\n'.repeat(20));

const hexText = (bytes: Uint8Array): Uint8Array => new TextEncoder().encode([...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''));

// Packs codes high-order bit first into bytes, as ISO 32000-1:2008, 7.4.4.2 describes.
const packCodes = (codes: ReadonlyArray<readonly [number, number]>): Uint8Array => {
  let bits = '';
  for (const [code, width] of codes) {
    bits += code.toString(2).padStart(width, '0');
  }
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes: Array<number> = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Uint8Array.from(bytes);
};

// LZW data of one literal code per byte after a clear, all at 9 bits, ended by EOD.
const lzwLiterals = (bytes: Uint8Array): Uint8Array => packCodes([[256, 9], ...[...bytes].map(byte => [byte, 9] as const), [257, 9]]);

describe('stream decoding', () => {
  it('returns unfiltered data unchanged', () => {
    const input = stream(text, []);
    expect(decode(input).data).toStrictEqual(text);
  });

  it('limits unfiltered streams and empty filter arrays', () => {
    expect(() => decode(stream(text, []), 100)).toThrow(ResourceLimitError);
    expect(() => decode(stream(text, [['Filter', pdfArray([])]]), 100)).toThrow(ResourceLimitError);
  });

  it('accepts an unfiltered stream of exactly maxDecodedBytes and refuses one byte more', () => {
    expect(decode(stream(text, []), text.length).data).toStrictEqual(text);
    expect(() => decode(stream(text, []), text.length - 1)).toThrow(ResourceLimitError);
  });

  it('inflates FlateDecode data given as a name or a one-element array', () => {
    const compressed = deflateZlib(text);
    const flate = pdfName('FlateDecode');
    const single = stream(compressed, [['Filter', flate]]);
    const listed = stream(compressed, [['Filter', pdfArray([flate])]]);
    expect(decode(single).data).toStrictEqual(text);
    expect(decode(listed).data).toStrictEqual(text);
  });

  it('applies a PNG predictor from DecodeParms', () => {
    const input = stream(deflateZlib(upRows), [
      ['Filter', pdfName('FlateDecode')],
      ['DecodeParms', pngColumns4],
    ]);
    expect(decode(input).data).toStrictEqual(upDecoded);
  });

  // ISO 32000-1:2008, 7.3.8.2, Table 5: with several filters, DecodeParms is an array with one entry per filter, null where a filter takes the defaults.
  it('applies each entry of a DecodeParms array to the filter at the same position', () => {
    const input = stream(hexText(deflateZlib(upRows)), [
      ['Filter', pdfArray([pdfName('ASCIIHexDecode'), pdfName('FlateDecode')])],
      ['DecodeParms', pdfArray([NULL, pngColumns4])],
    ]);
    expect(decode(input).data).toStrictEqual(upDecoded);
  });

  it('applies a single DecodeParms dictionary to the first of two filters only', () => {
    // The outer layer stores the inner zlib stream as PNG rows of four bytes tagged None, and the inner one holds the Up rows themselves, which the predictor would change if it reached them.
    const inner = deflateZlib(upRows);
    const rows: Array<number> = [];
    for (let offset = 0; offset < inner.length; offset += 4) {
      rows.push(0, ...inner.subarray(offset, offset + 4));
    }
    const input = stream(deflateZlib(Uint8Array.from(rows)), [
      ['Filter', pdfArray([pdfName('FlateDecode'), pdfName('FlateDecode')])],
      ['DecodeParms', pngColumns4],
    ]);
    expect(decode(input).data).toStrictEqual(upRows);
  });

  it.each([
    ['a real', pdfReal(4)],
    ['a name', pdfName('Four')],
  ])('refuses a decode parameter given as %s', (_, columns) => {
    const input = stream(deflateZlib(upRows), [
      ['Filter', pdfName('FlateDecode')],
      [
        'DecodeParms',
        dictionary([
          ['Predictor', pdfInteger(12)],
          ['Columns', columns],
        ]),
      ],
    ]);
    expect(() => decode(input)).toThrow(ParseError);
  });

  it('reports flate warnings as load warnings', () => {
    const compressed = deflateZlib(text);
    const damaged = new Uint8Array(compressed.length + 1);
    damaged.set(compressed);
    damaged[compressed.length - 1] = 0;
    damaged[compressed.length] = 0x0a;
    const input = stream(damaged, [['Filter', pdfName('FlateDecode')]]);
    expect(decode(input).warnings.map(warning => warning.code)).toStrictEqual(['flate-checksum-mismatch', 'flate-trailing-data']);
  });

  it('reports a truncated flate trailer as a load warning', () => {
    const input = stream(deflateZlib(text).subarray(0, -2), [['Filter', pdfName('FlateDecode')]]);
    const decoded = decode(input);
    expect([decoded.data, decoded.warnings.map(warning => warning.code)]).toStrictEqual([text, ['flate-truncated-trailer']]);
  });

  it('refuses filters it does not implement and output above maxDecodedBytes', () => {
    const jbig2 = stream(text, [['Filter', pdfName('JBIG2Decode')]]);
    const numeric = stream(text, [['Filter', pdfInteger(1)]]);
    const large = stream(deflateZlib(text), [['Filter', pdfName('FlateDecode')]]);
    expect(() => decode(jbig2)).toThrow(UnsupportedFeatureError);
    expect(() => decode(numeric)).toThrow(ParseError);
    expect(() => decode(large, 100)).toThrow(ResourceLimitError);
  });

  it('applies filters in order, accepts abbreviations and follows indirect filters when given a resolver', () => {
    const hex = hexText(deflateZlib(text));
    const chained = stream(hex, [['Filter', pdfArray([pdfName('AHx'), pdfName('FlateDecode')])]]);
    expect(decode(chained).data).toStrictEqual(text);
    const indirect = stream(hex, [['Filter', pdfReference(9, 0)]]);
    expect(decodeStream(indirect, { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toStrictEqual(deflateZlib(text));
    expect(() => decode(indirect)).toThrow(ParseError);
  });

  it('resolves references inside a Filter array and a DecodeParms reference through the resolver', () => {
    const input = stream(hexText(deflateZlib(upRows)), [
      ['Filter', pdfArray([pdfReference(9, 0), pdfName('FlateDecode')])],
      ['DecodeParms', pdfArray([NULL, pdfReference(10, 0)])],
    ]);
    expect(decodeStream(input, { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toStrictEqual(upDecoded);
    const direct = stream(deflateZlib(upRows), [
      ['Filter', pdfName('FlateDecode')],
      ['DecodeParms', pdfReference(10, 0)],
    ]);
    expect(decodeStream(direct, { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toStrictEqual(upDecoded);
  });

  // ISO 32000-1:2008, 7.3.8.2, Table 5: DecodeParms is a dictionary, or an array of dictionaries and nulls; a value of any other kind, or a reference left unresolved, is refused rather than read as defaults that would return the predictor rows undecoded.
  it.each([
    ['an indirect reference with no resolver', pdfReference(10, 0)],
    ['an integer', pdfInteger(5)],
    ['a name', pdfName('Predictor')],
    ['an array holding an indirect reference with no resolver', pdfArray([pdfReference(10, 0)])],
    ['an array holding an integer', pdfArray([pdfInteger(5)])],
  ])('refuses DecodeParms given as %s', (_, value) => {
    const input = stream(deflateZlib(upRows), [
      ['Filter', pdfName('FlateDecode')],
      ['DecodeParms', value],
    ]);
    expect(() => decode(input)).toThrow(ParseError);
    expect(() => decode(input)).toThrow(/DecodeParms/u);
  });

  it.each([
    ['DecodeParms', pdfReference(9, 0)],
    ['a DecodeParms array entry', pdfArray([pdfReference(9, 0)])],
  ])('refuses %s whose reference resolves to an object that is not a dictionary', (_, value) => {
    const input = stream(deflateZlib(upRows), [
      ['Filter', pdfName('FlateDecode')],
      ['DecodeParms', value],
    ]);
    expect(() => decodeStream(input, { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toThrow(ParseError);
  });

  // ISO 32000-1:2008, 7.3.10 (quoted below): a DecodeParms reference to no object reads as null, which leaves the filter on its defaults.
  it.each([
    ['DecodeParms', pdfReference(8, 0)],
    ['a DecodeParms array entry', pdfArray([pdfReference(8, 0)])],
  ])('reads %s that refers to no object as the defaults', (_, value) => {
    const input = stream(deflateZlib(upRows), [
      ['Filter', pdfName('FlateDecode')],
      ['DecodeParms', value],
    ]);
    expect(decodeStream(input, { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toStrictEqual(upRows);
  });

  // ISO 32000-1:2008, 7.3.10: "An indirect reference to an undefined object shall not be considered an error by a conforming reader; it shall be treated as a reference to the null object."
  it('reads a null Filter, given directly, as a reference to the null object or as a reference to no object, as no filter', () => {
    expect(decode(stream(text, [['Filter', NULL]])).data).toStrictEqual(text);
    for (const reference of [pdfReference(11, 0), pdfReference(8, 0)]) {
      expect(decodeStream(stream(text, [['Filter', reference]]), { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toStrictEqual(text);
    }
  });

  // ISO 32000-1:2008, 7.4.10: a Crypt filter other than Identity needs the document's security handler.
  it('refuses data through a Crypt filter that needs decryption', () => {
    const crypt = stream(text, [
      ['Filter', pdfName('Crypt')],
      ['DecodeParms', dictionary([['Name', pdfName('StdCF')]])],
    ]);
    expect(() => decode(crypt)).toThrow(UnsupportedFeatureError);
    // An unknown filter is refused too; the message is what says decryption is the reason.
    expect(() => decode(crypt)).toThrow(/decryption/u);
  });

  // ISO 32000-1:2008, 7.4.10, Table 14: Name defaults to Identity; 7.6.5, Table 26: Identity "Input data shall be passed through without any processing."
  it.each([
    ['DecodeParms naming Identity', [['DecodeParms', dictionary([['Name', pdfName('Identity')]])]]],
    ['DecodeParms with no Name', [['DecodeParms', dictionary([['Type', pdfName('CryptFilterDecodeParms')]])]]],
    ['no DecodeParms', []],
  ] satisfies Array<[string, Array<[string, PdfDirectObject]>]>)('passes data through the Identity crypt filter given %s', (_, extra) => {
    expect(decode(stream(text, [['Filter', pdfName('Crypt')], ...extra])).data).toStrictEqual(text);
  });

  it('decodes the filters after an Identity crypt filter', () => {
    const input = stream(deflateZlib(upRows), [
      ['Filter', pdfArray([pdfName('Crypt'), pdfName('FlateDecode')])],
      ['DecodeParms', pdfArray([NULL, pngColumns4])],
    ]);
    expect(decode(input).data).toStrictEqual(upDecoded);
  });

  it('refuses a crypt filter Name that is not a name', () => {
    const crypt = stream(text, [
      ['Filter', pdfName('Crypt')],
      ['DecodeParms', dictionary([['Name', pdfInteger(1)]])],
    ]);
    expect(() => decode(crypt)).toThrow(ParseError);
  });

  const cryptNamed = (name: PdfDirectObject): PdfStream =>
    stream(text, [
      ['Filter', pdfName('Crypt')],
      ['DecodeParms', dictionary([['Name', name]])],
    ]);

  // ISO 32000-1:2008, 7.3.9: "Specifying the null object as the value of a dictionary entry (7.3.7, "Dictionary Objects") shall be equivalent to omitting the entry entirely", and a reference to a nonexistent object is treated as null, so Name takes its default, Identity.
  it.each([
    ['a reference to Identity', pdfReference(12, 0)],
    ['a reference to the null object', pdfReference(11, 0)],
    ['a reference to no object', pdfReference(8, 0)],
    ['null', NULL],
  ])('passes data through a crypt filter whose Name is %s', (_, name) => {
    expect(decodeStream(cryptNamed(name), { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toStrictEqual(text);
  });

  it('refuses a crypt filter whose Name refers to a crypt filter that needs decryption', () => {
    const run = (): Uint8Array => decodeStream(cryptNamed(pdfReference(13, 0)), { maxDecodedBytes: 1_048_576, warn: ignore, deref });
    expect(run).toThrow(UnsupportedFeatureError);
    expect(run).toThrow(/decryption/u);
  });

  it('refuses a crypt filter Name given as a reference with no resolver', () => {
    expect(() => decode(cryptNamed(pdfReference(12, 0)))).toThrow(ParseError);
  });
});

describe('filter names', () => {
  const payload = new TextEncoder().encode('Man is distinguished');

  // ISO 32000-1:2008, Table 94 gives the abbreviated filter names, which decode as the full names do.
  it.each([
    ['A85', 'ASCII85Decode', new TextEncoder().encode('9jqo^BlbD-BleB1DJ+*+F(f,q~>')],
    ['LZW', 'LZWDecode', lzwLiterals(payload)],
    ['Fl', 'FlateDecode', deflateZlib(payload)],
    ['RL', 'RunLengthDecode', Uint8Array.of(payload.length - 1, ...payload, 128)],
    ['AHx', 'ASCIIHexDecode', hexText(payload)],
  ])('decodes %s as %s', (abbreviation, name, data) => {
    expect([decode(stream(data, [['Filter', pdfName(abbreviation)]])).data, decode(stream(data, [['Filter', pdfName(name)]])).data]).toStrictEqual([
      payload,
      payload,
    ]);
  });

  it.each([
    ['CCF', /CCITTFaxDecode/u],
    ['DCT', /DCTDecode/u],
  ])('refuses %s and names the filter it abbreviates', (abbreviation, name) => {
    const input = stream(text, [['Filter', pdfName(abbreviation)]]);
    expect(() => decode(input)).toThrow(UnsupportedFeatureError);
    expect(() => decode(input)).toThrow(name);
  });
});

describe('LZWDecode parameters', () => {
  it('reads EarlyChange from DecodeParms', () => {
    // 254 literal codes after a clear fill the table to 511 entries, so EOD is written with 9 bits, as EarlyChange 0 reads it; EarlyChange 1 reads 10 bits there, which with the byte after it name no table entry.
    const literals = Uint8Array.from({ length: 254 }, (_, index) => index % 200);
    const data = packCodes([[256, 9], ...[...literals].map(byte => [byte, 9] as const), [257, 9], [0xff, 8]]);
    const late = stream(data, [
      ['Filter', pdfName('LZWDecode')],
      ['DecodeParms', dictionary([['EarlyChange', pdfInteger(0)]])],
    ]);
    const early = stream(data, [['Filter', pdfName('LZWDecode')]]);
    expect(decode(late).data).toStrictEqual(literals);
    expect(() => decode(early)).toThrow(ParseError);
  });

  it('applies a PNG predictor from DecodeParms', () => {
    const input = stream(lzwLiterals(upRows), [
      ['Filter', pdfName('LZWDecode')],
      ['DecodeParms', pngColumns4],
    ]);
    expect(decode(input).data).toStrictEqual(upDecoded);
  });
});

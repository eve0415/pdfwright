import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';

import { decodeStream } from './decodeStream.ts';

type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

const stream = (data: Uint8Array, entries: [string, PdfDirectObject][]): PdfStream => ({
  kind: 'stream',
  dictionary: new PdfDictionaryEntries(entries.map(([key, value]) => [pdfName(key).bytes, value])),
  data,
});

const ignore = (): void => {
  // Warnings are not under test here.
};

// Resolves every reference to the name ASCIIHexDecode.
const deref = (value: PdfDirectObject | undefined): PdfObject | undefined => (value?.kind === 'reference' ? pdfName('ASCIIHexDecode') : value);

interface Decoded {
  data: Uint8Array;
  warnings: LoadWarning[];
}

const decode = (input: PdfStream, maxDecodedBytes = 1_048_576): Decoded => {
  const warnings: LoadWarning[] = [];
  const data = decodeStream(input, {
    maxDecodedBytes,
    warn: warning => {
      warnings.push(warning);
    },
  });
  return { data, warnings };
};

const text = new TextEncoder().encode('BT /F1 12 Tf (Hello) Tj ET\n'.repeat(20));

describe('stream decoding', () => {
  it('returns unfiltered data unchanged', () => {
    const input = stream(text, []);
    expect(decode(input).data).toBe(text);
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
    const rows = Uint8Array.of(2, 1, 0, 16, 0, 2, 0, 0, 58, 0);
    const parameters = pdfDictionary(
      new PdfDictionaryEntries([
        [pdfName('Predictor').bytes, pdfInteger(12)],
        [pdfName('Columns').bytes, pdfInteger(4)],
      ]),
    );
    const input = stream(deflateZlib(rows), [
      ['Filter', pdfName('FlateDecode')],
      ['DecodeParms', parameters],
    ]);
    expect(decode(input).data).toStrictEqual(Uint8Array.of(1, 0, 16, 0, 1, 0, 74, 0));
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

  it('refuses filters it does not implement and output above maxDecodedBytes', () => {
    const jbig2 = stream(text, [['Filter', pdfName('JBIG2Decode')]]);
    const numeric = stream(text, [['Filter', pdfInteger(1)]]);
    const large = stream(deflateZlib(text), [['Filter', pdfName('FlateDecode')]]);
    expect(() => decode(jbig2)).toThrow(UnsupportedFeatureError);
    expect(() => decode(numeric)).toThrow(ParseError);
    expect(() => decode(large, 100)).toThrow(ResourceLimitError);
  });

  it('applies filters in order, accepts abbreviations and follows indirect filters when given a resolver', () => {
    const hex = new TextEncoder().encode([...deflateZlib(text)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
    const chained = stream(hex, [['Filter', pdfArray([pdfName('AHx'), pdfName('FlateDecode')])]]);
    expect(decode(chained).data).toStrictEqual(text);
    const indirect = stream(hex, [['Filter', pdfReference(9, 0)]]);
    expect(decodeStream(indirect, { maxDecodedBytes: 1_048_576, warn: ignore, deref })).toStrictEqual(deflateZlib(text));
    expect(() => decode(indirect)).toThrow(ParseError);
  });

  it('refuses Crypt-filtered data', () => {
    const crypt = stream(text, [['Filter', pdfName('Crypt')]]);
    expect(() => decode(crypt)).toThrow(UnsupportedFeatureError);
  });
});

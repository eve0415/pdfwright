import type { PdfDirectObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfReal } from '../object/pdfObject.ts';

import { createPdfFunction } from './pdfFunction.ts';

const key = (name: string): Uint8Array => new TextEncoder().encode(name);
const numbers = (values: number[]): ReturnType<typeof pdfArray> => pdfArray(values.map(value => pdfReal(value)));
const functionObject = (type: number, extra: Record<string, PdfDirectObject>): ReturnType<typeof pdfDictionary> => {
  const entries = new PdfDictionaryEntries();
  entries.set(key('FunctionType'), pdfInteger(type));
  entries.set(key('Domain'), numbers([0, 1]));
  for (const [name, value] of Object.entries(extra)) {
    entries.set(key(name), value);
  }
  return pdfDictionary(entries);
};

const streamFunction = (type: number, extra: Record<string, PdfDirectObject>, data: Uint8Array) => ({
  kind: 'stream' as const,
  dictionary: functionObject(type, extra).entries,
  data,
});

describe('pdf functions', () => {
  it('interpolates packed samples and clips domain and range', () => {
    const sampled = streamFunction(0, { Size: numbers([2]), BitsPerSample: pdfInteger(8), Range: numbers([0, 1]) }, Uint8Array.of(0, 255));
    const evaluate = createPdfFunction(sampled);
    expect(evaluate([0.5])).toStrictEqual([0.5]);
    expect(evaluate([-1])).toStrictEqual([0]);
    const bilinear = streamFunction(
      0,
      { Domain: numbers([0, 1, 0, 1]), Size: numbers([2, 2]), BitsPerSample: pdfInteger(4), Range: numbers([0, 1]) },
      Uint8Array.of(0x0f, 0xf0),
    );
    expect(createPdfFunction(bilinear)([0.25, 0.75])).toStrictEqual([0.625]);
  });

  it('evaluates exponential and stitched functions', () => {
    const left = functionObject(2, { C0: numbers([0]), C1: numbers([1]), N: pdfInteger(2) });
    const right = functionObject(2, { C0: numbers([1]), C1: numbers([0]), N: pdfInteger(1) });
    const stitched = functionObject(3, { Functions: pdfArray([left, right]), Bounds: numbers([0.5]), Encode: numbers([0, 1, 0, 1]) });
    expect(createPdfFunction(left)([0.5])).toStrictEqual([0.25]);
    expect(createPdfFunction(stitched)([0.25])).toStrictEqual([0.25]);
    expect(createPdfFunction(stitched)([0.75])).toStrictEqual([0.5]);
  });

  it('executes calculator branches with a bounded operand stack', () => {
    const calculator = streamFunction(4, { Range: numbers([0, 1]) }, new TextEncoder().encode('{ dup 0.5 lt { dup mul } { 1 exch sub } ifelse }'));
    const evaluate = createPdfFunction(calculator);
    expect(evaluate([0.25])).toStrictEqual([0.0625]);
    expect(evaluate([0.75])).toStrictEqual([0.25]);
  });
});

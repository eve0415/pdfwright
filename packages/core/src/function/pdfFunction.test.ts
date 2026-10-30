import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { md5 } from '../hash/md5.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfReal, pdfReference } from '../object/pdfObject.ts';

import { createPdfFunction, createPdfFunctionReader } from './pdfFunction.ts';

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

const resolveObject = (objects: ReadonlyMap<number, PdfDirectObject>, value: PdfDirectObject): PdfObject => {
  if (value.kind !== 'reference') return value;
  const resolved = objects.get(value.objectNumber);
  if (resolved === undefined) throw new Error('missing test object');
  return resolved;
};

// Objects 2 to levels + 1 are stitching functions that each refer four times to the object below, and object 1 is a Type 2 function.
const sharedChain = (levels: number): Map<number, PdfDirectObject> => {
  const objects = new Map<number, PdfDirectObject>([[1, functionObject(2, { C0: numbers([0]), C1: numbers([1]), N: pdfInteger(1) })]]);
  for (let level = 1; level <= levels; level++) {
    const below = pdfReference(level, 0);
    objects.set(
      level + 1,
      functionObject(3, { Functions: pdfArray([below, below, below, below]), Bounds: numbers([0.25, 0.5, 0.75]), Encode: numbers([0, 1, 0, 1, 0, 1, 0, 1]) }),
    );
  }
  return objects;
};

// A stitching function that splits [0 1] evenly between its subfunctions.
const evenStitching = (children: PdfDirectObject[]): ReturnType<typeof pdfDictionary> => {
  const bounds = numbers(Array.from({ length: children.length - 1 }, (_, index) => (index + 1) / children.length));
  const encode = numbers(children.flatMap(() => [0, 1]));
  return functionObject(3, { Functions: pdfArray(children), Bounds: bounds, Encode: encode });
};

const countingResolver = (objects: ReadonlyMap<number, PdfDirectObject>) => {
  const resolved: number[] = [];
  const resolve = (value: PdfDirectObject): PdfObject => {
    if (value.kind === 'reference') resolved.push(value.objectNumber);
    if (resolved.length > 1000) throw new Error('resolved more than 1000 references');
    return resolveObject(objects, value);
  };
  return { resolved, resolve };
};

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

  it('keeps fractional exponential outputs identical across runtimes', () => {
    const evaluate = createPdfFunction(functionObject(2, { N: pdfReal(0.73) }));
    const bytes = new Uint8Array(4096 * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 4096; index++) view.setFloat64(index * 8, Number(evaluate([(index + 0.5) / 4096])[0]), true);
    const digest = [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('99d1177a420226d463c2d956854aa51e');
  });

  it('resolves indirect stitching entries and subfunctions', () => {
    const left = functionObject(2, { C0: numbers([0]), C1: numbers([1]), N: pdfInteger(2) });
    const right = functionObject(2, { C0: numbers([1]), C1: numbers([0]), N: pdfInteger(1) });
    const stitched = functionObject(3, { Functions: pdfReference(10, 0), Bounds: pdfReference(11, 0), Encode: pdfReference(12, 0) });
    const objects = new Map<number, PdfDirectObject>([
      [10, pdfArray([pdfReference(13, 0), pdfReference(14, 0)])],
      [11, numbers([0.5])],
      [12, numbers([0, 1, 0, 1])],
      [13, left],
      [14, right],
    ]);
    const evaluate = createPdfFunction(stitched, value => resolveObject(objects, value));
    expect(evaluate([0.25])).toStrictEqual([0.25]);
    expect(evaluate([0.75])).toStrictEqual([0.5]);
  });

  it('resolves indirect entries and array items of every function type', () => {
    const objects = new Map<number, PdfDirectObject>([
      [20, pdfInteger(2)],
      [21, numbers([0, 1])],
      [22, numbers([0, 1])],
      [23, pdfArray([pdfReference(24, 0)])],
      [24, pdfReal(0.5)],
      [25, pdfInteger(2)],
      [26, { kind: 'null' }],
      [27, numbers([2])],
      [28, pdfInteger(8)],
      [29, numbers([1, 0])],
    ]);
    const resolve = (value: PdfDirectObject): PdfObject => resolveObject(objects, value);
    const exponential = functionObject(2, {
      FunctionType: pdfReference(20, 0),
      Domain: pdfReference(21, 0),
      Range: pdfReference(22, 0),
      C0: pdfReference(26, 0),
      C1: pdfReference(23, 0),
      N: pdfReference(25, 0),
    });
    const sampled = streamFunction(
      0,
      { Domain: pdfReference(21, 0), Size: pdfReference(27, 0), BitsPerSample: pdfReference(28, 0), Range: pdfReference(22, 0), Decode: pdfReference(29, 0) },
      Uint8Array.of(0, 255),
    );
    const calculator = streamFunction(4, { Domain: pdfReference(21, 0), Range: pdfReference(22, 0) }, new TextEncoder().encode('{ dup mul }'));
    expect([
      createPdfFunction(exponential, resolve)([0.5]),
      createPdfFunction(sampled, resolve)([0.25]),
      createPdfFunction(calculator, resolve)([0.5]),
    ]).toStrictEqual([[0.125], [0.75], [0.25]]);
    expect(createPdfFunction(exponential, resolve).domain).toStrictEqual([0, 1]);
  });

  it('builds each indirect function once however often the graph refers to it', () => {
    const objects = sharedChain(12);
    const { resolved, resolve } = countingResolver(objects);
    const evaluate = createPdfFunction(resolveObject(objects, pdfReference(13, 0)), resolve);
    expect([evaluate([0.3]), resolved.toSorted((a, b) => a - b)]).toStrictEqual([
      [expect.closeTo(0.3 * 4 ** 12 - Math.floor(0.3 * 4 ** 12), 6)],
      Array.from({ length: 12 }, (_, index) => index + 1),
    ]);
  });

  it('shares built functions between the functions one reader builds', () => {
    const objects = sharedChain(8);
    const { resolved, resolve } = countingResolver(objects);
    const read = createPdfFunctionReader(resolve);
    const channels = [
      pdfReference(9, 0),
      pdfReference(9, 0),
      functionObject(3, { Functions: pdfArray([pdfReference(8, 0)]), Bounds: numbers([]), Encode: numbers([0, 1]) }),
    ].map(value => read(value));
    expect([channels.map(channel => channel([0.5])[0]), resolved.length]).toStrictEqual([[0, 0, 0], 9]);
  });

  it('limits nesting through functions built earlier', () => {
    const objects = sharedChain(16);
    const read = createPdfFunctionReader(value => resolveObject(objects, value));
    expect(read(pdfReference(17, 0))([0.5])).toStrictEqual([0]);
    expect(() => read(evenStitching([pdfReference(17, 0)]))).toThrow(ResourceLimitError);
  });

  it('limits the number of functions one graph builds', () => {
    const children = Array.from({ length: 65_536 }, (_, index) => functionObject(2, { C0: numbers([index]), N: pdfInteger(1) }));
    const atLimit = evenStitching(children.slice(1));
    expect(createPdfFunction(atLimit)([0])).toStrictEqual([1]);
    expect(() => createPdfFunction(evenStitching(children))).toThrow(ResourceLimitError);
  });

  it('rejects a function that refers to itself', () => {
    const objects = new Map<number, PdfDirectObject>([[1, evenStitching([pdfReference(1, 0)])]]);
    const resolve = (value: PdfDirectObject): PdfObject => resolveObject(objects, value);
    expect(() => createPdfFunction(resolve(pdfReference(1, 0)), resolve)).toThrow(ResourceLimitError);
  });

  it('executes calculator branches with a bounded operand stack', () => {
    const calculator = streamFunction(4, { Range: numbers([0, 1]) }, new TextEncoder().encode('{ dup 0.5 lt { dup mul } { 1 exch sub } ifelse }'));
    const evaluate = createPdfFunction(calculator);
    expect(evaluate([0.25])).toStrictEqual([0.0625]);
    expect(evaluate([0.75])).toStrictEqual([0.25]);
  });
});

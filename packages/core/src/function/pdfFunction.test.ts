import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { md5 } from '../hash/md5.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfReal, pdfReference } from '../object/pdfObject.ts';

import { createPdfFunction, createPdfFunctionReader } from './pdfFunction.ts';

const key = (name: string): Uint8Array => new TextEncoder().encode(name);
const numbers = (values: Array<number>): ReturnType<typeof pdfArray> => pdfArray(values.map(value => pdfReal(value)));
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
  if (value.kind !== 'reference') {
    return value;
  }
  const resolved = objects.get(value.objectNumber);
  if (resolved === undefined) {
    throw new Error('missing test object');
  }
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
const evenStitching = (children: Array<PdfDirectObject>): ReturnType<typeof pdfDictionary> => {
  const bounds = numbers(Array.from({ length: children.length - 1 }, (_, index) => (index + 1) / children.length));
  const encode = numbers(children.flatMap(() => [0, 1]));
  return functionObject(3, { Functions: pdfArray(children), Bounds: bounds, Encode: encode });
};

const countingResolver = (objects: ReadonlyMap<number, PdfDirectObject>) => {
  const resolved: Array<number> = [];
  const resolve = (value: PdfDirectObject): PdfObject => {
    if (value.kind === 'reference') {
      resolved.push(value.objectNumber);
    }
    if (resolved.length > 1000) {
      throw new Error('resolved more than 1000 references');
    }
    return resolveObject(objects, value);
  };
  return { resolved, resolve };
};

describe('pdf functions', () => {
  it('interpolates packed samples with the first input varying fastest and clips domain and range', () => {
    const sampled = streamFunction(0, { Size: numbers([2]), BitsPerSample: pdfInteger(8), Range: numbers([0, 1]) }, Uint8Array.of(0, 255));
    const evaluate = createPdfFunction(sampled);
    expect(evaluate([0.5])).toStrictEqual([0.5]);
    expect(evaluate([-1])).toStrictEqual([0]);
    // ISO 32000-1:2008, 7.10.2: the first input varies fastest, so the 4-bit samples 0, 1, 2 and 3 sit at (0, 0), (1, 0), (0, 1) and (1, 1).
    const bilinear = createPdfFunction(
      streamFunction(
        0,
        { Domain: numbers([0, 1, 0, 1]), Size: numbers([2, 2]), BitsPerSample: pdfInteger(4), Range: numbers([0, 1]) },
        Uint8Array.of(0x01, 0x23),
      ),
    );
    expect([bilinear([1, 0]), bilinear([0, 1]), bilinear([0.5, 0.5])]).toStrictEqual([[1 / 15], [2 / 15], [1.5 / 15]]);
    // ISO 32000-1:2008, 7.10.2: Decode maps samples to [0 2], and Range then clips the output to [0 1].
    const decoded = createPdfFunction(
      streamFunction(0, { Size: numbers([2]), BitsPerSample: pdfInteger(8), Range: numbers([0, 1]), Decode: numbers([0, 2]) }, Uint8Array.of(0, 255)),
    );
    expect([decoded([0.25]), decoded([1])]).toStrictEqual([[0.5], [1]]);
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
    for (let index = 0; index < 4096; index++) {
      view.setFloat64(index * 8, Number(evaluate([(index + 0.5) / 4096])[0]), true);
    }
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

  it('rejects a function that refers to itself before building it again', () => {
    const objects = new Map<number, PdfDirectObject>([[1, evenStitching([pdfReference(1, 0)])]]);
    const { resolved, resolve } = countingResolver(objects);
    expect(() => createPdfFunction(resolveObject(objects, pdfReference(1, 0)), resolve)).toThrow(ResourceLimitError);
    expect(resolved).toStrictEqual([1]);
  });

  it('executes calculator branches', () => {
    const calculator = streamFunction(4, { Range: numbers([0, 1]) }, new TextEncoder().encode('{ dup 0.5 lt { dup mul } { 1 exch sub } ifelse }'));
    const evaluate = createPdfFunction(calculator);
    expect(evaluate([0.25])).toStrictEqual([0.0625]);
    expect(evaluate([0.75])).toStrictEqual([0.25]);
  });
});

// A sampled function over Domain [0 1] with two 8-bit samples and Range [0 1], with entries replaced or added by extra.
const sampledFunction = (extra: Record<string, PdfDirectObject>, data: Uint8Array) =>
  streamFunction(0, { Size: numbers([2]), BitsPerSample: pdfInteger(8), Range: numbers([0, 1]), ...extra }, data);

// A sampled function with count inputs, each with one sample.
const sampledInputs = (count: number) =>
  streamFunction(
    0,
    {
      Domain: numbers(Array.from({ length: count }, () => [0, 1]).flat()),
      Size: numbers(Array.from({ length: count }, () => 1)),
      BitsPerSample: pdfInteger(8),
      Range: numbers([0, 1]),
    },
    Uint8Array.of(255),
  );

const oneBitSamples = new Uint8Array(2 ** 21).fill(0xff);
// A one-input sampled function with size 1-bit samples for each output, every one set to 1.
const oneBitTable = (size: number, range: Array<number>) =>
  streamFunction(0, { Size: numbers([size]), BitsPerSample: pdfInteger(1), Range: numbers(range) }, oneBitSamples);

const twelveBitTable = (length: number) => sampledFunction({ Size: numbers([3]), BitsPerSample: pdfInteger(12) }, new Uint8Array(length).fill(0xff));

describe('sampled functions', () => {
  // ISO 32000-1:2008, 7.10.2: samples are packed high bit first with no padding between them.
  it.each([
    [1, [0b1000_0000], [1, 0]],
    [2, [0b1101_0000], [3, 1]],
    [4, [0x1e], [0x1, 0xe]],
    [8, [0x12, 0xfe], [0x12, 0xfe]],
    [12, [0x12, 0x3a, 0xbc], [0x1_23, 0xa_bc]],
    [16, [0x12, 0x34, 0xab, 0xcd], [0x12_34, 0xab_cd]],
    [24, [0x12, 0x34, 0x56, 0xab, 0xcd, 0xef], [0x12_34_56, 0xab_cd_ef]],
    [32, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], [0x12_34_56_78, 0x9a_bc_de_f0]],
  ])('extracts %i-bit samples high bit first', (bits, bytes, samples) => {
    const evaluate = createPdfFunction(sampledFunction({ BitsPerSample: pdfInteger(bits) }, Uint8Array.from(bytes)));
    expect([evaluate([0]), evaluate([1])]).toStrictEqual(samples.map(sample => [sample / (2 ** bits - 1)]));
  });

  it('maps inputs through Encode and holds a single-sample axis', () => {
    // ISO 32000-1:2008, 7.10.2 and Table 39: Encode maps the Domain onto sample indexes, and its default is [0 Size-1].
    const reversed = createPdfFunction(sampledFunction({ Encode: numbers([1, 0]) }, Uint8Array.of(0, 255)));
    const single = createPdfFunction(sampledFunction({ Size: numbers([1]) }, Uint8Array.of(0x80)));
    const linear = createPdfFunction(sampledFunction({ Order: pdfInteger(1) }, Uint8Array.of(0, 255)));
    expect([reversed([0]), reversed([0.25]), single([0]), single([1]), linear([0.25])]).toStrictEqual([[1], [0.75], [0x80 / 255], [0x80 / 255], [0.25]]);
  });

  it('builds eight inputs and rejects nine', () => {
    expect(createPdfFunction(sampledInputs(8))(Array.from({ length: 8 }, () => 0.5))).toStrictEqual([1]);
    expect(() => createPdfFunction(sampledInputs(9))).toThrow(ParseError);
    expect(() => createPdfFunction(sampledInputs(9))).toThrow(/dimensions/);
  });

  it('builds a sample table of 16,777,216 values and rejects one more', () => {
    expect(createPdfFunction(oneBitTable(16_777_216, [0, 1]))([1])).toStrictEqual([1]);
    expect(createPdfFunction(oneBitTable(8_388_608, [0, 1, 0, 1]))([1])).toStrictEqual([1, 1]);
    expect(() => createPdfFunction(oneBitTable(16_777_217, [0, 1]))).toThrow(ResourceLimitError);
    expect(() => createPdfFunction(oneBitTable(8_388_609, [0, 1, 0, 1]))).toThrow(ResourceLimitError);
  });

  it('builds from exactly enough sample bytes and rejects one byte fewer', () => {
    // Three 12-bit samples need 36 bits, which is five bytes.
    expect(createPdfFunction(twelveBitTable(5))([0.5])).toStrictEqual([1]);
    expect(() => createPdfFunction(twelveBitTable(4))).toThrow(ParseError);
    expect(() => createPdfFunction(twelveBitTable(4))).toThrow(/truncated/);
  });

  it.each([
    ['a bit width of 3', { BitsPerSample: pdfInteger(3) }, /dimensions/],
    ['a Size for two inputs on a one-input Domain', { Size: numbers([2, 2]) }, /dimensions/],
    ['an Encode for two inputs', { Encode: numbers([0, 1, 0, 1]) }, /mapping/],
    ['a Decode for two outputs', { Decode: numbers([0, 1, 0, 1]) }, /mapping/],
  ])('rejects %s', (_, extra, pattern) => {
    const build = () => createPdfFunction(sampledFunction(extra, new Uint8Array(8)));
    expect(build).toThrow(ParseError);
    expect(build).toThrow(pattern);
  });

  it('rejects cubic spline interpolation as unsupported', () => {
    expect(() => createPdfFunction(sampledFunction({ Order: pdfInteger(3) }, Uint8Array.of(0, 255)))).toThrow(UnsupportedFeatureError);
  });
});

const constant = (value: number): ReturnType<typeof pdfDictionary> => functionObject(2, { C0: numbers([value]), C1: numbers([value]), N: pdfInteger(1) });
const identity = (): ReturnType<typeof pdfDictionary> => functionObject(2, { C0: numbers([0]), C1: numbers([1]), N: pdfInteger(1) });

describe('exponential functions', () => {
  it('interpolates every output between C0 and C1 and clips to Range', () => {
    // ISO 32000-1:2008, 7.10.3: each output j is C0[j] + x^N * (C1[j] - C0[j]).
    const pair = createPdfFunction(functionObject(2, { C0: numbers([0, 0]), C1: numbers([1, 2]), N: pdfInteger(1) }));
    const clipped = createPdfFunction(functionObject(2, { Range: numbers([0, 0.5]), N: pdfInteger(1) }));
    expect([pair([0.5]), clipped([0.25]), clipped([1])]).toStrictEqual([[0.5, 1], [0.25], [0.5]]);
  });

  it.each([
    ['C0 and C1 of different lengths', { C0: numbers([0, 0]), N: pdfInteger(1) }, /differ/],
    ['a Domain of two inputs', { Domain: numbers([0, 1, 0, 1]), N: pdfInteger(1) }, /one input/],
    ['a missing N', {}, /N must be a number/],
  ])('rejects %s', (_, extra, pattern) => {
    const build = () => createPdfFunction(functionObject(2, extra));
    expect(build).toThrow(ParseError);
    expect(build).toThrow(pattern);
  });
});

describe('stitching functions', () => {
  it('starts each subdomain at its bound and ends the last at the Domain maximum', () => {
    // ISO 32000-1:2008, 7.10.4: the subdomains are half-open, Bounds[i-1] <= x < Bounds[i], except the last, which includes Domain[1].
    const step = createPdfFunction(
      functionObject(3, { Functions: pdfArray([constant(0), constant(1)]), Bounds: numbers([0.5]), Encode: numbers([0, 1, 0, 1]) }),
    );
    const last = createPdfFunction(
      functionObject(3, { Functions: pdfArray([identity(), identity()]), Bounds: numbers([0.5]), Encode: numbers([0, 1, 0.2, 0.7]) }),
    );
    expect([step([0.499]), step([0.5]), last([1])]).toStrictEqual([[0], [1], [0.7]]);
  });

  it('maps each subdomain through its Encode pair', () => {
    const reversed = createPdfFunction(
      functionObject(3, { Functions: pdfArray([identity(), identity()]), Bounds: numbers([0.5]), Encode: numbers([1, 0, 0, 1]) }),
    );
    expect([reversed([0.125]), reversed([0.75])]).toStrictEqual([[0.75], [0.5]]);
  });

  it.each([
    ['Bounds of the wrong length', { Bounds: numbers([0.25, 0.5]) }, /invalid stitching intervals/],
    ['Encode of the wrong length', { Encode: numbers([0, 1]) }, /invalid stitching intervals/],
    ['an empty Functions array', { Functions: pdfArray([]), Bounds: numbers([]), Encode: numbers([]) }, /invalid stitching function/],
    ['Functions that is not an array', { Functions: identity() }, /invalid stitching function/],
    ['a Domain of two inputs', { Domain: numbers([0, 1, 0, 1]) }, /invalid stitching function/],
  ])('rejects %s', (_, extra, pattern) => {
    const build = () =>
      createPdfFunction(functionObject(3, { Functions: pdfArray([identity(), identity()]), Bounds: numbers([0.5]), Encode: numbers([0, 1, 0, 1]), ...extra }));
    expect(build).toThrow(ParseError);
    expect(build).toThrow(pattern);
  });
});

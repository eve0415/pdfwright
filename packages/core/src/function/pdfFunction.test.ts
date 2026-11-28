import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { md5 } from '../hash/md5.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfReal, pdfReference } from '../object/pdfObject.ts';

import { createPdfFunction, createPdfFunctionReader, pdfFunctionReferences } from './pdfFunction.ts';

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
    // ISO 32000-1:2008, 7.10.2: the input is clipped to the Domain before Encode maps it, so an input of 2 reads sample index 0.5 rather than 1.
    const halfEncoded = createPdfFunction(
      streamFunction(0, { Size: numbers([2]), BitsPerSample: pdfInteger(8), Range: numbers([0, 1]), Encode: numbers([0, 0.5]) }, Uint8Array.of(0, 255)),
    );
    expect(halfEncoded([2])).toStrictEqual([0.5]);
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

  it('clips calculator inputs to the Domain before the program runs', () => {
    // ISO 32000-1:2008, 7.10.1: an input outside the Domain is clipped to the nearest valid value, and the identity program then returns it within the wider Range.
    const evaluate = createPdfFunction(streamFunction(4, { Range: numbers([-5, 5]) }, new TextEncoder().encode('{ }')));
    expect([evaluate([2]), evaluate([-2]), evaluate([0.25])]).toStrictEqual([[1], [0], [0.25]]);
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
    expect(() => createPdfFunction(sampledInputs(9))).toThrow(/invalid sampled/);
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
    ['a bit width of 3', { BitsPerSample: pdfInteger(3) }, /invalid sampled/],
    ['a Size for two inputs on a one-input Domain', { Size: numbers([2, 2]) }, /invalid sampled/],
    // ISO 32000-1:2008, 7.10.2, Table 39: each Size is a positive integer.
    ['a Size of 0', { Size: numbers([0]) }, /Size/],
    ['a fractional Size', { Size: numbers([1.5]) }, /Size/],
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

  // ISO 32000-1:2008, 7.10.2, Table 39: the valid Order values are 1 and 3.
  it.each([0, 2])('rejects Order %i as malformed', order => {
    const build = () => createPdfFunction(sampledFunction({ Order: pdfInteger(order) }, Uint8Array.of(0, 255)));
    expect(build).toThrow(ParseError);
    expect(build).toThrow(/Order/);
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

  // ISO 32000-1:2008, 7.10.3, Table 40: the function has one input, C0 and C1 have one value per output, and N is required.
  it.each([
    ['C0 and C1 of different lengths', { C0: numbers([0, 0]), N: pdfInteger(1) }, /differ/],
    ['a Domain of two inputs', { Domain: numbers([0, 1, 0, 1]), N: pdfInteger(1) }, /one input/],
    ['a missing N', {}, /N must be a number/],
  ])('rejects %s', (_, extra, pattern) => {
    const build = () => createPdfFunction(functionObject(2, extra));
    expect(build).toThrow(ParseError);
    expect(build).toThrow(pattern);
  });

  // ISO 32000-1:2008, 7.10.3: if N is not an integer, every x in the Domain is non-negative, and if N is negative, no x in the Domain is 0.
  it('builds an exponent its Domain allows', () => {
    const outputs = [
      createPdfFunction(functionObject(2, { Domain: numbers([-1, 1]), N: pdfInteger(2) }))([-0.5]),
      createPdfFunction(functionObject(2, { Domain: numbers([0, 1]), N: pdfReal(0.5) }))([0.25]),
      createPdfFunction(functionObject(2, { Domain: numbers([0.5, 1]), N: pdfInteger(-1) }))([0.5]),
      createPdfFunction(functionObject(2, { Domain: numbers([-1, -0.5]), N: pdfInteger(-1) }))([-0.5]),
    ];
    expect(outputs).toStrictEqual([[0.25], [0.5], [2], [-2]]);
  });

  it.each([
    ['a fractional N on a Domain below 0', [-1, 1], pdfReal(0.5), /negative Domain/],
    ['a fractional N on a Domain entirely below 0', [-1, -0.5], pdfReal(0.5), /negative Domain/],
    ['a negative N on a Domain that starts at 0', [0, 1], pdfInteger(-1), /negative N/],
    ['a negative N on a Domain that ends at 0', [-1, 0], pdfInteger(-1), /negative N/],
    ['a negative N on a Domain of only 0', [0, 0], pdfInteger(-2), /negative N/],
  ])('rejects %s', (_, domain, exponent, pattern) => {
    const build = () => createPdfFunction(functionObject(2, { Domain: numbers(domain), N: exponent }));
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

  // ISO 32000-1:2008, 7.10.4: Encode maps each subdomain onto the Domain of its subfunction, so a reversed pair reverses it.
  it('maps each subdomain through its Encode pair', () => {
    const reversed = createPdfFunction(
      functionObject(3, { Functions: pdfArray([identity(), identity()]), Bounds: numbers([0.5]), Encode: numbers([1, 0, 0, 1]) }),
    );
    expect([reversed([0.125]), reversed([0.75])]).toStrictEqual([[0.75], [0.5]]);
  });

  // ISO 32000-1:2008, 7.10.4, Table 41: the function has one input, k subfunctions with k - 1 Bounds and 2k Encode values.
  it.each([
    ['Bounds of the wrong length', { Bounds: numbers([0.25, 0.5]) }, /intervals/],
    ['Encode of the wrong length', { Encode: numbers([0, 1]) }, /intervals/],
    ['an empty Functions array', { Functions: pdfArray([]), Bounds: numbers([]), Encode: numbers([]) }, /stitching function/],
    ['Functions that is not an array', { Functions: identity() }, /stitching function/],
    ['a Domain of two inputs', { Domain: numbers([0, 1, 0, 1]) }, /stitching function/],
  ])('rejects %s', (_, extra, pattern) => {
    const build = () =>
      createPdfFunction(functionObject(3, { Functions: pdfArray([identity(), identity()]), Bounds: numbers([0.5]), Encode: numbers([0, 1, 0, 1]), ...extra }));
    expect(build).toThrow(ParseError);
    expect(build).toThrow(pattern);
  });
});

// A function dictionary with only the given entries, so a test can leave out FunctionType or Domain.
const bareFunction = (extra: Record<string, PdfDirectObject>): ReturnType<typeof pdfDictionary> => {
  const entries = new PdfDictionaryEntries();
  for (const [name, value] of Object.entries(extra)) {
    entries.set(key(name), value);
  }
  return pdfDictionary(entries);
};

describe('function dictionaries', () => {
  it('reads equal Domain bounds and a Range that resolves to null as valid', () => {
    // ISO 32000-1:2008, 7.3.7: a null value is the same as an absent entry, so the output is not clipped.
    const point = createPdfFunction(functionObject(2, { Domain: numbers([0.5, 0.5]), N: pdfInteger(1) }));
    const objects = new Map<number, PdfDirectObject>([[1, { kind: 'null' }]]);
    const unclipped = createPdfFunction(functionObject(2, { C1: numbers([2]), Range: pdfReference(1, 0), N: pdfInteger(1) }), value =>
      resolveObject(objects, value),
    );
    expect([point([0]), unclipped([1])]).toStrictEqual([[0.5], [2]]);
  });

  // ISO 32000-1:2008, 7.10.1, Table 38: FunctionType and Domain are required, and Domain and Range are pairs of a minimum no greater than a maximum.
  it.each([
    ['a missing FunctionType', bareFunction({ Domain: numbers([0, 1]), N: pdfInteger(1) }), /FunctionType must be a number/],
    ['an integer object', pdfInteger(2), /dictionary or stream/],
    ['an empty Domain', functionObject(2, { Domain: numbers([]), N: pdfInteger(1) }), /Domain needs pairs/],
    ['an odd-length Domain', functionObject(2, { Domain: numbers([0, 1, 2]), N: pdfInteger(1) }), /Domain needs pairs/],
    ['a reversed Domain', functionObject(2, { Domain: numbers([1, 0]), N: pdfInteger(1) }), /Domain has reversed bounds/],
    ['a reversed Range', functionObject(2, { Range: numbers([1, 0]), N: pdfInteger(1) }), /Range has reversed bounds/],
    [
      'a Domain item that is not a number',
      functionObject(2, { Domain: pdfArray([pdfInteger(0), { kind: 'boolean', value: true }]), N: pdfInteger(1) }),
      /Domain must be a number/,
    ],
  ])('rejects %s', (_, object, pattern) => {
    const build = () => createPdfFunction(object);
    expect(build).toThrow(ParseError);
    expect(build).toThrow(pattern);
  });

  // ISO 32000-1:2008, 7.10.1, Table 38: Range is required for type 0 and type 4 functions; 7.10.2 and 7.10.5: both are stream functions.
  it.each([
    ['a sampled function without Range', streamFunction(0, { Size: numbers([2]), BitsPerSample: pdfInteger(8) }, Uint8Array.of(0, 255)), /Range/],
    ['a sampled function that is not a stream', functionObject(0, { Size: numbers([2]), BitsPerSample: pdfInteger(8), Range: numbers([0, 1]) }), /stream/],
    ['a calculator function without Range', streamFunction(4, {}, new TextEncoder().encode('{ }')), /Range/],
    ['a calculator function that is not a stream', functionObject(4, { Range: numbers([0, 1]) }), /stream/],
  ])('rejects %s as malformed', (_, object, pattern) => {
    const build = () => createPdfFunction(object);
    expect(build).toThrow(ParseError);
    expect(build).toThrow(pattern);
  });

  it.each([1, 5])('rejects FunctionType %i as unsupported', type => {
    expect(() => createPdfFunction(functionObject(type, {}))).toThrow(UnsupportedFeatureError);
  });

  it('rejects a reference that resolves to another reference', () => {
    const objects = new Map<number, PdfDirectObject>([
      [1, pdfReference(2, 0)],
      [2, identity()],
    ]);
    const build = () => createPdfFunction(pdfReference(1, 0), value => resolveObject(objects, value));
    expect(createPdfFunction(pdfReference(2, 0), value => resolveObject(objects, value))([0.5])).toStrictEqual([0.5]);
    expect(build).toThrow(ParseError);
    expect(build).toThrow(/does not resolve/);
  });

  it('rejects inputs and outputs whose count differs from Domain and Range', () => {
    const evaluate = createPdfFunction(identity());
    const outputs = createPdfFunction(functionObject(2, { C0: numbers([0, 0]), C1: numbers([1, 1]), Range: numbers([0, 1]), N: pdfInteger(1) }));
    expect(() => evaluate([0.5, 0.5])).toThrow(ParseError);
    expect(() => evaluate([0.5, 0.5])).toThrow(/input dimension/);
    expect(() => evaluate([])).toThrow(/input dimension/);
    expect(() => outputs([0.5])).toThrow(ParseError);
    expect(() => outputs([0.5])).toThrow(/output dimension/);
  });
});

// Each function from f0, the identity, to f(levels) stitches the one below it, all as direct objects.
const directChain = (levels: number): ReturnType<typeof pdfDictionary> => {
  let fn = identity();
  for (let level = 1; level <= levels; level++) {
    fn = evenStitching([fn]);
  }
  return fn;
};

describe('function readers', () => {
  it('builds 16 levels of nesting and rejects 17', () => {
    expect(createPdfFunction(directChain(16))([0.3])).toStrictEqual([0.3]);
    expect(() => createPdfFunction(directChain(17))).toThrow(ResourceLimitError);
  });

  it('forgets a reference whose build failed, so a second read fails the same way', () => {
    const read = createPdfFunctionReader(value => resolveObject(new Map([[1, pdfInteger(5)]]), value));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => read(pdfReference(1, 0))).toThrow(ParseError);
    }
  });

  it('counts one direct function object once however often a graph places it', () => {
    const children = Array.from({ length: 65_535 }, (_, index) => functionObject(2, { C0: numbers([index]), N: pdfInteger(1) }));
    const [first] = children;
    expect(createPdfFunction(evenStitching([...children, first ?? identity()]))([1])).toStrictEqual([1]);
  });
});

describe('pdfFunctionReferences', () => {
  it('lists each indirect object of a graph once, a self-reference and a shared one included', () => {
    const objects = new Map<number, PdfDirectObject>([
      [1, evenStitching([pdfReference(1, 0)])],
      [10, pdfArray([pdfReference(11, 0), pdfReference(11, 0)])],
      [11, functionObject(2, { C1: pdfReference(12, 0), N: pdfInteger(1) })],
      [12, numbers([1])],
    ]);
    const { resolved, resolve } = countingResolver(objects);
    const shared = functionObject(3, { Functions: pdfReference(10, 0), Bounds: numbers([0.5]), Encode: numbers([0, 1, 0, 1]) });
    const numbersOf = (value: PdfDirectObject) =>
      pdfFunctionReferences(value, resolve)
        .map(reference => reference.objectNumber)
        .toSorted((a, b) => a - b);
    expect([numbersOf(pdfReference(1, 0)), numbersOf(shared), resolved.toSorted((a, b) => a - b)]).toStrictEqual([[1], [10, 11, 12], [1, 10, 11, 12]]);
  });

  it('lists references inside a function stream dictionary', () => {
    const objects = new Map<number, PdfObject>([
      [2, streamFunction(4, { Domain: pdfReference(3, 0), Range: pdfReference(4, 0) }, new TextEncoder().encode('{ }'))],
      [3, numbers([0, 1])],
      [4, numbers([0, 1])],
    ]);
    const resolve = (value: PdfDirectObject): PdfObject => (value.kind === 'reference' ? (objects.get(value.objectNumber) ?? { kind: 'null' }) : value);
    expect(
      pdfFunctionReferences(pdfReference(2, 0), resolve)
        .map(reference => reference.objectNumber)
        .toSorted((a, b) => a - b),
    ).toStrictEqual([2, 3, 4]);
  });
});

// A sampled function over a width by height grid whose Domain is the grid's index range, with Range [0 255] so that each decoded output is the sample itself.
const gridFunction = (width: number, height: number, outputs: number, samples: Array<number>) =>
  createPdfFunction(
    streamFunction(
      0,
      {
        Domain: numbers([0, width - 1, 0, height - 1]),
        Size: numbers([width, height]),
        BitsPerSample: pdfInteger(8),
        Range: numbers(Array.from({ length: outputs }, () => [0, 255]).flat()),
      },
      Uint8Array.from(samples),
    ),
  );

// ISO 32000-1:2008, 7.10.2: sample (i, j) of a grid width wide is at index i + j * width, each holding every output in turn.
const sampleAt = (samples: Array<number>, width: number, outputs: number, column: number, row: number): Array<number> =>
  samples.slice((column + row * width) * outputs, (column + row * width + 1) * outputs);

describe('properties', () => {
  // A grid of two inputs and one or two outputs, with its samples.
  const grid = fc
    .record({ width: fc.integer({ min: 2, max: 4 }), height: fc.integer({ min: 1, max: 4 }), outputs: fc.integer({ min: 1, max: 2 }) })
    .chain(shape =>
      fc.record({
        shape: fc.constant(shape),
        samples: fc.array(fc.integer({ min: 0, max: 255 }), {
          minLength: shape.width * shape.height * shape.outputs,
          maxLength: shape.width * shape.height * shape.outputs,
        }),
      }),
    );

  it('returns each sample exactly at its grid point', () => {
    fc.assert(
      fc.property(grid, ({ shape: { width, height, outputs }, samples }) => {
        const evaluate = gridFunction(width, height, outputs, samples);
        const points = Array.from({ length: width * height }, (_, index) => [index % width, Math.floor(index / width)] as const);
        expect(points.map(([column, row]) => evaluate([column, row]))).toStrictEqual(
          points.map(([column, row]) => sampleAt(samples, width, outputs, column, row)),
        );
      }),
    );
  });

  it('interpolates linearly along the first input between two grid points', () => {
    fc.assert(
      fc.property(
        grid,
        fc.constantFrom(0.25, 0.5, 0.75),
        fc.nat(),
        fc.nat(),
        ({ shape: { width, height, outputs }, samples }, fraction, columnSeed, rowSeed) => {
          const column = columnSeed % (width - 1);
          const row = rowSeed % height;
          const low = sampleAt(samples, width, outputs, column, row);
          const high = sampleAt(samples, width, outputs, column + 1, row);
          expect(gridFunction(width, height, outputs, samples)([column + fraction, row])).toStrictEqual(
            low.map((value, index) => value * (1 - fraction) + (high[index] ?? 0) * fraction),
          );
        },
      ),
    );
  });
});

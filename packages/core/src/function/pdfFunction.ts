import type { PdfDictionaryEntries, PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { createCalculatorFunction } from './calculatorFunction.ts';
import { deterministicExp } from './deterministicMath.ts';

/** Evaluates a parsed PDF function from components in its Domain to output components constrained by its Range; malformed functions raise ParseError under ISO 32000-1:2008, 7.10. */
export interface PdfFunction {
  (input: readonly number[]): number[];
  /** The function's Domain, a minimum and a maximum for each input. */
  readonly domain: readonly number[];
}
/** Turns an indirect reference in a function graph into the object it names, with a stream's data decoded; a function reader applies it to every reference it meets. */
export type FunctionResolver = (value: PdfDirectObject) => PdfObject;

const key = (name: string): Uint8Array => new TextEncoder().encode(name);

/** Reads one entry of a function dictionary, following an indirect reference. */
type EntryReader = (name: string) => PdfObject | undefined;

const direct = (value: PdfDirectObject | undefined, resolve: FunctionResolver): PdfObject | undefined => {
  // ISO 32000-1:2008, 7.3.10: any value may be an indirect reference; 7.3.7: a null value is the same as an absent entry.
  const object = value?.kind === 'reference' ? resolve(value) : value;
  return object?.kind === 'null' ? undefined : object;
};

const entryReader =
  (entries: PdfDictionaryEntries, resolve: FunctionResolver): EntryReader =>
  name =>
    direct(entries.get(key(name)), resolve);

const numeric = (value: PdfObject | undefined, name: string): number => {
  if (value?.kind === 'integer') return value.value;
  if (value?.kind === 'real') return typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator);
  throw new ParseError(`function ${name} must be a number`, 0);
};

const numberArray = (value: PdfObject | undefined, name: string, resolve: FunctionResolver): number[] => {
  if (value?.kind !== 'array') throw new ParseError(`function ${name} must be an array`, 0);
  return value.items.map(item => numeric(direct(item, resolve), name));
};

const pairs = (values: readonly number[], name: string): void => {
  if (values.length === 0 || values.length % 2 !== 0) throw new ParseError(`function ${name} needs pairs`, 0);
  for (let index = 0; index < values.length; index += 2) {
    if ((values[index] ?? 0) > (values[index + 1] ?? 0)) throw new ParseError(`function ${name} has reversed bounds`, 0);
  }
};

const clip = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const interpolate = (value: number, source: readonly [number, number], target: readonly [number, number]): number =>
  source[0] === source[1] ? target[0] : target[0] + ((value - source[0]) * (target[1] - target[0])) / (source[1] - source[0]);

type Evaluate = (input: readonly number[]) => number[];

interface FunctionEntries {
  readonly entry: EntryReader;
  readonly array: (name: string) => number[];
  readonly optionalArray: (name: string, fallback: number[]) => number[];
}

const evaluateSampled = (entries: FunctionEntries, data: Uint8Array, limits: { domain: number[]; range: number[] }): Evaluate => {
  // ISO 32000-1:2008, 7.10.2 and Table 39: samples are a high-bit-first continuous stream, with the first input varying fastest.
  const { entry, array, optionalArray } = entries;
  const sizes = array('Size');
  const bits = numeric(entry('BitsPerSample'), 'BitsPerSample');
  const orderValue = entry('Order');
  const order = orderValue === undefined ? 1 : numeric(orderValue, 'Order');
  if (order !== 1) throw new UnsupportedFeatureError('cubic sampled functions are unsupported');
  if (sizes.length !== limits.domain.length / 2 || sizes.length > 8 || ![1, 2, 4, 8, 12, 16, 24, 32].includes(bits)) {
    throw new ParseError('invalid sampled function dimensions', 0);
  }
  const outputs = limits.range.length / 2;
  let count = outputs;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1 || count * size > 16_777_216) throw new ResourceLimitError('sampled function table is too large');
    count *= size;
  }
  if (Math.ceil((count * bits) / 8) > data.length) throw new ParseError('truncated sampled function', 0);
  const encode = optionalArray(
    'Encode',
    sizes.flatMap(size => [0, size - 1]),
  );
  const decode = optionalArray('Decode', limits.range);
  if (encode.length !== limits.domain.length || decode.length !== limits.range.length) throw new ParseError('sampled function mapping has wrong dimensions', 0);
  const sample = (index: number): number => {
    let value = 0;
    for (let bit = index * bits; bit < (index + 1) * bits; bit++) value = value * 2 + (Math.floor((data[Math.floor(bit / 8)] ?? 0) / 2 ** (7 - (bit % 8))) % 2);
    return value;
  };
  return input => {
    const positions = sizes.map((size, axis) => {
      const base = axis * 2;
      const source: [number, number] = [limits.domain[base] ?? 0, limits.domain[base + 1] ?? 0];
      const target: [number, number] = [encode[base] ?? 0, encode[base + 1] ?? 0];
      return clip(interpolate(clip(input[axis] ?? 0, source[0], source[1]), source, target), 0, size - 1);
    });
    const result: number[] = [];
    for (let channel = 0; channel < outputs; channel++) {
      let weighted = 0;
      for (let corner = 0; corner < 2 ** sizes.length; corner++) {
        let offset = 0;
        let stride = 1;
        let weight = 1;
        for (let axis = 0; axis < sizes.length; axis++) {
          const position = positions[axis] ?? 0;
          const floor = Math.floor(position);
          const upper = Math.min(floor + 1, (sizes[axis] ?? 1) - 1);
          const high = Math.floor(corner / 2 ** axis) % 2 === 1;
          offset += (high ? upper : floor) * stride;
          stride *= sizes[axis] ?? 1;
          weight *= high ? position - floor : 1 - (position - floor);
        }
        weighted += sample(offset * outputs + channel) * weight;
      }
      const decoded = interpolate(weighted, [0, 2 ** bits - 1], [decode[channel * 2] ?? 0, decode[channel * 2 + 1] ?? 0]);
      result.push(clip(decoded, limits.range[channel * 2] ?? 0, limits.range[channel * 2 + 1] ?? 0));
    }
    return result;
  };
};

const evaluateExponential = (entries: FunctionEntries, domain: number[]): Evaluate => {
  // ISO 32000-1:2008, 7.10.3 and Table 40.
  if (domain.length !== 2) throw new ParseError('exponential function needs one input', 0);
  const c0 = entries.optionalArray('C0', [0]);
  const c1 = entries.optionalArray('C1', [1]);
  const exponent = numeric(entries.entry('N'), 'N');
  if (c0.length !== c1.length) throw new ParseError('exponential function output dimensions differ', 0);
  return input =>
    c0.map((start, index) => start + deterministicExp(clip(input[0] ?? 0, domain[0] ?? 0, domain[1] ?? 0), exponent) * ((c1[index] ?? 0) - start));
};

const evaluateStitched = (entries: FunctionEntries, domain: number[], recurse: (item: PdfDirectObject) => PdfFunction): Evaluate => {
  // ISO 32000-1:2008, 7.10.4 and Table 41: intervals are half-open except the last.
  const functions = entries.entry('Functions');
  if (domain.length !== 2 || functions?.kind !== 'array' || functions.items.length === 0) throw new ParseError('invalid stitching function', 0);
  const bounds = entries.array('Bounds');
  const encode = entries.array('Encode');
  if (bounds.length !== functions.items.length - 1 || encode.length !== functions.items.length * 2) throw new ParseError('invalid stitching intervals', 0);
  const subfunctions = functions.items.map(item => recurse(item));
  return input => {
    const x = clip(input[0] ?? 0, domain[0] ?? 0, domain[1] ?? 0);
    const index = bounds.findIndex(bound => x < bound);
    const segment = index === -1 ? subfunctions.length - 1 : index;
    const start = segment === 0 ? (domain[0] ?? 0) : (bounds[segment - 1] ?? 0);
    const end = segment === bounds.length ? (domain[1] ?? 0) : (bounds[segment] ?? 0);
    const mapped = interpolate(x, [start, end], [encode[segment * 2] ?? 0, encode[segment * 2 + 1] ?? 0]);
    return subfunctions[segment]?.([mapped]) ?? [];
  };
};

const buildFunction = (object: PdfObject, resolve: FunctionResolver, recurse: (item: PdfDirectObject) => PdfFunction): PdfFunction => {
  if (object.kind !== 'dictionary' && object.kind !== 'stream') throw new ParseError('PDF function must be a dictionary or stream', 0);
  const entry = entryReader(object.kind === 'stream' ? object.dictionary : object.entries, resolve);
  const array = (name: string): number[] => numberArray(entry(name), name, resolve);
  const entries: FunctionEntries = {
    entry,
    array,
    optionalArray: (name, fallback) => (entry(name) === undefined ? fallback : array(name)),
  };
  const type = numeric(entry('FunctionType'), 'FunctionType');
  const domain = array('Domain');
  const range = entry('Range') === undefined ? undefined : array('Range');
  pairs(domain, 'Domain');
  if (range !== undefined) pairs(range, 'Range');
  const evaluate: Evaluate = (() => {
    if (type === 0 && object.kind === 'stream' && range !== undefined) return evaluateSampled(entries, object.data, { domain, range });
    if (type === 2) return evaluateExponential(entries, domain);
    if (type === 3) return evaluateStitched(entries, domain, recurse);
    if (type === 4 && object.kind === 'stream' && range !== undefined) return createCalculatorFunction(object.data, domain.length / 2, range.length / 2);
    throw new UnsupportedFeatureError(`unsupported PDF function type ${String(type)}`);
  })();
  const evaluateClipped: Evaluate = input => {
    if (input.length !== domain.length / 2) throw new ParseError('PDF function input dimension mismatch', 0);
    const output = evaluate(input.map((value, index) => clip(value, domain[index * 2] ?? 0, domain[index * 2 + 1] ?? 0)));
    if (range === undefined) return output;
    if (output.length !== range.length / 2) throw new ParseError('PDF function output dimension mismatch', 0);
    return output.map((value, index) => clip(value, range[index * 2] ?? 0, range[index * 2 + 1] ?? 0));
  };
  return Object.assign(evaluateClipped, { domain });
};

const referenceKey = (reference: PdfReference): string => `${String(reference.objectNumber)} ${String(reference.generation)}`;

/**
 * Lists each indirect object a function graph is made of once: its function objects, indirect Functions arrays and indirect entry values.
 * The resolver is applied to every reference the graph reaches, as a reader would apply it, so the list is what replacing the function leaves unused.
 */
export const pdfFunctionReferences = (value: PdfDirectObject, resolve: FunctionResolver): PdfReference[] => {
  const found = new Map<string, PdfReference>();
  const pending: PdfObject[] = [value];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.kind === 'reference') {
      // ISO 32000-1:2008, 7.3.10: references to one object name the same object, so it is listed and walked once.
      const id = referenceKey(item);
      if (found.has(id)) continue;
      found.set(id, item);
      pending.push(resolve(item));
    } else if (item.kind === 'array') pending.push(...item.items);
    else if (item.kind === 'dictionary') for (const [, entry] of item.entries.entries()) pending.push(entry);
    else if (item.kind === 'stream') for (const [, entry] of item.dictionary.entries()) pending.push(entry);
  }
  return [...found.values()];
};

const MAX_NESTING = 16;
const MAX_FUNCTIONS = 65_536;
const BUILDING = 'building';

/** A built function and the number of stitching levels below it. */
interface Built {
  readonly fn: PdfFunction;
  readonly height: number;
}

/** Builds PDF functions from function objects or references to them, sharing one resolver, and builds each indirect function once however many functions refer to it. */
export type PdfFunctionReader = (value: PdfObject) => PdfFunction;

/**
 * Creates a reader whose functions share every function object they reach, so a function graph costs one build per object.
 * A reader throws ResourceLimitError when its functions nest deeper than 16, refer to themselves, or need more than 65,536 function objects in all.
 */
export const createPdfFunctionReader = (resolve: FunctionResolver = value => value): PdfFunctionReader => {
  const byReference = new Map<string, Built | typeof BUILDING>();
  const shared = new WeakMap<PdfObject, Built>();
  let count = 0;
  const reuse = (built: Built, depth: number): Built => {
    if (depth + built.height > MAX_NESTING) throw new ResourceLimitError(`PDF function nesting exceeds ${String(MAX_NESTING)}`);
    return built;
  };
  const read = (value: PdfObject, depth: number): Built => {
    if (depth > MAX_NESTING) throw new ResourceLimitError(`PDF function nesting exceeds ${String(MAX_NESTING)}`);
    if (value.kind === 'reference') {
      // ISO 32000-1:2008, 7.3.10: an indirect object is one object however many references name it, so its function is built once.
      const id = referenceKey(value);
      const known = byReference.get(id);
      if (known === BUILDING) throw new ResourceLimitError('PDF function refers to itself');
      if (known !== undefined) return reuse(known, depth);
      const object = resolve(value);
      if (object.kind === 'reference') throw new ParseError('PDF function reference does not resolve to an object', 0);
      byReference.set(id, BUILDING);
      try {
        const built = read(object, depth);
        byReference.set(id, built);
        return built;
      } catch (error) {
        byReference.delete(id);
        throw error;
      }
    }
    const known = shared.get(value);
    if (known !== undefined) return reuse(known, depth);
    count += 1;
    if (count > MAX_FUNCTIONS) throw new ResourceLimitError(`PDF function graph needs more than ${String(MAX_FUNCTIONS)} function objects`);
    let height = 0;
    const fn = buildFunction(value, resolve, item => {
      const child = read(item, depth + 1);
      height = Math.max(height, child.height + 1);
      return child.fn;
    });
    const built = { fn, height };
    shared.set(value, built);
    return built;
  };
  return value => read(value, 0).fn;
};

/** Parses and evaluates a PDF function object, a decoded function stream, or a reference that the resolver turns into one. */
export const createPdfFunction = (object: PdfObject, resolve: FunctionResolver = value => value): PdfFunction => createPdfFunctionReader(resolve)(object);

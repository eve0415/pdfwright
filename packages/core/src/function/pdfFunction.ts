import type { PdfDictionaryEntries, PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { createCalculatorFunction } from './calculatorFunction.ts';

export type PdfFunction = (input: readonly number[]) => number[];
export type FunctionResolver = (value: PdfDirectObject) => PdfObject;

const key = (name: string): Uint8Array => new TextEncoder().encode(name);
const get = (entries: PdfDictionaryEntries, name: string): PdfDirectObject | undefined => entries.get(key(name));

const numeric = (value: PdfObject | undefined, name: string): number => {
  if (value?.kind === 'integer') return value.value;
  if (value?.kind === 'real') return typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator);
  throw new ParseError(`function ${name} must be a number`, 0);
};

const numberArray = (value: PdfDirectObject | undefined, name: string): number[] => {
  if (value?.kind !== 'array') throw new ParseError(`function ${name} must be an array`, 0);
  return value.items.map(item => numeric(item, name));
};

const resolvedNumberArray = (value: PdfDirectObject | undefined, name: string, resolve: FunctionResolver): number[] => {
  if (value === undefined) throw new ParseError(`function ${name} must be an array`, 0);
  const array = value.kind === 'reference' ? resolve(value) : value;
  if (array.kind !== 'array') throw new ParseError(`function ${name} must be an array`, 0);
  return array.items.map(item => numeric(item.kind === 'reference' ? resolve(item) : item, name));
};

const optionalArray = (entries: PdfDictionaryEntries, name: string, fallback: number[]): number[] => {
  const value = get(entries, name);
  return value === undefined ? fallback : numberArray(value, name);
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

const evaluateSampled = (entries: PdfDictionaryEntries, data: Uint8Array, limits: { domain: number[]; range: number[] }): PdfFunction => {
  // ISO 32000-1:2008, 7.10.2 and Table 39: samples are a high-bit-first continuous stream, with the first input varying fastest.
  const sizes = numberArray(get(entries, 'Size'), 'Size');
  const bits = numeric(get(entries, 'BitsPerSample'), 'BitsPerSample');
  const order = get(entries, 'Order') === undefined ? 1 : numeric(get(entries, 'Order'), 'Order');
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
    entries,
    'Encode',
    sizes.flatMap(size => [0, size - 1]),
  );
  const decode = optionalArray(entries, 'Decode', limits.range);
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

const evaluateExponential = (entries: PdfDictionaryEntries, domain: number[]): PdfFunction => {
  // ISO 32000-1:2008, 7.10.3 and Table 40.
  if (domain.length !== 2) throw new ParseError('exponential function needs one input', 0);
  const c0 = optionalArray(entries, 'C0', [0]);
  const c1 = optionalArray(entries, 'C1', [1]);
  const exponent = numeric(get(entries, 'N'), 'N');
  if (c0.length !== c1.length) throw new ParseError('exponential function output dimensions differ', 0);
  return input => c0.map((start, index) => start + clip(input[0] ?? 0, domain[0] ?? 0, domain[1] ?? 0) ** exponent * ((c1[index] ?? 0) - start));
};

const evaluateStitched = (
  entries: PdfDictionaryEntries,
  domain: number[],
  context: { resolve: FunctionResolver; recurse: (item: PdfObject) => PdfFunction },
): PdfFunction => {
  // ISO 32000-1:2008, 7.10.4 and Table 41: intervals are half-open except the last.
  const { resolve, recurse } = context;
  const functionsValue = get(entries, 'Functions');
  const functions = functionsValue?.kind === 'reference' ? resolve(functionsValue) : functionsValue;
  if (domain.length !== 2 || functions?.kind !== 'array' || functions.items.length === 0) throw new ParseError('invalid stitching function', 0);
  const bounds = resolvedNumberArray(get(entries, 'Bounds'), 'Bounds', resolve);
  const encode = resolvedNumberArray(get(entries, 'Encode'), 'Encode', resolve);
  if (bounds.length !== functions.items.length - 1 || encode.length !== functions.items.length * 2) throw new ParseError('invalid stitching intervals', 0);
  const subfunctions = functions.items.map(item => recurse(item.kind === 'reference' ? resolve(item) : item));
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

/** Parses and evaluates a direct PDF function object or a decoded function stream. */
export const createPdfFunction = (object: PdfObject, resolve: FunctionResolver = value => value, depth = 0): PdfFunction => {
  if (depth > 16) throw new ResourceLimitError('PDF function nesting exceeds 16');
  if (object.kind !== 'dictionary' && object.kind !== 'stream') throw new ParseError('PDF function must be a dictionary or stream', 0);
  const entries = object.kind === 'stream' ? object.dictionary : object.entries;
  const type = numeric(get(entries, 'FunctionType'), 'FunctionType');
  const domain = numberArray(get(entries, 'Domain'), 'Domain');
  const rangeValue = get(entries, 'Range');
  const range = rangeValue === undefined ? undefined : numberArray(rangeValue, 'Range');
  pairs(domain, 'Domain');
  if (range !== undefined) pairs(range, 'Range');
  const evaluate: PdfFunction = (() => {
    if (type === 0 && object.kind === 'stream' && range !== undefined) return evaluateSampled(entries, object.data, { domain, range });
    if (type === 2) return evaluateExponential(entries, domain);
    if (type === 3) return evaluateStitched(entries, domain, { resolve, recurse: item => createPdfFunction(item, resolve, depth + 1) });
    if (type === 4 && object.kind === 'stream' && range !== undefined) return createCalculatorFunction(object.data, domain.length / 2, range.length / 2);
    throw new UnsupportedFeatureError(`unsupported PDF function type ${String(type)}`);
  })();
  return input => {
    if (input.length !== domain.length / 2) throw new ParseError('PDF function input dimension mismatch', 0);
    const output = evaluate(input.map((value, index) => clip(value, domain[index * 2] ?? 0, domain[index * 2 + 1] ?? 0)));
    if (range === undefined) return output;
    if (output.length !== range.length / 2) throw new ParseError('PDF function output dimension mismatch', 0);
    return output.map((value, index) => clip(value, range[index * 2] ?? 0, range[index * 2 + 1] ?? 0));
  };
};

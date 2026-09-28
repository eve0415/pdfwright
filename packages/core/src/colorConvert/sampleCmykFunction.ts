import type { IccProfile } from '../icc/iccProfile.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { deltaE2000 } from '../color/deltaE2000.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName, pdfReal } from '../object/pdfObject.ts';

export interface SampledCmykFunction {
  readonly kind: 'sampled';
  readonly dictionary: PdfDictionaryEntries;
  readonly data: Uint8Array;
  readonly maxDeltaE2000: number;
}

export interface CmykFunctionConfig {
  readonly dimensions: number;
  readonly domain: readonly number[];
  readonly evaluate: (values: readonly number[]) => Float64Array;
  readonly destination: IccProfile;
  readonly grid?: number;
}

interface TintSamples {
  readonly grid: number;
  readonly values: Float64Array;
  readonly maxDeltaE2000: number;
}

const gridValues = (config: CmykFunctionConfig, grid: number): Float64Array => {
  const { dimensions, domain, evaluate } = config;
  const count = grid ** dimensions;
  if (!Number.isSafeInteger(count) || count > 100_000) throw new ResourceLimitError('colour function table exceeds the sampling limit');
  const values = new Float64Array(count * 4);
  for (let index = 0; index < count; index++) {
    const inputs: number[] = [];
    for (let axis = 0; axis < dimensions; axis++) {
      const fraction = (Math.floor(index / grid ** axis) % grid) / (grid - 1);
      inputs.push((domain[axis * 2] ?? 0) + fraction * ((domain[axis * 2 + 1] ?? 1) - (domain[axis * 2] ?? 0)));
    }
    values.set(evaluate(inputs), index * 4);
  }
  return values;
};

const midpointError = (config: CmykFunctionConfig, values: Float64Array, grid: number): number => {
  const { domain, evaluate, destination } = config;
  const toPcs = sourceEvaluator(destination, 'relativeColorimetric', 'icc');
  const lab = (cmyk: Float64Array): readonly number[] => {
    const pcs = toPcs(cmyk);
    return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
  };
  let maximum = 0;
  for (let index = 0; index < grid - 1; index++) {
    const input = (domain[0] ?? 0) + ((index + 0.5) / (grid - 1)) * ((domain[1] ?? 1) - (domain[0] ?? 0));
    const exact = evaluate([input]);
    const interpolated = Float64Array.from({ length: 4 }, (_, channel) => ((values[index * 4 + channel] ?? 0) + (values[(index + 1) * 4 + channel] ?? 0)) / 2);
    maximum = Math.max(maximum, deltaE2000(lab(exact), lab(interpolated)));
  }
  return maximum;
};

const samples = (config: CmykFunctionConfig): TintSamples => {
  if (config.dimensions > 1) {
    const grid = config.grid ?? 17;
    return { grid, values: gridValues(config, grid), maxDeltaE2000: 0 };
  }
  for (let grid = 256; ; grid *= 2) {
    const values = gridValues(config, grid);
    const maxDeltaE2000 = midpointError(config, values, grid);
    if (maxDeltaE2000 <= 0.1 || grid >= 4096) return { grid, values, maxDeltaE2000 };
  }
};

/** Writes a Type 0 CMYK function after measuring midpoint error for one-input functions. */
export const sampleCmykFunction = (config: CmykFunctionConfig): SampledCmykFunction => {
  const sampled = samples(config);
  const writer = new ByteWriter();
  for (const value of sampled.values) {
    const quantized = Math.round(value * 65535);
    writer.writeByte(Math.floor(quantized / 256));
    writer.writeByte(quantized % 256);
  }
  const dictionary = new PdfDictionaryEntries([
    // ISO 32000-1:2008, 7.10.2 Table 39: Size fixes each input grid and BitsPerSample is 16 here.
    [pdfName('FunctionType').bytes, pdfInteger(0)],
    [pdfName('Domain').bytes, pdfArray(config.domain.map(value => pdfReal(value)))],
    [pdfName('Range').bytes, pdfArray([0, 1, 0, 1, 0, 1, 0, 1].map(value => pdfInteger(value)))],
    [pdfName('Size').bytes, pdfArray(Array.from({ length: config.dimensions }, () => pdfInteger(sampled.grid)))],
    [pdfName('BitsPerSample').bytes, pdfInteger(16)],
    [pdfName('Order').bytes, pdfInteger(1)],
    [pdfName('Filter').bytes, pdfName('FlateDecode')],
  ]);
  return { kind: 'sampled', dictionary, data: deflateZlib(writer.toUint8Array()), maxDeltaE2000: sampled.maxDeltaE2000 };
};

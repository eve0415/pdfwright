import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text as streamText } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { parseIccProfile } from '../icc/iccProfile.ts';
import { gammaCurveTag, iccProfileBytes, matrixLutTag, xyzTag } from '../testing/iccProfileBytes.ts';

import { createColorTransform } from './createColorTransform.ts';

const execute = async (file: string, args: readonly string[], input: string): Promise<string> => {
  const child = spawn(file, [...args]);
  child.stdin.end(input);
  const [stdout, stderr, close] = await Promise.all([streamText(child.stdout), streamText(child.stderr), once(child, 'close')]);
  if (close[0] !== 0) throw new Error(`${file} exited with ${String(close[0])}: ${stderr}`);
  return stdout;
};

// transicc prints four decimals on its 0–255 scale, and both engines read the same s15Fixed16 profile values, so they agree far inside this limit.
const TOLERANCE = 1e-4;

// transicc reads and writes RGB and gray components on a 0–255 scale, one colour per line.
const transicc = async (source: Uint8Array, destination: Uint8Array, colors: readonly (readonly number[])[]): Promise<number[][]> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-transicc-'));
  try {
    const sourcePath = path.join(directory, 'source.icc');
    const destinationPath = path.join(directory, 'destination.icc');
    await writeFile(sourcePath, source);
    await writeFile(destinationPath, destination);
    const input = colors.map(color => color.map(value => (value * 255).toPrecision(17)).join(' ')).join('\n');
    const stdout = await execute('transicc', ['-n', `-i${sourcePath}`, `-o${destinationPath}`, '-t1', '-c0'], `${input}\n`);
    return stdout
      .trim()
      .split(/\r?\n/u)
      .map(line =>
        line
          .trim()
          .split(/\s+/u)
          .map(value => Number(value) / 255),
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const convert = (source: Uint8Array, destination: Uint8Array, colors: readonly (readonly number[])[]): number[][] => {
  const destinationProfile = parseIccProfile(destination);
  const transform = createColorTransform({ kind: 'icc', profile: parseIccProfile(source) }, destinationProfile, {
    intent: 'relativeColorimetric',
    blackPointCompensation: false,
  });
  return colors.map(color => {
    const output = new Float64Array(transform.outputChannels);
    transform.convert(Float64Array.from(color), output);
    return [...output];
  });
};

// The largest absolute component difference between two colour lists, or infinity when their shapes differ.
const largestDifference = (actual: readonly (readonly number[])[], expected: readonly (readonly number[])[]): number => {
  if (actual.length !== expected.length) return Number.POSITIVE_INFINITY;
  let largest = 0;
  for (const [index, row] of actual.entries()) {
    const reference = expected[index] ?? [];
    if (row.length !== reference.length) return Number.POSITIVE_INFINITY;
    for (const [channel, value] of row.entries()) largest = Math.max(largest, Math.abs(value - (reference[channel] ?? Number.NaN)));
  }
  return largest;
};

// Device RGB equals PCSXYZ in this matrix/TRC profile, so it serves as an XYZ reader and writer that both engines evaluate the same way.
const xyzRgb = iccProfileBytes({
  profileClass: 'mntr',
  colorSpace: 'RGB ',
  pcs: 'XYZ ',
  tags: [
    ['rXYZ', xyzTag([1, 0, 0])],
    ['gXYZ', xyzTag([0, 1, 0])],
    ['bXYZ', xyzTag([0, 0, 1])],
    ['rTRC', gammaCurveTag(1)],
    ['gTRC', gammaCurveTag(1)],
    ['bTRC', gammaCurveTag(1)],
  ],
});

const rgbColors = [
  [0.2, 0.3, 0.4],
  [0.9, 0.1, 0.5],
  [0.05, 0.7, 0.25],
  [1, 1, 1],
  [0, 0, 0],
];

describe('profile pipelines against LittleCMS transicc', () => {
  // Every coefficient differs and the offsets are non-zero, so any other reading of e1..e12 changes the result.
  const elements = [0.25, 0.1, 0.05, 0.03, 0.3, 0.08, 0.01, 0.06, 0.22, 0.02, 0.015, 0.03];

  it('applies a lutAToBType matrix as e1..e9 coefficients and e10..e12 offsets', async () => {
    const source = iccProfileBytes({ profileClass: 'scnr', colorSpace: 'RGB ', pcs: 'XYZ ', tags: [['A2B0', matrixLutTag('mAB ', elements)]] });
    expect(largestDifference(convert(source, xyzRgb, rgbColors), await transicc(source, xyzRgb, rgbColors))).toBeLessThan(TOLERANCE);
  });

  it('applies a lutBToAType matrix as e1..e9 coefficients and e10..e12 offsets', async () => {
    const destination = iccProfileBytes({ profileClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', tags: [['B2A0', matrixLutTag('mBA ', elements)]] });
    expect(largestDifference(convert(xyzRgb, destination, rgbColors), await transicc(xyzRgb, destination, rgbColors))).toBeLessThan(TOLERANCE);
  });
});

import type { NativeRecord } from './nativeTokenizer.ts';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { mm } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { tokenizeNative } from './nativeTokenizer.ts';
import { readIllustratorContainer } from './readIllustratorPdf.ts';

const exportsDirectory = env['PDFWRIGHT_ADOBE_EXPORTS_DIR'];
if (exportsDirectory === undefined) stdout.write('Local Illustrator structure comparison not run: PDFWRIGHT_ADOBE_EXPORTS_DIR is unset.\n');

const samples = [
  { file: 'A-illustrator/A1-ref-cmyk-pdf17.pdf', blocks: 8, lastLength: 1527, layers: 5, rasters: 6, widthMm: 100, heightMm: 70, paint: [211, 33, 1, 5, 31] },
  { file: 'A-illustrator/A1-ref-cmyk-pdf13.pdf', blocks: 8, lastLength: 1913, layers: 5, rasters: 6, widthMm: 100, heightMm: 70, paint: [211, 33, 1, 5, 31] },
  {
    file: 'A-illustrator/A3-resave-probe-ai-pdf17.pdf',
    blocks: 1,
    lastLength: 32539,
    layers: 1,
    rasters: 2,
    widthMm: 80,
    heightMm: 50,
    paint: [2, 3, 0, 5, 1],
  },
] as const;

const localSource = async (file: string): Promise<Uint8Array> => {
  if (exportsDirectory === undefined) throw new Error('PDFWRIGHT_ADOBE_EXPORTS_DIR is unset');
  return readFile(path.join(exportsDirectory, file));
};
const textLines = (records: readonly NativeRecord[]): string[] => records.flatMap(record => (record.kind === 'line' ? [record.text] : []));
const cropDeviation = (lines: readonly string[], widthMm: number, heightMm: number): number => {
  const crop = lines
    .find(line => line.startsWith('%AI3_Cropmarks: '))
    ?.slice('%AI3_Cropmarks: '.length)
    .split(' ')
    .map(Number);
  const width = mm(widthMm);
  const height = mm(heightMm);
  const expected = [0, 0, Number(width.numerator) / Number(width.denominator), Number(height.numerator) / Number(height.denominator)];
  return Math.max(...expected.map((value, index) => Math.abs(value - (crop?.[index] ?? Number.POSITIVE_INFINITY))));
};

describe('local Illustrator structure comparison', () => {
  it.skipIf(exportsDirectory === undefined).each(samples)('$file keeps the observed native container and layer framing', async sample => {
    const facts = readIllustratorContainer(await localSource(sample.file));
    const records = tokenizeNative(facts.native);
    const lines = textLines(records);
    expect([
      facts.containerVersion,
      facts.creatorVersion,
      facts.roundtripStreamType,
      facts.roundtripVersion,
      facts.frameHeaderDescriptor,
      facts.windowDescriptor,
    ]).toStrictEqual([9, 30, 2, 30, 0, 0x58]);
    expect(facts.blockLengths).toStrictEqual([...Array.from({ length: sample.blocks - 1 }, () => 65536), sample.lastLength]);
    expect(facts.pageDate).toStrictEqual(facts.applicationDate);
    expect([lines.filter(line => line === '%AI5_BeginLayer').length, records.filter(record => record.kind === 'rasterData').length]).toStrictEqual([
      sample.layers,
      sample.rasters,
    ]);
    expect(facts.native.slice(0, facts.metaData.length)).toStrictEqual(facts.metaData);
  });

  it.skipIf(exportsDirectory === undefined).each(samples)('$file keeps observed geometry and object grammar', async sample => {
    const facts = readIllustratorContainer(await localSource(sample.file));
    const lines = textLines(tokenizeNative(facts.native));
    expect(cropDeviation(lines, sample.widthMm, sample.heightMm)).toBeLessThan(1e-4);
    expect([
      lines.filter(line => line === 'f').length,
      lines.filter(line => line === 's').length,
      lines.filter(line => line === 'b').length,
      lines.filter(line => line === 'q').length,
      lines.filter(line => line === 'u').length,
    ]).toStrictEqual(sample.paint);
    expect(lines.filter(line => line === 'q')).toHaveLength(lines.filter(line => line === 'Q').length);
    expect(lines.filter(line => line === 'u')).toHaveLength(lines.filter(line => line === 'U').length);
  });
});

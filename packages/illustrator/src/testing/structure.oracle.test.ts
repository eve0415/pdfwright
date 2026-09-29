import type { IllustratorDocument, PathItem } from '../model/illustratorDocument.ts';
import type { NativeRecord } from '../read/nativeTokenizer.ts';
import type { ContainerFacts } from './readIllustratorPdf.ts';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { mm, pdfDate } from '@pdfwright/core';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { readIllustratorExportManifest } from '../../../../scripts/illustratorExports.ts';
import { readIllustratorPdf as readPublicIllustratorPdf } from '../index.ts';
import { tokenizeNative } from '../read/nativeTokenizer.ts';
import { writeIllustratorPdf } from '../writeIllustratorPdf.ts';

import { normalizeModel } from './normalizeModel.ts';
import { readIllustratorContainer, readIllustratorPdf } from './readIllustratorPdf.ts';

const exportsDirectory = env['PDFWRIGHT_ADOBE_EXPORTS_DIR'];
if (exportsDirectory === undefined) stdout.write('Local Illustrator structure comparison not run: PDFWRIGHT_ADOBE_EXPORTS_DIR is unset.\n');

const manifest = exportsDirectory === undefined ? undefined : await readIllustratorExportManifest(exportsDirectory);
const samples = manifest?.samples ?? [];
const lockSample = manifest?.lockSample ?? '';

const localSource = async (file: string): Promise<Uint8Array> => {
  if (exportsDirectory === undefined) throw new Error('PDFWRIGHT_ADOBE_EXPORTS_DIR is unset');
  return readFile(path.join(exportsDirectory, file));
};
const textLines = (records: readonly NativeRecord[]): string[] => records.flatMap(record => (record.kind === 'line' ? [record.text] : []));
const stableKeys = (facts: ContainerFacts): string[] => facts.privateKeys.filter(name => !/^AIPDFPrivateData\d+$/u.test(name));
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

const lockFields = (lines: readonly string[]): Map<string, { readonly layer: string; readonly state: readonly string[] }> => {
  const fields = new Map<string, { readonly layer: string; readonly state: readonly string[] }>();
  const starts = lines.flatMap((line, index) => (line === '%AI5_BeginLayer' ? [index] : []));
  for (const start of starts) {
    const end = lines.findIndex((line, index) => index > start && (line === '%AI5_BeginLayer' || line === '%AI5_EndLayer--'));
    const lb = lines[start + 1]?.split(' ');
    const name = lines[start + 2];
    if (end === -1 || lb?.[14] !== 'Lb' || name === undefined || !name.endsWith(') Ln')) throw new Error('invalid native layer lock structure');
    const beforeItem = lines.slice(start + 3, end);
    const itemIndex = beforeItem.findIndex(line => /^\d+ As$/u.test(line));
    const state = (itemIndex === -1 ? beforeItem : beforeItem.slice(0, itemIndex)).filter(line => /^[01] (?:A|Xw)$/u.test(line));
    fields.set(name.slice(1, -4), { layer: [lb[0], lb[2], lb[6]].join(' '), state });
  }
  return fields;
};

const rectangle: PathItem = {
  kind: 'path',
  geometry: {
    subpaths: [
      {
        start: [0, 0],
        segments: [
          { kind: 'line', to: [10, 0] },
          { kind: 'line', to: [10, 10] },
          { kind: 'line', to: [0, 10] },
        ],
      },
    ],
  },
  fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
};
const lockedModel: IllustratorDocument = {
  artboard: { width: mm(100), height: mm(70), bleed: mm(3) },
  layers: [
    { name: 'Unlocked', items: [rectangle] },
    { name: 'Sublayer parent', items: [] },
    { name: 'Locked and hidden', locked: true, visible: false, items: [rectangle] },
    { name: 'Locked object', items: [{ ...rectangle, locked: true }] },
    { name: 'Locked layer', locked: true, items: [rectangle] },
  ],
  lastModified: pdfDate({ year: 2026, month: 9, day: 29, hour: 0, minute: 0, second: 0, offset: 'Z' }),
};

describe('local Illustrator structure comparison', () => {
  it.skipIf(lockSample === '')('matches Illustrator layer and object lock fields', async () => {
    const observedContainer = readIllustratorContainer(await localSource(lockSample));
    const writtenContainer = readIllustratorContainer(writeIllustratorPdf(lockedModel));
    const observed = textLines(tokenizeNative(observedContainer.native));
    const written = textLines(tokenizeNative(writtenContainer.native));
    const sourceFields = lockFields(observed);
    const writtenFields = lockFields(written);
    for (const [name, fields] of writtenFields) expect(fields).toStrictEqual(sourceFields.get(name));
    expect(sourceFields.get('Locked sublayer')).toMatchObject({ layer: '1 0 1', state: ['1 A', '0 Xw', '0 A'] });
    expect(observed.find(line => line.startsWith('%AI5_OpenViewLayers: '))).toBe('%AI5_OpenViewLayers: 37277');
    expect(written.find(line => line.startsWith('%AI5_OpenViewLayers: '))).toBe('%AI5_OpenViewLayers: 37277');
  });

  it.skipIf(exportsDirectory === undefined)('selects local structure samples', () => {
    expect(samples.length).toBeGreaterThan(0);
  });

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
    expect(facts.native.slice(0, facts.metaData?.length)).toStrictEqual(facts.metaData);
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

  it.skipIf(exportsDirectory === undefined).each(samples)('$file restores its native layers through the reader', async sample => {
    const read = readIllustratorPdf(await localSource(sample.file));
    expect(read.document.layers).toHaveLength(sample.layers);
    expect(read.unknownBlocks.length).toBeGreaterThan(0);
  });

  it.skipIf(exportsDirectory === undefined).each(samples)('$file reads through the public reader', async sample => {
    const bytes = await localSource(sample.file);
    const read = readPublicIllustratorPdf(bytes, { zstandard: decompress });
    expect(read.document).toStrictEqual(readIllustratorPdf(bytes).document);
    expect(read.nativeOrigin).toBe('artboard-bottom-left');
    expect(read.compression).toStrictEqual({ kind: 'zstandard', frameHeaderDescriptor: 0, windowDescriptor: 0x58 });
    expect(read.blockLengths).toStrictEqual([...Array.from({ length: sample.blocks - 1 }, () => 65536), sample.lastLength]);
    expect(read.lastModified.page).toStrictEqual(read.lastModified.application);
  });

  it.skipIf(exportsDirectory === undefined).each(samples)('$file rewrites its recovered artwork with the same structure', async sample => {
    const observed = readIllustratorPdf(await localSource(sample.file));
    const reproduced = readIllustratorPdf(writeIllustratorPdf(observed.document));
    expect(reproduced.document).toStrictEqual(normalizeModel(observed.document));
    expect(stableKeys(reproduced)).toStrictEqual(stableKeys(observed));
    expect([reproduced.containerVersion, reproduced.creatorVersion, reproduced.roundtripStreamType, reproduced.roundtripVersion]).toStrictEqual([9, 30, 2, 30]);
    expect([reproduced.frameHeaderDescriptor, reproduced.windowDescriptor]).toStrictEqual([observed.frameHeaderDescriptor, observed.windowDescriptor]);
    expect(reproduced.pageDate).toStrictEqual(reproduced.applicationDate);
  });
});

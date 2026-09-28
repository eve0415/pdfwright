import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text as streamText } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { samples } from '../../../../tests/fixtures/icc/samples.ts';
import { createColorTransform } from '../color/createColorTransform.ts';

import { parseIccProfile } from './iccProfile.ts';

const fixturePath = (name: string): string => fileURLToPath(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url));

const intentName = (value: number): 'perceptual' | 'relativeColorimetric' | 'saturation' | 'absoluteColorimetric' => {
  if (value === 0) return 'perceptual';
  if (value === 1) return 'relativeColorimetric';
  if (value === 2) return 'saturation';
  return 'absoluteColorimetric';
};

const execute = async (file: string, args: readonly string[], input = ''): Promise<string> => {
  const child = spawn(file, [...args]);
  child.stdin.end(input);
  const [stdout, stderr, close] = await Promise.all([streamText(child.stdout), streamText(child.stderr), once(child, 'close')]);
  if (close[0] !== 0) throw new Error(`${file} exited with ${String(close[0])}: ${stderr}`);
  return stdout;
};

const runOracle = async (config: {
  source: string;
  destination: string;
  intent: number;
  bpc: number;
  rows: readonly string[];
  reference?: 'input';
}): Promise<number[]> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-lcms-'));
  try {
    const executable = path.join(directory, 'lcmsOracle');
    const input = path.join(directory, 'samples.txt');
    await writeFile(input, `${config.rows.join('\n')}\n`);
    await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', fixturePath('lcmsOracle.c'), '-llcms2', '-lm', '-o', executable]);
    const args = [fixturePath(config.source), fixturePath(config.destination), String(config.intent), String(config.bpc), input];
    if (config.reference === 'input') args.push('input');
    const stdout = await execute(executable, args);
    return stdout.trim().split(/\s+/u).map(Number);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const argyllRows = (output: string): number[][] =>
  output
    .trim()
    .split(/\r?\n/u)
    .map(line => {
      const values = line.trim().split(/\s+/u).map(Number);
      if (values.length !== 4 || values.some(value => !Number.isFinite(value))) throw new Error('ArgyllCMS returned invalid CMYK values');
      return values;
    });

const referenceAt = (rows: readonly number[][], index: number): readonly number[] => {
  const row = rows[index];
  if (row === undefined) throw new Error('ArgyllCMS returned fewer colours than requested');
  return row;
};

// CIEDE2000 compares 6,189 RGB samples: a 17³ grid, 256 greys, 20 near-edge colours and 1,000 seeded colours. The 0.05 maximum and 0.005 mean ΔE2000 limits allow rounding in independent double-precision transforms while keeping differences below visible print variation.
const cases = ['sRGB.icm', 'sRGB-v4.icc', 'DisplayP3-v4.icc', 'Rec2020-v4.icc', 'ProPhoto-v4.icc'].flatMap(source =>
  ['fogra28l.icc', 'fogra28l-v4.icc', 'synthetic-cmyk.icc'].flatMap(destination =>
    [0, 1, 2, 3].flatMap(intent => [0, 1].map(bpc => ({ source, destination, intent, bpc }))),
  ),
);

describe('littlecms ΔE2000 over 6,189 RGB samples', () => {
  it('agrees with transicc on a printed RGB black sample', async () => {
    const output = await execute('transicc', ['-n', `-i${fixturePath('sRGB.icm')}`, `-o${fixturePath('fogra28l.icc')}`, '-t1', '-c0'], '0 0 0\n');
    expect(output.trim()).toBe('99.9863 62.8260 37.1252 100.0000');
  });

  it.each(cases.filter(item => item.intent !== 3))('maps $source paper white to exact no ink in $destination intent $intent bpc $bpc', async item => {
    const source = parseIccProfile(await readFile(fixturePath(item.source)));
    const destination = parseIccProfile(await readFile(fixturePath(item.destination)));
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, {
      intent: intentName(item.intent),
      blackPointCompensation: item.bpc === 1,
    });
    const output = new Float64Array(4);
    transform.convert(Float64Array.of(1, 1, 1), output);
    expect([...output]).toStrictEqual([0, 0, 0, 0]);
  });

  it.each(cases)(
    '$source → $destination intent $intent bpc $bpc',
    async ({ source, destination, intent, bpc }) => {
      const rgb = parseIccProfile(await readFile(fixturePath(source)));
      const cmyk = parseIccProfile(await readFile(fixturePath(destination)));
      const renderingIntent = intentName(intent);
      const transform = createColorTransform({ kind: 'icc', profile: rgb }, cmyk, { intent: renderingIntent, blackPointCompensation: bpc === 1 });
      const output = new Float64Array(4);
      const rows = samples().map(([red, green, blue]) => {
        transform.convert(Float64Array.of(red / 255, green / 255, blue / 255), output);
        return [red / 255, green / 255, blue / 255, ...output.map(value => value * 100)].map(value => value.toPrecision(17)).join(' ');
      });
      const [count, maximum, mean, channelMaximum] = await runOracle({ source, destination, intent, bpc, rows });
      process.stdout.write(
        `${source} ${destination} intent=${String(intent)} bpc=${String(bpc)} n=${String(count)} max=${String(maximum)} mean=${String(mean)} channel=${String(channelMaximum)}\n`,
      );
      expect(count).toBe(6189);
      expect(maximum).toBeLessThanOrEqual(0.05);
      expect(mean).toBeLessThanOrEqual(0.005);
      expect(channelMaximum).toBeLessThanOrEqual(0.5);
    },
    60_000,
  );
});

describe('argyllcms independent conversion comparison', () => {
  it.each([
    { name: 'relative', intent: 1, flag: 'r' },
    { name: 'perceptual', intent: 0, flag: 'p' },
  ])(
    '$name intent',
    async ({ intent, flag }) => {
      const source = 'sRGB.icm';
      const destination = 'fogra28l.icc';
      const colors = samples();
      const rgbInput = colors
        .map(([red, green, blue]) => `${(red / 255).toPrecision(17)} ${(green / 255).toPrecision(17)} ${(blue / 255).toPrecision(17)}`)
        .join('\n');
      const labOutput = await execute('xicclu', ['-v0', '-ff', `-i${flag}`, '-pl', fixturePath(source)], `${rgbInput}\n`);
      const deviceOutput = await execute('xicclu', ['-v0', '-fb', `-i${flag}`, '-pl', fixturePath(destination)], labOutput);
      const reference = argyllRows(deviceOutput);
      const rgb = parseIccProfile(await readFile(fixturePath(source)));
      const cmyk = parseIccProfile(await readFile(fixturePath(destination)));
      const transform = createColorTransform({ kind: 'icc', profile: rgb }, cmyk, { intent: intentName(intent), blackPointCompensation: false });
      const output = new Float64Array(4);
      const rows = colors.map(([red, green, blue], index) => {
        transform.convert(Float64Array.of(red / 255, green / 255, blue / 255), output);
        const values = [red / 255, green / 255, blue / 255, ...output.map(value => value * 100), ...referenceAt(reference, index).map(value => value * 100)];
        return values.map(value => value.toPrecision(17)).join(' ');
      });
      const [count, maximum, mean, channelMaximum] = await runOracle({ source, destination, intent, bpc: 0, rows, reference: 'input' });
      process.stdout.write(
        `argyllcms intent=${String(intent)} n=${String(count)} max=${String(maximum)} mean=${String(mean)} channel=${String(channelMaximum)}\n`,
      );
      expect(count).toBe(6189);
      expect(maximum).toBeLessThanOrEqual(0.05);
      expect(mean).toBeLessThanOrEqual(0.005);
      expect(channelMaximum).toBeLessThanOrEqual(0.5);
    },
    60_000,
  );
});

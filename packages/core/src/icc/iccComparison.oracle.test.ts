import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text as streamText } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';

import { parseIccProfile } from './iccProfile.ts';

type Rgb = readonly [number, number, number];

const fixturePath = (name: string): string => fileURLToPath(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url));
const xor64 = (left: bigint, right: bigint): bigint => {
  let a = left;
  let b = right;
  let result = 0n;
  let place = 1n;
  for (let index = 0; index < 64; index++) {
    if (a % 2n !== b % 2n) result += place;
    a /= 2n;
    b /= 2n;
    place *= 2n;
  }
  return result;
};

const samples = (): Rgb[] => {
  const result: Rgb[] = [];
  for (let red = 0; red < 17; red++) {
    for (let green = 0; green < 17; green++) {
      for (let blue = 0; blue < 17; blue++) result.push([Math.round((red * 255) / 16), Math.round((green * 255) / 16), Math.round((blue * 255) / 16)]);
    }
  }
  for (let value = 0; value < 256; value++) result.push([value, value, value]);
  result.push(
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
    [2, 2, 2],
    [254, 0, 0],
    [0, 254, 0],
    [0, 0, 254],
    [255, 1, 1],
    [1, 255, 1],
    [1, 1, 255],
    [254, 254, 254],
    [255, 255, 254],
    [254, 255, 255],
    [255, 254, 255],
    [0, 0, 1],
    [1, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [0, 0, 128],
  );
  let state = 0x9e3779b97f4a7c15n;
  const modulus = 2n ** 64n;
  for (let sample = 0; sample < 1000; sample++) {
    const rgb: number[] = [];
    for (let channel = 0; channel < 3; channel++) {
      state = xor64(state, (state * 2n ** 13n) % modulus);
      state = xor64(state, state / 2n ** 7n);
      state = xor64(state, (state * 2n ** 17n) % modulus);
      rgb.push(Number(state % 256n));
    }
    result.push([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]);
  }
  return result;
};

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

const runOracle = async (config: { source: string; destination: string; intent: number; bpc: number; rows: readonly string[] }): Promise<number[]> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-lcms-'));
  try {
    const executable = path.join(directory, 'lcmsOracle');
    const input = path.join(directory, 'samples.txt');
    await writeFile(input, `${config.rows.join('\n')}\n`);
    await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', fixturePath('lcmsOracle.c'), '-llcms2', '-lm', '-o', executable]);
    const stdout = await execute(executable, [fixturePath(config.source), fixturePath(config.destination), String(config.intent), String(config.bpc), input]);
    return stdout.trim().split(/\s+/u).map(Number);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const cases = ['sRGB.icm', 'sRGB-v4.icc', 'DisplayP3-v4.icc', 'Rec2020-v4.icc', 'ProPhoto-v4.icc'].flatMap(source =>
  ['fogra28l.icc', 'fogra28l-v4.icc'].flatMap(destination => [0, 1, 2, 3].flatMap(intent => [0, 1].map(bpc => ({ source, destination, intent, bpc })))),
);

describe('littlecms double transform comparison', () => {
  it('agrees with transicc on a printed RGB black sample', async () => {
    const output = await execute('transicc', ['-n', `-i${fixturePath('sRGB.icm')}`, `-o${fixturePath('fogra28l.icc')}`, '-t1', '-c0'], '0 0 0\n');
    expect(output.trim()).toBe('99.9863 62.8260 37.1252 100.0000');
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

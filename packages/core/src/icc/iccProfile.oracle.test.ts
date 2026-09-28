import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';

import { parseIccProfile } from './iccProfile.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));

describe('committed ICC fixtures', () => {
  it.each(['fogra28l.icc', 'fogra28l-v4.icc', 'synthetic-cmyk.icc', 'sRGB.icm', 'sRGB-v4.icc', 'DisplayP3-v4.icc'])(
    'parses %s and keeps its profile bytes',
    async name => {
      const bytes = await fixture(name);
      const profile = parseIccProfile(bytes);
      expect(profile.bytes).toStrictEqual(bytes);
      expect(profile.identity).toHaveLength(16);
    },
  );
});

describe('icc transform smoke oracle', () => {
  it('matches LittleCMS CMYK values for v2 and v4 destination tables', async () => {
    const source = parseIccProfile(await fixture('sRGB.icm'));
    const sourceV4 = parseIccProfile(await fixture('sRGB-v4.icc'));
    const destination = parseIccProfile(await fixture('fogra28l.icc'));
    const destinationV4 = parseIccProfile(await fixture('fogra28l-v4.icc'));
    const cases = [
      { source, destination, rgb: [0, 0, 0], cmyk: [99.986267, 62.825972, 37.1252, 100] },
      { source, destination, rgb: [128, 128, 128], cmyk: [14.896, 11.913, 13.776, 53.33] },
      { source: sourceV4, destination: destinationV4, rgb: [0, 0, 0], cmyk: [96.334785, 59.949642, 37.677577, 99.810791] },
      { source: sourceV4, destination: destinationV4, rgb: [128, 128, 128], cmyk: [15.994507, 12.813, 14.694437, 52.426946] },
    ];
    for (const item of cases) {
      const transform = createColorTransform({ kind: 'icc', profile: item.source }, item.destination, {
        intent: 'relativeColorimetric',
        blackPointCompensation: false,
      });
      const output = new Float64Array(4);
      transform.convert(
        Float64Array.from(item.rgb, value => value / 255),
        output,
      );
      for (let channel = 0; channel < 4; channel++) expect(Math.abs(Number(output[channel]) * 100 - Number(item.cmyk[channel]))).toBeLessThan(0.5);
    }
  });
});

const localDirectory = env['PDFWRIGHT_TEST_ICC_PROFILE_DIR'];
if (localDirectory === undefined) stdout.write('Local ICC profiles not run: PDFWRIGHT_TEST_ICC_PROFILE_DIR is unset.\n');

const localProfiles = async (): Promise<Uint8Array[]> => {
  if (localDirectory === undefined) return [];
  const entries = await readdir(localDirectory);
  const names = entries.filter(name => /\.(?:icc|icm)$/iu.test(name));
  return Promise.all(names.map(async name => Uint8Array.from(await readFile(path.join(localDirectory, name)))));
};

describe('local ICC profiles', () => {
  it.skipIf(localDirectory === undefined)('not run when PDFWRIGHT_TEST_ICC_PROFILE_DIR is unset', async () => {
    const files = await localProfiles();
    expect(files.length).toBeGreaterThan(0);
    for (const bytes of files) {
      const profile = parseIccProfile(bytes);
      expect(profile.identity).toHaveLength(16);
    }
  });
});

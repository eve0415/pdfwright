import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';

import { parseIccProfile } from './iccProfile.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));

describe('committed ICC fixtures', () => {
  it.each(['fogra28l.icc', 'fogra28l-v4.icc', 'synthetic-cmyk.icc', 'sRGB.icm', 'sRGB-v4.icc', 'DisplayP3-v4.icc', 'Rec2020-v4.icc', 'ProPhoto-v4.icc'])(
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

const localFile = async (name: string): Promise<Uint8Array> => Uint8Array.from(await readFile(path.join(localDirectory ?? '', name)));

const oracleRows = (text: string): number[][] =>
  text
    .trim()
    .split(/\r?\n/u)
    .map(line => {
      const values = line.trim().split(/\s+/u).map(Number);
      if (values.length !== 7 || values.some(value => !Number.isFinite(value))) throw new Error('Acrobat oracle rows need RGB bytes and four CMYK percentages');
      return values;
    });

describe('local ICC profiles', () => {
  it.skipIf(localDirectory === undefined)('not run when PDFWRIGHT_TEST_ICC_PROFILE_DIR is unset', async () => {
    const files = await localProfiles();
    expect(files.length).toBeGreaterThan(0);
    for (const bytes of files) {
      const profile = parseIccProfile(bytes);
      expect(profile.identity).toHaveLength(16);
    }
  });

  it.skipIf(localDirectory === undefined)('acrobat lut8 Lab oracle not run when PDFWRIGHT_TEST_ICC_PROFILE_DIR is unset', async () => {
    const source = parseIccProfile(await fixture('sRGB.icm'));
    const destination = parseIccProfile(await localFile('acrobat-lut8-destination.icc'));
    const expected = oracleRows(new TextDecoder().decode(await localFile('acrobat-lut8-expected.tsv')));
    const standard = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: false });
    const alternate = createColorTransform({ kind: 'icc', profile: source }, destination, {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
      lut8LabEncoding: 'adobe',
    });
    const standardOutput = new Float64Array(4);
    const alternateOutput = new Float64Array(4);
    let standardError = 0;
    let alternateError = 0;
    for (const row of expected) {
      const input = Float64Array.of(Number(row[0]) / 255, Number(row[1]) / 255, Number(row[2]) / 255);
      standard.convert(input, standardOutput);
      alternate.convert(input, alternateOutput);
      for (let channel = 0; channel < 4; channel++) {
        standardError += Math.abs(Number(standardOutput[channel]) * 100 - Number(row[channel + 3]));
        alternateError += Math.abs(Number(alternateOutput[channel]) * 100 - Number(row[channel + 3]));
      }
    }
    expect(expected.length).toBeGreaterThan(0);
    expect(alternateError).toBeLessThan(standardError);
  });
});

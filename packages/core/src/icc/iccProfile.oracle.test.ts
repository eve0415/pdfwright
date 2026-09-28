import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { describe, expect, it } from 'vitest';

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

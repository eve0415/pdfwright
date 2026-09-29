import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readIllustratorExportManifest } from './illustratorExports.ts';

describe('local Illustrator export manifest', () => {
  it('discovers samples and the ladder source from the selected directory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-exports-'));
    try {
      await writeFile(
        path.join(directory, 'illustrator-samples.json'),
        JSON.stringify({
          samples: [{ file: 'sample.pdf', blocks: 1, lastLength: 12, layers: 1, rasters: 0, widthMm: 10, heightMm: 20, paint: [1, 0, 0, 0, 0] }],
          ladderSample: 0,
          acceptance: [{ label: 'sample', file: 'sample.pdf' }],
        }),
      );
      const manifest = await readIllustratorExportManifest(directory);
      expect(manifest.samples).toHaveLength(1);
      expect(manifest.samples[0]?.file).toBe('sample.pdf');
      expect(manifest.samples[manifest.ladderSample]?.file).toBe('sample.pdf');
      expect(manifest.acceptance).toStrictEqual([{ label: 'sample', file: 'sample.pdf' }]);
      await writeFile(
        path.join(directory, 'illustrator-samples.json'),
        JSON.stringify({
          samples: [{ file: '../outside.pdf', blocks: 1, lastLength: 12, layers: 1, rasters: 0, widthMm: 10, heightMm: 20, paint: [1, 0, 0, 0, 0] }],
          ladderSample: 0,
          acceptance: [],
        }),
      );
      await expect(readIllustratorExportManifest(directory)).rejects.toThrow('inside the selected directory');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

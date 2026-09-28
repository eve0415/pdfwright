import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { describe, expect, it } from 'vitest';

import { readIllustratorContainer } from '../packages/illustrator/src/testing/readIllustratorPdf.ts';

import { readIllustratorExportManifest } from './illustratorExports.ts';
import { writeDiagnosticLadder, writeManualCheckSet } from './writeIllustratorManualCheckSet.ts';

const exportsDirectory = env['PDFWRIGHT_ADOBE_EXPORTS_DIR'];
if (exportsDirectory === undefined) stdout.write('Local Illustrator transplant ladder not run: PDFWRIGHT_ADOBE_EXPORTS_DIR is unset.\n');
const manifest = exportsDirectory === undefined ? undefined : await readIllustratorExportManifest(exportsDirectory);
const ladderSource = manifest?.samples[manifest.ladderSample]?.file ?? '';

describe('illustrator manual-check file set', () => {
  it('writes the PDFs and a checklist outside the repository', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-manual-'));
    try {
      const files = await writeManualCheckSet(directory);
      expect(files).toStrictEqual(['01-standard.pdf', '02-content-size.pdf', '04-raw-blocks.pdf', '05-top-left.pdf', '06-unequal-dates.pdf']);
      await expect(readdir(directory)).resolves.toStrictEqual([...files, 'CHECKLIST.md']);
      const standard = await readFile(path.join(directory, '01-standard.pdf'));
      expect(new TextDecoder().decode(standard.subarray(0, 8))).toBe('%PDF-1.7');
      const checklist = await readFile(path.join(directory, 'CHECKLIST.md'), 'utf8');
      expect(checklist).toContain('01-standard.pdf');
      expect(checklist).toContain('06-unequal-dates.pdf');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps identical native artwork across compression variants', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-manual-'));
    try {
      await writeManualCheckSet(directory);
      const standard = readIllustratorContainer(await readFile(path.join(directory, '01-standard.pdf')));
      const variants = await Promise.all(
        ['02-content-size.pdf', '04-raw-blocks.pdf'].map(async filename => readIllustratorContainer(await readFile(path.join(directory, filename)))),
      );
      for (const variant of variants) {
        expect(variant.native).toStrictEqual(standard.native);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(exportsDirectory === undefined)('writes diagnostic transplants to an external directory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-ladder-'));
    try {
      const files = await writeDiagnosticLadder(directory, ladderSource);
      expect(files).toHaveLength(9);
      await expect(readdir(directory)).resolves.toContain('diagnostic-09-indirect-dictionary.pdf');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

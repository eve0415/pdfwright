import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { describe, expect, it } from 'vitest';

import { readIllustratorContainer, readIllustratorPdf } from '../packages/illustrator/src/testing/readIllustratorPdf.ts';

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
      expect(files).toStrictEqual([
        '01-standard.pdf',
        '02-content-size.pdf',
        '04-raw-blocks.pdf',
        '05-top-left.pdf',
        '06-unequal-dates.pdf',
        '07-locked.pdf',
        '08-compound.pdf',
      ]);
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

  it('writes the locked variant and its reopen checks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-manual-'));
    try {
      await writeManualCheckSet(directory);
      const locked = readIllustratorPdf(await readFile(path.join(directory, '07-locked.pdf')));
      expect(locked.document.layers.slice(-3)).toMatchObject([
        { name: 'Locked layer', locked: true },
        { name: 'Locked object', locked: false, items: [{ locked: true }] },
        { name: 'Locked and hidden', locked: true, visible: false },
      ]);
      const checklist = await readFile(path.join(directory, 'CHECKLIST.md'), 'utf8');
      expect(checklist).toContain('07-locked.pdf');
      expect(checklist).toContain('Reopen the PDF and check that all three locks survive.');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes the compound-path variant and its fill-rule checks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-manual-'));
    try {
      await writeManualCheckSet(directory);
      const compound = readIllustratorPdf(await readFile(path.join(directory, '08-compound.pdf')));
      expect(compound.document.layers).toMatchObject([
        { name: 'Even-odd clip', items: [{ kind: 'clipGroup', clip: { fillRule: 'evenodd' } }] },
        { name: 'Compound fills', items: [{ geometry: { fillRule: 'nonzero' } }, { geometry: { fillRule: 'evenodd' } }] },
        { name: 'Compound die', items: [{ kind: 'path', geometry: { fillRule: 'nonzero' } }] },
      ]);
      const checklist = await readFile(path.join(directory, 'CHECKLIST.md'), 'utf8');
      expect(checklist).toContain('08-compound.pdf');
      expect(checklist).toContain('Record the fill rule the Attributes panel shows');
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

  it('includes the artboard view in every retained file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-manual-'));
    try {
      const names = await writeManualCheckSet(directory);
      const native = await Promise.all(
        names.map(async name => {
          const bytes = await readFile(path.join(directory, name));
          const container = readIllustratorContainer(bytes);
          return new TextDecoder('latin1').decode(container.native);
        }),
      );
      for (const text of native) {
        expect(text).toContain('%AI9_OpenToView:');
        expect(text).toContain('%AI5_BeginRaster');
      }
      const checklist = await readFile(path.join(directory, 'CHECKLIST.md'), 'utf8');
      expect(checklist).toContain('Every file must open with the artboard in view.');
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

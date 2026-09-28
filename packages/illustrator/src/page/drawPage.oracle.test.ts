import type { Fill, IllustratorDocument, PathItem, SpotColor } from '../model/illustratorDocument.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { readPlate, renderPlates } from '../../../../scripts/plateOracle.ts';
import { writeIllustratorPdf } from '../writeIllustratorPdf.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const white: SpotColor = { name: 'White', alternate: [0, 0, 0, 0.1] };
const primer: SpotColor = { name: 'Primer', alternate: [0, 0, 0, 0.2] };
const rectangle = (left: number, bottom: number, paint: Fill): PathItem => ({
  kind: 'path',
  geometry: {
    start: [left, bottom],
    segments: [
      { kind: 'line', to: [left + 6, bottom] },
      { kind: 'line', to: [left + 6, bottom + 6] },
      { kind: 'line', to: [left, bottom + 6] },
    ],
  },
  fill: paint,
});

const model: IllustratorDocument = {
  artboard: { width: 20, height: 20 },
  lastModified: date,
  layers: [
    { name: 'White', items: [rectangle(2, 2, { paint: { kind: 'spot', spot: white } })] },
    {
      name: 'Primer',
      opacity: 0.3,
      items: [{ kind: 'group', opacity: 0.5, isolated: true, items: [rectangle(10, 2, { paint: { kind: 'spot', spot: primer } })] }],
    },
    { name: 'Design', items: [rectangle(2, 10, { paint: { kind: 'process', cmyk: [1, 0, 0, 0] } })] },
  ],
};

const checkQpdf = async (file: string): Promise<number> => {
  const child = spawn('qpdf', ['--check', file]);
  await once(child, 'close');
  return child.exitCode ?? -1;
};

describe('visible-page render oracle', () => {
  it('matches independently composed spot and process pixels', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-page-'));
    try {
      const file = path.join(directory, 'page.pdf');
      await writeFile(file, writeIllustratorPdf(model));
      const files = await renderPlates(file, path.join(directory, 'plates'), true);
      const whitePlate = await readPlate(files, new TextEncoder().encode('White'));
      const primerPlate = await readPlate(files, new TextEncoder().encode('Primer'));
      const cyanPlate = await readPlate(files, new TextEncoder().encode('Cyan'));
      await expect(checkQpdf(file)).resolves.toBe(0);
      expect(whitePlate.inkAt(5, 14)).toBeGreaterThan(253);
      expect(Math.abs(primerPlate.inkAt(13, 14) - 38)).toBeLessThanOrEqual(2);
      expect(cyanPlate.inkAt(5, 6)).toBeGreaterThan(253);
      expect([whitePlate.inkAt(18, 18), primerPlate.inkAt(18, 18), cyanPlate.inkAt(18, 18)]).toStrictEqual([0, 0, 0]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

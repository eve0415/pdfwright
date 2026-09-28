import type { Plate } from '../../../../scripts/plateOracle.ts';
import type { Fill, IllustratorDocument, PathItem, SpotColor } from '../model/illustratorDocument.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadDocument, pdfDate } from '@pdfwright/core';
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

const renderedInk = (plate: Plate, [minX, minY, maxX, maxY]: readonly [number, number, number, number]) => {
  let ink = 0;
  let escaped = 0;
  for (let y = 0; y < plate.height; y++) {
    for (let x = 0; x < plate.width; x++) {
      if (plate.inkAt(x, y) < 128) continue;
      ink++;
      if (x + 1 < minX || x > maxX || plate.height - y < minY || plate.height - y - 1 > maxY) escaped++;
    }
  }
  return { ink, escaped };
};

describe('visible-page render oracle', () => {
  it('keeps a rendered mitered triangle within its written ArtBox', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-miter-'));
    try {
      const file = path.join(directory, 'triangle.pdf');
      const triangle: IllustratorDocument = {
        artboard: { width: 120, height: 100 },
        lastModified: date,
        layers: [
          {
            name: 'Triangle',
            items: [
              {
                kind: 'path',
                geometry: {
                  start: [10, 10],
                  segments: [
                    { kind: 'line', to: [60, 60] },
                    { kind: 'line', to: [110, 10] },
                  ],
                },
                stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 10 },
              },
            ],
          },
        ],
      };
      const bytes = writeIllustratorPdf(triangle);
      await writeFile(file, bytes);
      const artBox = loadDocument(bytes).page(0).boxes().ArtBox.rect;
      const files = await renderPlates(file, path.join(directory, 'plates'), true);
      const black = await readPlate(files, new TextEncoder().encode('Black'));
      const { ink, escaped } = renderedInk(black, artBox);
      expect(ink).toBeGreaterThan(0);
      expect(escaped).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

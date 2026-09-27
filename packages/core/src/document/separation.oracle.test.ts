import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPlate, renderPlates } from '../../../../scripts/plateOracle.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

describe('separation plates', () => {
  it('keeps ASCII and Shift_JIS colorant names and ink tints', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-plates-'));
    try {
      const document = createDocument();
      const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
      const legacyName = new Uint8Array([0x82, 0x62, 0x82, 0x74, 0x82, 0x73]);
      const legacy = document.separation({ name: legacyName, alternate: cmyk(0, 0, 0, 0.1) });
      const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(40), pt(20)) });
      page.draw(content => {
        content.fillColor(white, 0.75);
        content.path(p => p.rect(0, 0, 20, 20));
        content.fill('nonzero');
        content.fillColor(legacy, 0.25);
        content.path(p => p.rect(20, 0, 20, 20));
        content.fill('nonzero');
      });
      const file = path.join(directory, 'spots.pdf');
      await writeFile(file, document.save().toBytes());
      const plates = await renderPlates(file, directory);
      const whitePlate = await readPlate(plates, new TextEncoder().encode('White'));
      const legacyPlate = await readPlate(plates, legacyName);
      expect(plates).toHaveLength(2);
      expect(whitePlate.inkAt(10, 10)).toBeCloseTo(191, 0);
      expect(whitePlate.inkAt(30, 10)).toBe(0);
      expect(legacyPlate.inkAt(10, 10)).toBe(0);
      expect(Math.abs(legacyPlate.inkAt(30, 10) - 64)).toBeLessThanOrEqual(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

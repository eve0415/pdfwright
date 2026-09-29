import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPlate, renderPlates, renderRgbPixel } from '../../../../scripts/plateOracle.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const makePdf = (mode: 0 | 1): Uint8Array => {
  const document = createDocument();
  const spot = document.separation({ name: 'Spot', alternate: cmyk(0, 1, 0, 0) });
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(40), pt(20)), group: { colorSpace: 'DeviceCMYK' } });
  page.draw(content => {
    content.fillColor(cmyk(1, 0, 0, 0));
    content.path(p => p.rect(0, 0, 40, 20));
    content.fill('nonzero');
    content.fillColor(spot, 1);
    content.path(p => p.rect(0, 0, 40, 10));
    content.fill('nonzero');
    content.graphicsState({ overprintFill: true, overprintMode: mode });
    content.fillColor(cmyk(0, 0, 0, 0));
    content.path(p => p.rect(10, 0, 20, 20));
    content.fill('nonzero', { acknowledgeInvisibleOverprint: mode === 1 });
  });
  return document.save().toBytes();
};

describe('white overprint plates', () => {
  it('leaves cyan under OPM 1 and knocks cyan out under OPM 0', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-white-overprint-'));
    try {
      const opm1 = path.join(directory, 'opm1.pdf');
      const opm0 = path.join(directory, 'opm0.pdf');
      await writeFile(opm1, makePdf(1));
      await writeFile(opm0, makePdf(0));
      const first = await renderPlates(opm1, path.join(directory, 'mode1'), true);
      const second = await renderPlates(opm0, path.join(directory, 'mode0'), true);
      const cyan1 = await readPlate(first, new TextEncoder().encode('Cyan'));
      const cyan0 = await readPlate(second, new TextEncoder().encode('Cyan'));
      expect(cyan1.inkAt(20, 5)).toBeGreaterThan(250);
      expect(cyan0.inkAt(20, 5)).toBeLessThan(5);
      expect(cyan0.inkAt(5, 5)).toBeGreaterThan(250);
      const mupdf1 = await renderRgbPixel(opm1, path.join(directory, 'mode1.pam'), 20, 5);
      const mupdf0 = await renderRgbPixel(opm0, path.join(directory, 'mode0.pam'), 20, 5);
      expect(mupdf0[0] - mupdf1[0]).toBeGreaterThan(240);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

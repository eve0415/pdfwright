import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPlate, renderGsCmykPixel, renderPlates } from '../../../../scripts/plateOracle.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const addImagePage = (
  colorSpace: 'DeviceRGB' | ReturnType<ReturnType<typeof createDocument>['separation']>,
  samples: Uint8Array,
  document: ReturnType<typeof createDocument>,
): void => {
  const image = document.image({
    width: 3,
    height: 1,
    colorSpace,
    bitsPerComponent: 8,
    samples,
    softMask: { width: 3, height: 1, samples: new Uint8Array([255, 128, 0]) },
  });
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(30), pt(10)) });
  page.draw(content => {
    content.image(image, [30, 0, 0, 10, 0, 0]);
  });
};

describe('soft mask rendering', () => {
  it('applies three mask bands to a White separation image plate', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-white-mask-'));
    try {
      const document = createDocument();
      const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
      addImagePage(white, new Uint8Array([255, 255, 255]), document);
      const file = path.join(directory, 'white.pdf');
      await writeFile(file, document.save().toBytes());
      const plate = await readPlate(await renderPlates(file, directory), new TextEncoder().encode('White'));
      expect(plate.inkAt(5, 5)).toBeGreaterThan(250);
      expect(Math.abs(plate.inkAt(15, 5) - 128)).toBeLessThanOrEqual(2);
      expect(plate.inkAt(25, 5)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies the same alpha bands to an RGB image in Ghostscript', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-rgb-mask-'));
    try {
      const document = createDocument();
      addImagePage('DeviceRGB', new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0]), document);
      const file = path.join(directory, 'rgb.pdf');
      const output = path.join(directory, 'rgb.tif');
      await writeFile(file, document.save().toBytes());
      const first = await renderGsCmykPixel(file, output, 5, 5);
      const middle = await renderGsCmykPixel(file, output, 15, 5);
      const last = await renderGsCmykPixel(file, output, 25, 5);
      expect(first[1]).toBeGreaterThan(240);
      expect(Math.abs(middle[1] - 128)).toBeLessThanOrEqual(5);
      expect(last[1]).toBeLessThan(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

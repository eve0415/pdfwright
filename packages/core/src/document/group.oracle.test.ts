import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPlate, renderPlates } from '../../../../scripts/plateOracle.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

describe('transparency group plate', () => {
  it('renders a 30 percent Primer tint through an isolated group', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-group-'));
    try {
      const document = createDocument();
      const primer = document.separation({ name: 'Primer', alternate: cmyk(0, 0, 0, 0.5) });
      const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)), isolated: true, colorSpace: 'DeviceCMYK' }, content => {
        content.graphicsState({ fillAlpha: 0.3 });
        content.fillColor(primer, 1);
        content.path(p => p.rect(0, 0, 20, 20));
        content.fill('nonzero');
      });
      const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)), group: { colorSpace: 'DeviceCMYK' } });
      page.draw(content => {
        content.group(group, [1, 0, 0, 1, 0, 0]);
      });
      const file = path.join(directory, 'primer.pdf');
      await writeFile(file, document.save().toBytes());
      const plate = await readPlate(await renderPlates(file, directory), new TextEncoder().encode('Primer'));
      expect(Math.abs(plate.inkAt(10, 10) - 77)).toBeLessThanOrEqual(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

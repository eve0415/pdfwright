import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPlate, renderGsCmykPixel, renderPlates, renderRgbPixel } from '../../../../scripts/plateOracle.ts';

import { textPdfBytes } from './textPdf.ts';

const SPOT = new TextEncoder().encode('Spot');

// A 600 × 800 point page with a 20-point square of the Spot separation at its lower left corner.
const spotPage = textPdfBytes({
  pages: [{ content: '/CS0 cs 1 scn 10 10 20 20 re f', resources: '/ColorSpace<</CS0[/Separation/Spot/DeviceCMYK 100 0 R]>>' }],
  objects: [{ number: 100, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 1>>' }],
});
const cyanPage = textPdfBytes({ pages: [{ content: '1 0 0 0 k 10 10 20 20 re f' }] });
// Page 1 paints a cyan square and a blue one, and page 2 paints magenta and red in their places, so a renderer that draws page 2 reads other values.
const twoPages = textPdfBytes({
  pages: [{ content: '1 0 0 0 k 10 10 20 20 re f 0 0 1 rg 40 10 20 20 re f' }, { content: '0 1 0 0 k 10 10 20 20 re f 1 0 0 rg 40 10 20 20 re f' }],
});
// Ghostscript cannot draw a page whose Contents is a string, and still exits 0 with blank plates.
const undrawablePage = textPdfBytes({ pages: [{ entries: '/Contents 100 0 R' }], objects: [{ number: 100, body: '(not a content stream)' }] });

const withDirectory = async <T>(run: (directory: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-plates-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const written = async (directory: string, name: string, bytes: Uint8Array): Promise<string> => {
  const file = path.join(directory, name);
  await writeFile(file, bytes);
  return file;
};

describe('Ghostscript plates', () => {
  it('reads ink inside the painted square and none outside it, with y counted from the top', async () => {
    const ink = await withDirectory(async directory => {
      const plate = await readPlate(await renderPlates(await written(directory, 'spot.pdf', spotPage), path.join(directory, 'plates')), SPOT);
      return [plate.width, plate.height, plate.inkAt(20, 780), plate.inkAt(40, 780), plate.inkAt(20, 20)];
    });
    expect(ink).toStrictEqual([600, 800, 255, 0, 0]);
  });

  it('refuses a page Ghostscript reports it could not draw, which it renders blank', async () => {
    await withDirectory(async directory => {
      const file = await written(directory, 'undrawable.pdf', undrawablePage);
      await expect(renderPlates(file, path.join(directory, 'plates'), true)).rejects.toThrow(/Page drawing error/u);
      await expect(renderGsCmykPixel(file, path.join(directory, 'cmyk.tif'), 20, 780)).rejects.toThrow(/Page drawing error/u);
    });
  });

  it('returns only the plates of the latest render into a directory', async () => {
    const names = await withDirectory(async directory => {
      const plates = path.join(directory, 'plates');
      await renderPlates(await written(directory, 'spot.pdf', spotPage), plates);
      return (await renderPlates(await written(directory, 'cyan.pdf', cyanPage), plates, true)).map(plate => new TextDecoder().decode(plate.name)).toSorted();
    });
    expect(names).toStrictEqual(['Black', 'Cyan', 'Magenta', 'Yellow']);
  });

  it('reads the CMYK of one pixel', async () => {
    const pixel = await withDirectory(async directory =>
      renderGsCmykPixel(await written(directory, 'cyan.pdf', cyanPage), path.join(directory, 'cmyk.tif'), 20, 780),
    );
    expect(pixel).toStrictEqual([255, 0, 0, 0]);
  });
});

describe('page 1 of a two-page file', () => {
  it('is the page Ghostscript separates', async () => {
    const ink = await withDirectory(async directory => {
      const plates = await renderPlates(await written(directory, 'two.pdf', twoPages), path.join(directory, 'plates'), true);
      const [cyan, magenta] = await Promise.all([readPlate(plates, new TextEncoder().encode('Cyan')), readPlate(plates, new TextEncoder().encode('Magenta'))]);
      return [cyan.inkAt(20, 780), magenta.inkAt(20, 780)];
    });
    expect(ink).toStrictEqual([255, 0]);
  });

  it('is the page Ghostscript draws in CMYK', async () => {
    const pixel = await withDirectory(async directory =>
      renderGsCmykPixel(await written(directory, 'two.pdf', twoPages), path.join(directory, 'cmyk.tif'), 20, 780),
    );
    expect(pixel).toStrictEqual([255, 0, 0, 0]);
  });

  it('is the page MuPDF draws in RGB', async () => {
    const pixel = await withDirectory(async directory =>
      renderRgbPixel(await written(directory, 'two.pdf', twoPages), path.join(directory, 'rgb.pam'), 50, 780),
    );
    expect(pixel).toStrictEqual([0, 0, 255]);
  });
});

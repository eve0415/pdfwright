import type { TestObject } from './pdfBuilder.ts';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { magick, readerReports, runQpdf } from '../../../../scripts/readerOracle.ts';

import { buildPdf } from './pdfBuilder.ts';

const withFile = async <T>(bytes: Uint8Array, run: (file: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-readers-'));
  try {
    const file = path.join(directory, 'file.pdf');
    await writeFile(file, bytes);
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const page = (number: number, trimBox: string): TestObject => ({
  number,
  body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/TrimBox[${trimBox}]>>`,
});

// Page 1 is object 5 and page 2 object 3, so a reader of the first TrimBox in object order would report page 2's.
const twoPages = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[5 0 R 3 0 R]/Count 2>>' },
      page(3, '1 1 9 9'),
      page(5, '10 20 90 80'),
    ],
    trailer: '/Root 1 0 R',
  },
]).bytes;

describe('reader reports', () => {
  it('give the TrimBox of page 1 from every reader, whatever its object number', async () => {
    const reports = await withFile(twoPages, readerReports);
    expect(reports.map(report => [report.tool, report.code, report.trimBox, report.notices])).toStrictEqual([
      ['qpdf', 0, [10, 20, 90, 80], []],
      ['mutool', 0, [10, 20, 90, 80], []],
      ['gs', 0, [10, 20, 90, 80], []],
      ['poppler', 0, [10, 20, 90, 80], []],
    ]);
  });

  // pdfinfo reports the CropBox, here the MediaBox, as the TrimBox of a page that has none.
  it('give no TrimBox when page 1 has none, though page 2 has one', async () => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>' },
          page(4, '1 1 9 9'),
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes;
    const reports = await withFile(pdf, readerReports);
    expect(reports.map(report => [report.tool, report.code, report.trimBox, report.notices])).toStrictEqual([
      ['qpdf', 0, undefined, []],
      ['mutool', 0, undefined, []],
      ['gs', 0, undefined, []],
      ['poppler', 0, [0, 0, 100, 100], []],
    ]);
  });
});

describe('checked tool runs', () => {
  it('returns what qpdf prints for an intact file and rejects one it can only recover', async () => {
    await withFile(twoPages, async file => {
      expect((await runQpdf(['--check', file])).stdout).toContain('No syntax or stream encoding errors found');
    });
    const damaged = new TextEncoder().encode(new TextDecoder('latin1').decode(twoPages).replace(/startxref\n\d+/u, 'startxref\n7'));
    await withFile(damaged, async file => {
      await expect(runQpdf(['--check', file])).rejects.toThrow(/qpdf exited 3/u);
    });
  });

  it('passes ImageMagick its input on stdin and returns its stdout, and rejects a conversion it refuses', async () => {
    const pgm = Uint8Array.from([...new TextEncoder().encode('P5\n2 1\n255\n'), 7, 200]);
    await expect(magick(['pgm:-', '-depth', '8', 'gray:-'], pgm)).resolves.toStrictEqual(Uint8Array.from([7, 200]));
    await expect(magick(['pgm:-', 'png:-'], pgm.subarray(0, 4))).rejects.toThrow(/magick exited [1-9]/u);
    await expect(magick(['pgm:-', 'null:'], pgm)).rejects.toThrow(/magick wrote nothing/u);
  });
});

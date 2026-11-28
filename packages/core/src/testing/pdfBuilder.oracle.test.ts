import type { TestSection } from './pdfBuilder.ts';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runQpdf } from '../../../../scripts/readerOracle.ts';

import { buildPdf } from './pdfBuilder.ts';

const CATALOG = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const PAGES = { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' };
const PAGE = { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>' };
const ROOT = '/Root 1 0 R';

const original = (xref: TestSection['xref'], extra: Partial<TestSection> = {}): TestSection => ({
  xref,
  objects: [CATALOG, PAGES, PAGE],
  trailer: ROOT,
  ...extra,
});
const members = {
  objectStreams: [
    {
      number: 5,
      members: [
        { number: 4, body: '(four)' },
        { number: 6, body: '[6 (six)]' },
      ],
    },
  ],
};

// Each build, and the objects qpdf must show from it with the text it must print; qpdf normalises spacing inside arrays.
const BUILDS: ReadonlyArray<readonly [string, ReadonlyArray<TestSection>, ReadonlyArray<readonly [number, string]>]> = [
  ['a classic table', [original('classic')], [[3, '/MediaBox [ 0 0 100 100 ]']]],
  ['a cross-reference stream', [original('stream')], [[3, '/MediaBox [ 0 0 100 100 ]']]],
  [
    'a cross-reference stream with an object stream',
    [original('stream', members)],
    [
      [4, '(four)'],
      [6, '[ 6 (six) ]'],
    ],
  ],
  ['a Flate cross-reference stream', [original('stream', { ...members, xrefStreamEncoding: 'flate' })], [[6, '[ 6 (six) ]']]],
  ['a Flate cross-reference stream with the Up predictor', [original('stream', { ...members, xrefStreamEncoding: 'flate-up' })], [[6, '[ 6 (six) ]']]],
  ['an original hybrid section', [original('hybrid', members)], [[4, '(four)']]],
  [
    'a hybrid update whose member the classic table omits',
    [original('classic'), { xref: 'hybrid', objects: [], trailer: ROOT, ...members }],
    [[6, '[ 6 (six) ]']],
  ],
  [
    'a chain of a classic table, a stream update and a hybrid update',
    [
      original('classic'),
      { xref: 'stream', objects: [{ number: 3, generation: 1, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 50 50]>>' }], trailer: '/Root 1 0 R' },
      { xref: 'hybrid', objects: [], trailer: ROOT, objectStreams: [{ number: 8, members: [{ number: 9, body: '(nine)' }] }] },
    ],
    [[9, '(nine)']],
  ],
  [
    'a classic table with a free list and an update that frees another number',
    [
      original('classic', {
        free: [
          { number: 5, generation: 1 },
          { number: 4, generation: 2 },
        ],
      }),
      { xref: 'classic', objects: [], free: [{ number: 6, generation: 1 }], trailer: ROOT },
    ],
    [[3, '/MediaBox [ 0 0 100 100 ]']],
  ],
];

const withFile = async <T>(bytes: Uint8Array, run: (file: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-builder-'));
  try {
    const file = path.join(directory, 'built.pdf');
    await writeFile(file, bytes);
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('built test PDFs read by qpdf', () => {
  it.each(BUILDS)('checks %s with no warning and shows its objects', async (_, sections, objects) => {
    const report = await withFile(buildPdf(sections).bytes, async file => {
      // runQpdf rejects on exit 3, which is how qpdf reports a file it had to warn about or recover.
      const check = await runQpdf(['--check', file]);
      const shown = await Promise.all(objects.map(async ([number]) => (await runQpdf([`--show-object=${String(number)}`, file])).stdout));
      return { output: `${check.stdout}${check.stderr}`, shown };
    });
    expect(report.output).not.toMatch(/warning|recover|reconstruct|error:/iu);
    expect(report.shown.map((text, index) => text.includes(objects[index]?.[1] ?? '\u0000'))).toStrictEqual(objects.map(() => true));
  });
});

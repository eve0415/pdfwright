import type { CheckedRun, ToolRun } from './readerOracle.ts';

import { describe, expect, it } from 'vitest';

import { boxFromText, ghostscriptTrimBox, popplerTrimBox, qpdfPageBox, runChecked, runTool } from './readerOracle.ts';

type Json = string | number | ReadonlyArray<Json> | { readonly [key: string]: Json };

const node = process.execPath;
const MISSING = 'pdfwright-no-such-tool';

// qpdf --json=2 --json-key=pages --json-key=qpdf lists objects by number, so page 1 (object 7) comes after another page (object 3).
const qpdfJson = (pageEntries: Readonly<Record<string, Json>>, extra: Readonly<Record<string, Json>> = {}): Json => ({
  version: 2,
  pages: [
    { object: '7 0 R', pageposfrom1: 1 },
    { object: '3 0 R', pageposfrom1: 2 },
  ],
  qpdf: [
    { jsonversion: 2 },
    {
      'obj:3 0 R': { value: { '/Type': '/Page', '/TrimBox': [9, 9, 99, 99] } },
      'obj:7 0 R': { value: { '/Type': '/Page', ...pageEntries } },
      ...extra,
    },
  ],
});

describe('running oracle tools', () => {
  it('returns what a checked tool writes and passes it standard input', async () => {
    const run = await runChecked(node, ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("note")'], Uint8Array.from([0, 1, 255]));
    expect([[...run.stdout], run.stderr]).toStrictEqual([[0, 1, 255], 'note']);
  });

  it('rejects a checked tool that exits nonzero, with its exit code and stderr', async () => {
    await expect(runChecked(node, ['-e', 'process.stderr.write("broken input"); process.exit(3)'])).rejects.toThrow(/exited 3: broken input/u);
  });

  it('rejects with the exit code of a tool that quits without reading its standard input', async () => {
    await expect(runChecked(node, ['-e', 'process.exit(5)'], new Uint8Array(4 << 20))).rejects.toThrow(/exited 5/u);
    await expect(runChecked(node, ['-e', 'process.exit(0)'], new Uint8Array(4 << 20))).rejects.toThrow(/without reading all of its input/u);
  });

  it('reports the exit code of a tool run without checking', async () => {
    await expect(runTool(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(2)'])).resolves.toStrictEqual({
      code: 2,
      output: 'outerr',
    });
  });

  it.each([
    ['checked', async (): Promise<CheckedRun | ToolRun> => runChecked(MISSING, [])],
    ['checked with standard input', async (): Promise<CheckedRun | ToolRun> => runChecked(MISSING, [], new Uint8Array(1 << 20))],
    ['unchecked', async (): Promise<CheckedRun | ToolRun> => runTool(MISSING, [])],
  ])('names a missing tool when a %s run cannot start it', async (_, run) => {
    // Node's own spawn error names the command too, so the ENOENT cause is what shows the error was replaced by one that says what to do.
    await expect(run()).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining(MISSING), cause: expect.objectContaining({ code: 'ENOENT' }) }),
    );
  });
});

describe('page 1 boxes in qpdf JSON', () => {
  it('reads the box of page 1 rather than the first box in object order', () => {
    expect(qpdfPageBox(qpdfJson({ '/TrimBox': [10, 20, 190.5, 180] }))).toStrictEqual([10, 20, 190.5, 180]);
  });

  it('follows an indirect box and reads another box by name', () => {
    const json = qpdfJson({ '/TrimBox': '12 0 R', '/BleedBox': [0, 0, 5, 5] }, { 'obj:12 0 R': { value: [1, 2, 3, 4] } });
    expect([qpdfPageBox(json), qpdfPageBox(json, '/BleedBox')]).toStrictEqual([
      [1, 2, 3, 4],
      [0, 0, 5, 5],
    ]);
  });

  it('reports no box when page 1 has none, even when another page does, and when qpdf lists no pages', () => {
    expect(qpdfPageBox(qpdfJson({}))).toBeUndefined();
    expect(qpdfPageBox({ pages: [], qpdf: [{}, { 'obj:3 0 R': { value: { '/TrimBox': [9, 9, 99, 99] } } }] })).toBeUndefined();
  });

  it.each([
    ['a box of three numbers', qpdfJson({ '/TrimBox': [1, 2, 3] })],
    ['a box with a name in it', qpdfJson({ '/TrimBox': [1, 2, 3, '/Four'] })],
    ['a box that is a name', qpdfJson({ '/TrimBox': '/Four' })],
  ])('refuses %s', (_, json) => {
    expect(() => qpdfPageBox(json)).toThrow(/not four numbers/u);
  });

  it.each([
    ['no pages key', { qpdf: [{}, {}] }],
    ['a page 1 whose object is missing', { pages: [{ object: '5 0 R' }], qpdf: [{}, {}] }],
    ['JSON that is not an object', [1, 2]],
  ])('refuses JSON with %s', (_, json) => {
    expect(() => qpdfPageBox(json)).toThrow(TypeError);
  });
});

describe('boxes in reader text output', () => {
  const pattern = /TrimBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/u;

  it('reads four numbers and reports none when the output has no TrimBox', () => {
    expect(boxFromText('poppler', 'TrimBox:        10.00    20.00   190.00   -5.5', pattern)).toStrictEqual([10, 20, 190, -5.5]);
    expect(boxFromText('poppler', 'MediaBox: 0 0 200 200', pattern)).toBeUndefined();
  });

  it('refuses a TrimBox the pattern cannot read, rather than reporting none', () => {
    expect(() => boxFromText('poppler', 'TrimBox: [10 20 190 180]', pattern)).toThrow(/cannot read/u);
  });

  it('refuses captures that are not finite numbers', () => {
    expect(() => boxFromText('poppler', 'TrimBox: 1 2 3 .', pattern)).toThrow(/not four numbers/u);
  });
});

// Output in the form Ghostscript 10.05 prints with -dPDFINFO.
describe('page 1 TrimBox in Ghostscript output', () => {
  it('reads the box on the page 1 line', () => {
    expect(ghostscriptTrimBox('Processing pages 1 through 1.\nPage 1 MediaBox: [0 0 100 100] TrimBox: [10 20 90 80]\n')).toStrictEqual([10, 20, 90, 80]);
  });

  it('reports none when page 1 has none, when only another page is reported, and when no page is', () => {
    expect([
      ghostscriptTrimBox('Page 1 MediaBox: [0 0 100 100]\n\nPage 2 MediaBox: [0 0 100 100] TrimBox: [1 1 9 9]\n'),
      ghostscriptTrimBox('Processing pages 1 through 2.\n   **** Error: page not found.\nPage 2 MediaBox: [0 0 100 100] TrimBox: [1 1 9 9]\n'),
      ghostscriptTrimBox("   **** Error: Couldn't initialise file.\n   No pages will be processed (FirstPage > LastPage).\n"),
    ]).toStrictEqual([undefined, undefined, undefined]);
  });

  it('refuses boxes reported on lines it cannot assign to a page', () => {
    expect(() => ghostscriptTrimBox('Page 1: MediaBox: [0 0 100 100] TrimBox: [10 20 90 80]\n')).toThrow(/cannot read/u);
  });
});

describe('TrimBox in pdfinfo output', () => {
  it('reads the TrimBox line, which pdfinfo prints for a page without one too', () => {
    expect(popplerTrimBox(0, 'CropBox:   0.00  0.00 100.00 100.00\nTrimBox:   0.00  0.00 100.00 100.00\n')).toStrictEqual([0, 0, 100, 100]);
  });

  it('reports none when pdfinfo cannot read the file', () => {
    expect(popplerTrimBox(1, "Syntax Error: Couldn't read xref table\n")).toBeUndefined();
  });

  it('refuses output of a successful run with no TrimBox line', () => {
    expect(() => popplerTrimBox(0, 'MediaBox:   0.00  0.00 100.00 100.00\nTrim box:   0.00  0.00 100.00 100.00\n')).toThrow(/cannot read/u);
  });
});

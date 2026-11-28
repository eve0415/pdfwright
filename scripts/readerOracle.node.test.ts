import type { CheckedRun, ToolRun } from './readerOracle.ts';

import { describe, expect, it } from 'vitest';

import { boxFromText, qpdfPageBox, runChecked, runTool } from './readerOracle.ts';

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

  it('reports the exit code of a tool run without checking', async () => {
    await expect(runTool(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(2)'])).resolves.toStrictEqual({
      code: 2,
      output: 'outerr',
    });
  });

  it.each([
    ['checked', async (): Promise<CheckedRun | ToolRun> => runChecked(MISSING, [])],
    ['unchecked', async (): Promise<CheckedRun | ToolRun> => runTool(MISSING, [])],
  ])('names a missing tool when a %s run cannot start it', async (_, run) => {
    await expect(run()).rejects.toThrow(`${MISSING} is not installed or not on PATH`);
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

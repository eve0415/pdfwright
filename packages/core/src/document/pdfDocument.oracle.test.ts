import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { formatLength, mm, pt } from '../length/length.ts';

import { createDocument } from './pdfDocument.ts';

interface PageReport {
  pages: unknown[];
  boxes: string[][];
}

interface OracleReport extends PageReport {
  pageCount: number;
  checkOutput: string;
  checkError: string;
}

const runQpdf = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const child = spawn('qpdf', args);
  const [closed, stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
  if (closed[0] !== 0) throw new Error(`qpdf exited ${String(closed[0])}: ${stdout}${stderr}`);
  return { stdout, stderr };
};

const qpdf = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
  try {
    return await runQpdf(args);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error('qpdf is required; install it with sudo apt-get install -y qpdf', { cause: error });
    }
    throw error;
  }
};

const boxForPage = (entries: readonly [string, unknown][], page: unknown): string[] => {
  if (typeof page !== 'object' || page === null || !('object' in page) || typeof page.object !== 'string') throw new Error('qpdf omitted a page reference');
  const key = `obj:${page.object}`;
  const indirect = entries.find(([entry]) => entry === key)?.[1];
  if (typeof indirect !== 'object' || indirect === null || !('value' in indirect)) throw new Error('qpdf omitted a page value');
  const value: unknown = indirect.value;
  if (typeof value !== 'object' || value === null || !('/MediaBox' in value) || !Array.isArray(value['/MediaBox'])) {
    throw new Error('qpdf omitted a page MediaBox');
  }
  const mediaBox: unknown[] = value['/MediaBox'];
  return mediaBox.map(number => {
    if (typeof number !== 'number') throw new Error('qpdf returned a nonnumeric MediaBox');
    return String(number);
  });
};

const pageBoxes = (json: unknown): PageReport => {
  if (typeof json !== 'object' || json === null || !('pages' in json) || !Array.isArray(json.pages) || !('qpdf' in json) || !Array.isArray(json.qpdf)) {
    throw new Error('qpdf returned unexpected JSON');
  }
  const pages: unknown[] = json.pages;
  const sections: unknown[] = json.qpdf;
  const [, section] = sections;
  if (typeof section !== 'object' || section === null) throw new Error('qpdf omitted indirect objects');
  const entries: [string, unknown][] = Object.entries(section);
  return { pages, boxes: pages.map(page => boxForPage(entries, page)) };
};

const checkDocument = async (directory: string, pageCount: number): Promise<OracleReport> => {
  const document = createDocument();
  for (let index = 0; index < pageCount; index++) document.addPage({ mediaBox: [pt(0), pt(0), mm(210), mm(297)] });
  const file = path.join(directory, `a4-${pageCount}.pdf`);
  await writeFile(file, document.save());
  const checked = await qpdf(['--check', file]);
  const reported = await qpdf(['--json', file]);
  const result: unknown = JSON.parse(reported.stdout);
  return { pageCount, checkOutput: checked.stdout, checkError: checked.stderr, ...pageBoxes(result) };
};

describe('qpdf document oracle', () => {
  it('checks one-page and three-page A4 documents without warnings', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-oracle-'));
    try {
      const reports = await Promise.all([checkDocument(directory, 1), checkDocument(directory, 3)]);
      for (const report of reports) {
        expect(report.checkOutput.toLowerCase()).not.toContain('warning');
        expect(report.checkError).toBe('');
        expect(report.pages).toHaveLength(report.pageCount);
        const expected = ['0', '0', formatLength(mm(210), 5), formatLength(mm(297), 5)];
        for (const box of report.boxes) expect(box).toStrictEqual(expected);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

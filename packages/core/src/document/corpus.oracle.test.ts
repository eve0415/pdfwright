import type { PdfDifference } from '../compare/pdfDifference.ts';

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import { describe, expect, it } from 'vitest';

import { readerReports, runTool } from '../../../../scripts/readerOracle.ts';
import { compareDocuments } from '../compare/compareDocuments.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const CORPUS = path.join(import.meta.dirname, '../../test/corpus');

/** How a corpus file is expected to fail: by throwing a named error, or by comparisons that report the listed places as undecodable. */
type ExpectedFailure = { readonly error: string; readonly reason: string } | { readonly undecodable: readonly string[]; readonly reason: string };

const expectedFailure = (entry: unknown): ExpectedFailure | undefined => {
  if (typeof entry !== 'object' || entry === null || !('reason' in entry) || typeof entry.reason !== 'string') return undefined;
  if ('error' in entry && typeof entry.error === 'string') return { error: entry.error, reason: entry.reason };
  if (!('undecodable' in entry) || !Array.isArray(entry.undecodable)) return undefined;
  const places = entry.undecodable.filter((place: unknown): place is string => typeof place === 'string');
  return { undecodable: places, reason: entry.reason };
};

const expectedFailures = async (): Promise<ReadonlyMap<string, ExpectedFailure>> => {
  const parsed: unknown = JSON.parse(await readFile(path.join(CORPUS, 'expected-failures.json'), 'utf8'));
  const failures = new Map<string, ExpectedFailure>();
  if (typeof parsed !== 'object' || parsed === null) return failures;
  for (const [file, entry] of new Map<string, unknown>(Object.entries(parsed))) {
    const failure = expectedFailure(entry);
    if (failure !== undefined) failures.set(file, failure);
  }
  return failures;
};

// qpdf --check exits 0 when clean, 3 with warnings only and 2 with errors.
const rank = (code: number): number => {
  if (code === 0) return 0;
  return code === 3 ? 1 : 2;
};

interface Check {
  readonly rank: number;
  readonly classes: ReadonlySet<string>;
}

const qpdfCheck = async (file: string): Promise<Check> => {
  const run = await runTool('qpdf', ['--check', file]);
  const lines = run.output.replaceAll(file, 'FILE').split('\n');
  const classes = new Set(lines.filter(line => line.includes('WARNING')).map(line => line.replaceAll(/\d+/gu, 'N')));
  return { rank: rank(run.code), classes };
};

interface Workspace {
  readonly directory: string;
  readonly source: Check;
  /** Places, as a path joined with slashes, that the file's expected failure lists as undecodable. */
  readonly undecodable: ReadonlySet<string>;
}

// The differences a comparison reports, leaving out the undecodable places the file is expected to have.
const withoutExpected = (differences: readonly PdfDifference[], undecodable: ReadonlySet<string>): PdfDifference[] =>
  differences.filter(difference => difference.kind !== 'undecodable' || !undecodable.has(difference.where.join('/')));

// A save must not make qpdf report more than it did for the source: no higher exit status and no warning of a kind the source did not have.
const checkSaved = async (workspace: Workspace, [label, bytes]: readonly [string, Uint8Array]): Promise<string[]> => {
  const file = path.join(workspace.directory, `${label}.pdf`);
  await writeFile(file, bytes);
  const saved = await qpdfCheck(file);
  const problems =
    saved.rank > workspace.source.rank ? [`${label}: qpdf --check status went from ${String(workspace.source.rank)} to ${String(saved.rank)}`] : [];
  for (const line of saved.classes) if (!workspace.source.classes.has(line)) problems.push(`${label}: new qpdf warning ${line}`);
  return problems;
};

// An edit of one box must show as exactly that difference.
const checkBoxEdit = (bytes: Uint8Array, undecodable: ReadonlySet<string>): string[] => {
  const document = loadDocument(bytes);
  if (document.pageCount === 0) return [];
  const [left, bottom, right, top] = document.page(0).boxes().CropBox.rect;
  if (right - left < 4 || top - bottom < 4) return [];
  document.page(0).setBox('TrimBox', rect(pt(left + 1), pt(bottom + 1), pt(right - 1), pt(top - 1)));
  const saved = loadDocument(document.save().chunks);
  const differences = withoutExpected(compareDocuments(loadDocument(bytes), saved).differences, undecodable).map(difference =>
    difference.kind === 'page-box' ? `${difference.kind}:${String(difference.page)}:${difference.box}` : difference.kind,
  );
  return differences.length === 1 && differences[0] === 'page-box:0:TrimBox' ? [] : [`box edit: ${differences.join(', ')}`];
};

const saveMode = async (
  workspace: Workspace,
  [document, mode]: readonly [ReturnType<typeof loadDocument>, 'auto' | 'incremental' | 'full'],
): Promise<string[]> => {
  const saved = document.save({ mode });
  const differences = withoutExpected(compareDocuments(document, loadDocument(saved.chunks)).differences, workspace.undecodable).map(
    difference => difference.kind,
  );
  const problems = differences.length > 0 ? [`${mode}: differences ${differences.join(', ')}`] : [];
  const reported = await checkSaved(workspace, [mode, saved.toBytes()]);
  return [...problems, ...reported];
};

const roundTrip = async (workspace: Workspace, bytes: Uint8Array): Promise<string[]> => {
  const document = loadDocument(bytes);
  // A reconstructed file cannot take an incremental update.
  const modes = document.structure.status === 'reconstructed' ? (['auto', 'full'] as const) : (['auto', 'incremental', 'full'] as const);
  const results = await Promise.all(modes.map(async mode => saveMode(workspace, [document, mode])));
  return [...results.flat(), ...checkBoxEdit(bytes, workspace.undecodable)];
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

// A file expected to have undecodable places must still report each of them when compared with a copy of itself.
const missingUndecodable = (bytes: Uint8Array, undecodable: ReadonlySet<string>): string[] => {
  const copy = loadDocument(Uint8Array.from(bytes));
  const { differences } = compareDocuments(loadDocument(bytes), copy);
  const places = new Set(differences.map(difference => (difference.kind === 'undecodable' ? difference.where.join('/') : '')));
  return [...undecodable].filter(place => !places.has(place)).map(place => `did not report ${place} as undecodable`);
};

const checkFile = async (file: string, expected: ExpectedFailure | undefined): Promise<string[]> => {
  const bytes = new Uint8Array(await readFile(file));
  if (expected !== undefined && 'error' in expected) {
    try {
      await roundTrip({ directory: tmpdir(), source: { rank: 2, classes: new Set() }, undecodable: new Set() }, bytes);
    } catch (error: unknown) {
      return errorName(error) === expected.error ? [] : [`threw ${errorName(error)} instead of ${expected.error}`];
    }
    return [`did not throw ${expected.error}`];
  }
  const undecodable = new Set(expected?.undecodable);
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-corpus-'));
  try {
    const problems = await roundTrip({ directory, source: await qpdfCheck(file), undecodable }, bytes);
    return [...problems, ...missingUndecodable(bytes, undecodable)];
  } catch (error: unknown) {
    return [`threw ${errorName(error)}: ${error instanceof Error ? error.message : ''}`];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** Runs every PDF of a set and returns the problems found, by file. */
const runSet = async (set: string, directory = path.join(CORPUS, set)): Promise<Record<string, string[]>> => {
  const failures = await expectedFailures();
  const names = await readdir(directory);
  const files = names.filter(name => name.endsWith('.pdf')).toSorted();
  const problems: Record<string, string[]> = {};
  // Files run one after another, so that a large set does not start every qpdf process at once.
  const next = async (index: number): Promise<Record<string, string[]>> => {
    const name = files[index];
    if (name === undefined) return problems;
    const found = await checkFile(path.join(directory, name), failures.get(`${set}/${name}`));
    if (found.length > 0) problems[name] = found;
    return next(index + 1);
  };
  return next(0);
};

const GOVDOCS = path.join(CORPUS, 'govdocs1/.cache/files');

// The govdocs1 files are fetched by scripts/fetchCorpus.ts rather than committed; without them there is nothing to check.
const runFetched = async (): Promise<Record<string, string[]>> => {
  try {
    const names = await readdir(GOVDOCS);
    if (!names.some(name => name.endsWith('.pdf'))) {
      if (env['CI'] !== undefined) throw new Error('govdocs1 corpus is missing');
      return {};
    }
  } catch {
    if (env['CI'] !== undefined) throw new Error('govdocs1 corpus is missing');
    return {};
  }
  return runSet('govdocs1', GOVDOCS);
};

const readOptional = async (file: string): Promise<Uint8Array | undefined> => {
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    return undefined;
  }
};

// The Illustrator file of govdocs1: a plate and a trim box are added, and nothing but the page's boxes, content and resources may differ, while every reader shows the new box without repairs.
const illustratorEdit = async (): Promise<string[]> => {
  const bytes = await readOptional(path.join(GOVDOCS, '000146.pdf'));
  if (bytes === undefined) {
    if (env['CI'] !== undefined) throw new Error('govdocs1 Illustrator file is missing');
    return [];
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-'));
  try {
    const results = await Promise.all(
      (['incremental', 'full'] as const).map(async mode => {
        const document = loadDocument(bytes);
        const plate = document.separation({ name: 'Varnish', alternate: cmyk(0, 0, 0.2, 0) });
        document.page(0).setBox('TrimBox', rect(pt(20), pt(20), pt(500), pt(700)));
        document.page(0).appendContent(builder => {
          builder.fillColor(plate, 1);
          builder.path(draw => draw.rect(30, 30, 40, 40));
          builder.fill('nonzero');
        });
        const saved = document.save({ mode });
        const output = path.join(directory, `${mode}.pdf`);
        await writeFile(output, saved.toBytes());
        const allowed = new Set(['page-box', 'page-content', 'page-resources']);
        const unexpected = compareDocuments(loadDocument(bytes), loadDocument(saved.chunks))
          .differences.filter(difference => !allowed.has(difference.kind))
          .map(difference => `${mode}: ${difference.kind}`);
        const reports = await readerReports(output);
        const readers = reports
          .filter(report => report.notices.length > 0 || report.trimBox?.join(' ') !== '20 20 500 700')
          .map(report => `${mode}: ${report.tool} ${report.notices.join('; ')}`);
        for (const report of readers) unexpected.push(report);
        return unexpected;
      }),
    );
    return results.flat();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('corpus round trip', () => {
  it.each(['qpdf', 'cabinet', 'safedocs'])('loads, saves and compares every file of the %s set', { timeout: 120_000 }, async set => {
    await expect(runSet(set)).resolves.toStrictEqual({});
  });

  it('loads, saves and compares the fetched govdocs1 files', { timeout: 600_000 }, async () => {
    await expect(runFetched()).resolves.toStrictEqual({});
  });

  it('adds a plate to the fetched Illustrator file without touching its page-piece data', { timeout: 120_000 }, async () => {
    await expect(illustratorEdit()).resolves.toStrictEqual([]);
  });
});

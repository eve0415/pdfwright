// https://github.com/oxc-project/oxc/issues/26822: oxlint uses TypeScript defaults when no discovered tsconfig covers a file.
// A canary that depends on noUncheckedIndexedAccess reveals files checked under those defaults.

import type { Dirent } from 'node:fs';

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { promisify } from 'node:util';

const REPO = path.dirname(import.meta.dirname);
const OXLINT = path.join(REPO, 'node_modules', '.bin', 'oxlint');
const FLAT_DIRS = ['scripts', 'tests'] as const;
const CANARY = "const letters: string[] = ['a'];\nconst coverageCanary: string = letters[0];\nexport { coverageCanary };\n";
const CANARY_CODE = 'typescript(TS2322)';

const isDirectory = async (repo: string, relative: string): Promise<boolean> => {
  try {
    const info = await stat(path.join(repo, relative));
    return info.isDirectory();
  } catch {
    return false;
  }
};

// Package tsconfigs exclude oracle tests, so each directory that holds one needs a tsconfig of its own; untracked files count, so a new directory is checked before its first commit.
const oracleTestDirectories = async (repo: string): Promise<Array<string>> => {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.oracle.test.ts'], {
    cwd: repo,
  });
  const files = stdout.split('\0').filter(file => file !== '');
  return [...new Set(files.map(file => path.dirname(file)))].toSorted();
};

/** The canary files to plant in `repo`, relative to it. */
export const targetFiles = async (repo: string): Promise<Array<string>> => {
  const entries = await readdir(path.join(repo, 'packages'), { withFileTypes: true }).catch((): Array<Dirent> => []);
  const packages = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join('packages', entry.name))
    .toSorted();
  const candidates = [...packages.map(dir => path.join(dir, 'src')), ...FLAT_DIRS];
  const checked = await Promise.all(candidates.map(async dir => ((await isDirectory(repo, dir)) ? path.join(dir, 'coverageCanary.ts') : null)));
  return [
    ...checked.filter(file => file !== null),
    ...(await oracleTestDirectories(repo)).map(dir => path.join(dir, 'coverageCanary.oracle.test.ts')),
    'coverageCanary.config.ts',
    ...packages.map(dir => path.join(dir, 'coverageCanary.config.ts')),
  ];
};

/** The files in oxlint's JSON report that carry the canary's type error, which only this repository's compiler options raise. */
export const canaryHits = (report: unknown): Set<string> => {
  if (typeof report !== 'object' || report === null || !('diagnostics' in report) || !Array.isArray(report.diagnostics)) {
    throw new Error('oxlint JSON output has no diagnostics array');
  }
  const diagnostics: ReadonlyArray<unknown> = report.diagnostics;
  const hits = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (
      typeof diagnostic === 'object' &&
      diagnostic !== null &&
      'code' in diagnostic &&
      diagnostic.code === CANARY_CODE &&
      'filename' in diagnostic &&
      typeof diagnostic.filename === 'string'
    ) {
      hits.add(diagnostic.filename);
    }
  }
  return hits;
};

// Returns the files oxlint reported the canary's type error in.
const lintReport = async (files: ReadonlyArray<string>): Promise<Set<string>> => {
  const child = spawn(OXLINT, [...files, '--format', 'json'], { cwd: REPO });
  try {
    const [closed, stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
    // Exit 0 means oxlint ran and reported nothing, so every canary was missed; exit 1 with diagnostics is the expected run.
    if (closed[0] === 0 || closed[0] === 1) {
      try {
        return canaryHits(JSON.parse(stdout));
      } catch (error: unknown) {
        throw new Error(`exit ${String(closed[0])}, ${error instanceof Error ? error.message : 'unreadable output'}:\n${stdout}${stderr}`, { cause: error });
      }
    }
    throw new Error(`exit ${String(closed[0])}:\n${stdout}${stderr}`);
  } catch (error: unknown) {
    child.kill();
    throw new Error(`oxlint failed to run: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
  }
};

const main = async (): Promise<void> => {
  const planted = await targetFiles(REPO);

  const cleanup = (): void => {
    for (const file of planted) {
      rmSync(path.join(REPO, file), { force: true });
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup();
    process.kill(process.pid, signal);
  };

  const signals = ['SIGINT', 'SIGTERM'] as const;
  for (const signal of signals) {
    process.once(signal, onSignal);
  }
  try {
    for (const file of planted) {
      writeFileSync(path.join(REPO, file), CANARY);
    }

    const hits = await lintReport(planted);
    const missed = planted.filter(file => !hits.has(file));
    if (missed.length > 0) {
      console.error('Type-aware linting did not reach these files:');
      for (const file of missed) {
        console.error(`  ${file}`);
      }
      console.error('\nEach directory needs a tsconfig whose include covers its TypeScript files.');
      process.exitCode = 1;
      return;
    }

    console.log(`Type-aware linting reached all ${String(planted.length)} TypeScript files.`);
  } finally {
    cleanup();
    for (const signal of signals) {
      process.removeListener(signal, onSignal);
    }
  }
};

if (import.meta.main) {
  await main();
}

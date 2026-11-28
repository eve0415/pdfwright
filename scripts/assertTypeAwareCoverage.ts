// https://github.com/oxc-project/oxc/issues/26822: oxlint uses TypeScript defaults when no discovered tsconfig covers a file.
// A canary that depends on noUncheckedIndexedAccess reveals files checked under those defaults.

import type { Dirent } from 'node:fs';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { text } from 'node:stream/consumers';

const REPO = path.dirname(import.meta.dirname);
const OXLINT = path.join(REPO, 'node_modules', '.bin', 'oxlint');
const FLAT_DIRS = ['scripts', 'tests'] as const;
const CANARY = "const letters: string[] = ['a'];\nconst coverageCanary: string = letters[0];\nexport { coverageCanary };\n";
const CANARY_CODE = 'typescript(TS2322)';

const isDirectory = async (relative: string): Promise<boolean> => {
  try {
    const info = await stat(path.join(REPO, relative));
    return info.isDirectory();
  } catch {
    return false;
  }
};

const targetFiles = async (): Promise<Array<string>> => {
  const entries = await readdir(path.join(REPO, 'packages'), { withFileTypes: true }).catch((): Array<Dirent> => []);
  const packages = entries.filter(entry => entry.isDirectory()).map(entry => path.join('packages', entry.name));
  const candidates = [...packages.map(dir => path.join(dir, 'src')), ...FLAT_DIRS];
  const checked = await Promise.all(candidates.map(async dir => ((await isDirectory(dir)) ? path.join(dir, 'coverageCanary.ts') : null)));
  return [
    ...checked.filter(file => file !== null),
    'packages/core/src/document/coverageCanary.oracle.test.ts',
    'packages/core/src/save/coverageCanary.oracle.test.ts',
    'packages/core/src/inspect/coverageCanary.oracle.test.ts',
    'packages/core/src/inspect/fonts/coverageCanary.oracle.test.ts',
    'packages/core/src/inspect/colorants/coverageCanary.oracle.test.ts',
    'packages/core/src/inspect/text/coverageCanary.oracle.test.ts',
    'packages/core/src/metadata/coverageCanary.oracle.test.ts',
    'packages/illustrator/src/zstd/coverageCanary.oracle.test.ts',
    'packages/illustrator/src/page/coverageCanary.oracle.test.ts',
    'packages/illustrator/src/testing/coverageCanary.oracle.test.ts',
    'coverageCanary.config.ts',
    ...packages.map(dir => path.join(dir, 'coverageCanary.config.ts')),
  ];
};

const canaryHits = (report: unknown): Set<string> => {
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
  const planted = await targetFiles();

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

await main();

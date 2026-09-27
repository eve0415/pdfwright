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
const CANARY_CODE = '[Error/typescript(TS2322)]';

const isDirectory = async (relative: string): Promise<boolean> => {
  try {
    const info = await stat(path.join(REPO, relative));
    return info.isDirectory();
  } catch {
    return false;
  }
};

const targetFiles = async (): Promise<string[]> => {
  const entries = await readdir(path.join(REPO, 'packages'), { withFileTypes: true }).catch((): Dirent[] => []);
  const packages = entries.filter(entry => entry.isDirectory()).map(entry => path.join('packages', entry.name));
  const candidates = [...packages.map(dir => path.join(dir, 'src')), ...FLAT_DIRS];
  const checked = await Promise.all(candidates.map(async dir => ((await isDirectory(dir)) ? path.join(dir, 'coverageCanary.ts') : null)));
  return [
    ...checked.filter(file => file !== null),
    'packages/core/src/document/coverageCanary.oracle.test.ts',
    'coverageCanary.config.ts',
    ...packages.map(dir => path.join(dir, 'coverageCanary.config.ts')),
  ];
};

const lintReport = async (files: readonly string[]): Promise<string> => {
  const child = spawn(OXLINT, [...files, '--format', 'unix'], { cwd: REPO });
  try {
    const [closed, stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
    const report = stdout + stderr;
    // Exit 0 means oxlint ran and reported nothing, so every canary was missed; exit 1 with diagnostics is the expected run.
    if (closed[0] === 0 || (closed[0] === 1 && report.includes('[Error/'))) return report;
    throw new Error(`exit ${String(closed[0])}; output contained no expected diagnostics:\n${report}`);
  } catch (error: unknown) {
    child.kill();
    throw new Error(`oxlint failed to run: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
  }
};

const main = async (): Promise<void> => {
  const planted = await targetFiles();

  const cleanup = (): void => {
    for (const file of planted) rmSync(path.join(REPO, file), { force: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup();
    process.kill(process.pid, signal);
  };

  const signals = ['SIGINT', 'SIGTERM'] as const;
  for (const signal of signals) process.once(signal, onSignal);
  try {
    for (const file of planted) writeFileSync(path.join(REPO, file), CANARY);

    const report = await lintReport(planted);
    const lines = report.split('\n');
    const missed = planted.filter(file => !lines.some(line => line.startsWith(`${file}:`) && line.endsWith(CANARY_CODE)));
    if (missed.length > 0) {
      console.error('Type-aware linting did not reach these files:');
      for (const file of missed) console.error(`  ${file}`);
      console.error('\nEach directory needs a tsconfig whose include covers its TypeScript files.');
      process.exitCode = 1;
      return;
    }

    console.log(`Type-aware linting reached all ${String(planted.length)} TypeScript files.`);
  } finally {
    cleanup();
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
};

await main();

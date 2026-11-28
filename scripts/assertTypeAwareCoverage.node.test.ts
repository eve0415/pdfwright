import { execFile } from 'node:child_process';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { canaryHits, targetFiles } from './assertTypeAwareCoverage.ts';

const run = promisify(execFile);

const writeFiles = async (root: string, files: ReadonlyArray<string>): Promise<void> => {
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '');
  }
};

describe('type-aware coverage targets', () => {
  it('plants an oracle canary in every directory with a tracked or untracked oracle test', async () => {
    await using repo = await mkdtempDisposable(path.join(tmpdir(), 'pdfwright-coverage-'));
    await run('git', ['init', '--quiet'], { cwd: repo.path });
    await writeFiles(repo.path, ['packages/alpha/src/index.ts', 'packages/alpha/src/deep/tracked.oracle.test.ts', 'scripts/tool.ts']);
    await run('git', ['add', '--all'], { cwd: repo.path });
    await writeFiles(repo.path, [
      'packages/beta/src/index.ts',
      'packages/beta/src/new/untracked.oracle.test.ts',
      'packages/beta/src/plain/unit.test.ts',
      'packages/beta/src/ignored/hidden.oracle.test.ts',
    ]);
    await writeFile(path.join(repo.path, '.gitignore'), 'packages/beta/src/ignored/\n');

    expect(await targetFiles(repo.path)).toStrictEqual([
      'packages/alpha/src/coverageCanary.ts',
      'packages/beta/src/coverageCanary.ts',
      'scripts/coverageCanary.ts',
      'packages/alpha/src/deep/coverageCanary.oracle.test.ts',
      'packages/beta/src/new/coverageCanary.oracle.test.ts',
      'coverageCanary.config.ts',
      'packages/alpha/coverageCanary.config.ts',
      'packages/beta/coverageCanary.config.ts',
    ]);
  });
});

describe('canary hits', () => {
  it('counts only the canary type error, by file', () => {
    const report = {
      diagnostics: [
        { code: 'typescript(TS2322)', filename: 'reached.ts' },
        { code: 'typescript(TS2304)', filename: 'other-error.ts' },
        { code: 'eslint(no-unused-vars)', filename: 'lint-only.ts' },
        { code: 'typescript(TS2322)' },
      ],
    };
    expect(canaryHits(report)).toStrictEqual(new Set(['reached.ts']));
  });

  it('refuses output without a diagnostics array', () => {
    expect(() => canaryHits({ errors: [] })).toThrow(/no diagnostics array/u);
  });
});

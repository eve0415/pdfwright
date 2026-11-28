import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const REPO = path.dirname(import.meta.dirname);
const VITEST = path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs');
const BIN = path.join(REPO, 'node_modules', '.bin');
const RUNTIMES = ['browser', 'bun', 'deno', 'node', 'workers'];

const run = promisify(execFile);

// Under Node the config defines the node, oracle, browser and workers projects; under Bun and Deno it defines only that runtime's project.
const launchers: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [process.execPath, [VITEST]],
  [path.join(BIN, 'bun'), ['--bun', VITEST]],
  [path.join(BIN, 'deno'), ['run', '-A', VITEST]],
];

/** The projects AGENTS.md's suffix convention assigns a test file to. */
const expectedProjects = (file: string): Array<string> => {
  if (file.endsWith('.oracle.test.ts')) {
    return ['oracle'];
  }
  if (file.endsWith('.node.test.ts')) {
    return ['node'];
  }
  return RUNTIMES;
};

/** Every test file in the working tree that Git does not ignore, tracked or not. */
const testFilesOnDisk = async (): Promise<Array<string>> => {
  const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.test.*', '*.spec.*'], { cwd: REPO });
  return stdout.split('\0').filter(file => file !== '' && existsSync(path.join(REPO, file)));
};

const isListing = (value: unknown): value is Array<{ file: string; projectName: string }> =>
  Array.isArray(value) &&
  value.every(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'file' in entry &&
      typeof entry.file === 'string' &&
      'projectName' in entry &&
      typeof entry.projectName === 'string',
  );

/** The files each project collects, read from `vitest list` in every runtime that hosts projects. */
const collectedProjects = async (): Promise<Map<string, Array<string>>> => {
  await using directory = await mkdtempDisposable(path.join(tmpdir(), 'pdfwright-collection-'));
  // The listings start without the Vitest variables of the worker running this test.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  const collected = new Map<string, Array<string>>();
  for (const [index, [command, args]] of launchers.entries()) {
    const output = path.join(directory.path, `${String(index)}.json`);
    await run(command, [...args, 'list', '--filesOnly', `--json=${output}`], { cwd: REPO, env });
    const listing: unknown = JSON.parse(await readFile(output, 'utf8'));
    if (!isListing(listing)) {
      throw new Error(`unexpected vitest list output from ${command}`);
    }
    for (const { file, projectName } of listing) {
      const relative = path.relative(REPO, file);
      // The browser project is named after its browser instance, as in `browser (chromium)`.
      const project = projectName.replace(/ \(.*\)$/u, '');
      collected.set(relative, [...(collected.get(relative) ?? []), project]);
    }
  }
  return collected;
};

describe('test collection', () => {
  it('collects every test file in exactly the projects its suffix names', async () => {
    const files = new Set(await testFilesOnDisk());
    const collected = await collectedProjects();
    const keys = [...files.union(new Set(collected.keys()))].toSorted();
    expect(Object.fromEntries(keys.map(file => [file, (collected.get(file) ?? []).toSorted()]))).toStrictEqual(
      Object.fromEntries(keys.map(file => [file, files.has(file) ? expectedProjects(file) : []])),
    );
    expect(files.size).toBeGreaterThan(0);
  }, 120_000);
});

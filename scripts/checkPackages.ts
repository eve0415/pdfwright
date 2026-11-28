// Checks what a consumer installs: packs every published package from a fresh build, installs the tarballs together into a project outside the repository, and imports each package there under Node, Bun and Deno.
// Each runtime must see the same export names as the package's source entry, and must run one call into each package.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtempDisposable, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const REPO = path.dirname(import.meta.dirname);
const BIN = path.join(REPO, 'node_modules', '.bin');

const run = promisify(execFile);

interface PublishedPackage {
  readonly directory: string;
  readonly name: string;
}

const readManifest = async (file: string): Promise<{ name: string; private: boolean; exportTargets: Array<string> }> => {
  const manifest: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('name' in manifest) || typeof manifest.name !== 'string') {
    throw new Error(`${file} has no package name`);
  }
  const targets: Array<string> = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      targets.push(value);
    } else if (typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value)) {
        collect(nested);
      }
    }
  };
  collect('exports' in manifest ? manifest.exports : undefined);
  return { name: manifest.name, private: 'private' in manifest && manifest.private === true, exportTargets: targets };
};

const publishedPackages = async (): Promise<Array<PublishedPackage>> => {
  const entries = await readdir(path.join(REPO, 'packages'), { withFileTypes: true });
  const found: Array<PublishedPackage> = [];
  for (const entry of entries.filter(candidate => candidate.isDirectory()).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(REPO, 'packages', entry.name);
    const file = path.join(directory, 'package.json');
    if (existsSync(file)) {
      const manifest = await readManifest(file);
      if (!manifest.private) {
        found.push({ directory, name: manifest.name });
      }
    }
  }
  return found;
};

// Runs in the consumer project with no type stripping, so it is plain JavaScript; it prints the runtime it ran in, each entry's export names, and the page count of an Illustrator PDF read back with the core package.
const consumerScript = (names: ReadonlyArray<string>): string => `
const runtime = 'Bun' in globalThis ? 'bun' : 'Deno' in globalThis ? 'deno' : 'node';
const exports = {};
for (const name of ${JSON.stringify(names)}) {
  exports[name] = Object.keys(await import(name)).sort();
}
const { loadDocument, pdfDate } = await import('@pdfwright/core');
const { writeIllustratorPdf } = await import('@pdfwright/illustrator');
const lastModified = pdfDate({ year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5, offset: 'Z' });
const pageCount = loadDocument(writeIllustratorPdf({ artboard: { width: 100, height: 70 }, layers: [{ name: 'Layer', items: [] }], lastModified })).pageCount;
console.log(JSON.stringify({ runtime, exports, pageCount }));
`;

const main = async (): Promise<void> => {
  const packages = await publishedPackages();
  if (packages.length === 0) {
    throw new Error('no published package found under packages/');
  }

  for (const { directory } of packages) {
    await rm(path.join(directory, 'dist'), { recursive: true, force: true });
  }
  await run('pnpm', ['run', 'build'], { cwd: REPO });

  await using scratch = await mkdtempDisposable(path.join(tmpdir(), 'pdfwright-packages-'));
  if (!path.relative(REPO, scratch.path).startsWith('..')) {
    throw new Error(`the consumer project ${scratch.path} must be outside the repository`);
  }

  const tarballs: Array<string> = [];
  for (const [index, { directory }] of packages.entries()) {
    const destination = path.join(scratch.path, 'tarballs', String(index));
    await run('pnpm', ['pack', '--pack-destination', destination], { cwd: directory });
    const packed = await readdir(destination);
    if (packed.length !== 1 || packed[0] === undefined) {
      throw new Error(`pnpm pack wrote ${String(packed.length)} files for ${directory}`);
    }
    tarballs.push(path.join(destination, packed[0]));
  }

  const consumer = path.join(scratch.path, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  // Offline with an empty cache, so a dependency the tarballs do not supply fails the install instead of coming from the registry.
  await run('npm', ['install', '--offline', '--cache', path.join(scratch.path, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], {
    cwd: consumer,
  });

  const failures: Array<string> = [];
  const expected: Record<string, Array<string>> = {};
  for (const { directory, name } of packages) {
    const installed = path.join(consumer, 'node_modules', ...name.split('/'));
    for (const target of (await readManifest(path.join(installed, 'package.json'))).exportTargets) {
      if (!existsSync(path.join(installed, target))) {
        failures.push(`${name}: the exports map names ${target}, which the tarball does not contain`);
      }
    }
    const source: unknown = await import(path.join(directory, 'src', 'index.ts'));
    if (typeof source !== 'object' || source === null) {
      throw new Error(`${name}'s source entry did not load as a module`);
    }
    expected[name] = Object.keys(source).toSorted();
  }

  await writeFile(path.join(consumer, 'consumer.mjs'), consumerScript(packages.map(({ name }) => name)));
  const runtimes = [
    ['node', process.execPath, []],
    ['bun', path.join(BIN, 'bun'), []],
    ['deno', path.join(BIN, 'deno'), ['run', '--allow-read']],
  ] as const;
  for (const [runtime, command, args] of runtimes) {
    const want = JSON.stringify({ runtime, exports: expected, pageCount: 1 });
    try {
      const { stdout } = await run(command, [...args, 'consumer.mjs'], { cwd: consumer });
      if (stdout.trim() !== want) {
        failures.push(`${runtime}: expected\n  ${want}\nbut the installed packages gave\n  ${stdout.trim()}`);
      }
    } catch (error: unknown) {
      failures.push(`${runtime}: the installed packages failed to load: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  if (failures.length > 0) {
    console.error('The packed packages do not work as installed:');
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `${packages.map(({ name }) => name).join(' and ')} install from their tarballs and load under Node, Bun and Deno with the source entries' exports.`,
  );
};

await main();

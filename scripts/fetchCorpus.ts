// Downloads the govdocs1 files the corpus test reads, which are listed in packages/core/test/corpus/govdocs1/manifest.json but not committed.
// Run with: node scripts/fetchCorpus.ts

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIRECTORY = path.join(import.meta.dirname, '../packages/core/test/corpus/govdocs1');
const CACHE = path.join(DIRECTORY, '.cache');

interface Manifest {
  readonly zip: { readonly url: string; readonly sha256: string };
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const readManifest = async (): Promise<Manifest> => {
  const parsed: unknown = JSON.parse(await readFile(path.join(DIRECTORY, 'manifest.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('zip' in parsed) || !('files' in parsed)) throw new Error('manifest.json has no zip or files entry');
  const { zip, files } = parsed;
  if (typeof zip !== 'object' || zip === null || !('url' in zip) || typeof zip.url !== 'string' || !('sha256' in zip) || typeof zip.sha256 !== 'string') {
    throw new Error('manifest.json has no zip url and hash');
  }
  if (!Array.isArray(files)) throw new Error('manifest.json files is not a list');
  const listed: { name: string; sha256: string }[] = [];
  for (const entry of new Set<unknown>(files)) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('name' in entry) ||
      typeof entry.name !== 'string' ||
      !('sha256' in entry) ||
      typeof entry.sha256 !== 'string'
    ) {
      throw new Error('manifest.json lists a malformed file');
    }
    listed.push({ name: entry.name, sha256: entry.sha256 });
  }
  return { zip: { url: zip.url, sha256: zip.sha256 }, files: listed };
};

const download = async (manifest: Manifest): Promise<string> => {
  const file = path.join(CACHE, 'thread.zip');
  try {
    if (sha256(new Uint8Array(await readFile(file))) === manifest.zip.sha256) return file;
  } catch {
    // Not downloaded yet.
  }
  console.log(`downloading ${manifest.zip.url}`);
  const response = await fetch(manifest.zip.url);
  if (!response.ok) throw new Error(`download failed with status ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== manifest.zip.sha256) throw new Error('the downloaded zip does not match the SHA-256 in manifest.json');
  await writeFile(file, bytes);
  return file;
};

const main = async (): Promise<void> => {
  const manifest = await readManifest();
  await mkdir(CACHE, { recursive: true });
  const zip = await download(manifest);
  const output = path.join(CACHE, 'files');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const child = spawn('unzip', ['-q', '-j', '-o', zip, ...manifest.files.map(file => `*/${file.name}`), '-d', output], { stdio: 'inherit' });
  const closed: unknown[] = await once(child, 'close');
  if (closed[0] !== 0) throw new Error(`unzip exited ${String(closed[0])}`);
  const matches = async (file: { readonly name: string; readonly sha256: string }): Promise<boolean> => {
    const bytes = await readFile(path.join(output, file.name));
    return sha256(new Uint8Array(bytes)) === file.sha256;
  };
  const checked = await Promise.all(manifest.files.map(async file => matches(file)));
  if (checked.includes(false)) throw new Error('an extracted file does not match the SHA-256 in manifest.json');
  console.log(`extracted ${String(manifest.files.length)} files into ${output}`);
};

await main();

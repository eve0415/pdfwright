import type { PlateFile } from '../../../../scripts/plateOracle.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, stdout } from 'node:process';
import { promisify } from 'node:util';
import { inflate, zstdDecompress } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { readIllustratorExportManifest } from '../../../../scripts/illustratorExports.ts';
import { readPlate, renderPlates } from '../../../../scripts/plateOracle.ts';
import { compareDocuments } from '../compare/compareDocuments.ts';
import { pdfDate } from '../date/pdfDate.ts';
import { pt } from '../length/length.ts';
import { pdfName } from '../object/pdfObject.ts';
import { originalValue } from '../save/originalValue.ts';
import { COMPRESSED, IN_FILE } from '../xref/objectIndex.ts';

import { cmyk } from './color.ts';
import { internalsOf } from './documentInternals.ts';
import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const fixture = (name: string): URL => new URL(`../../../../tests/fixtures/illustrator-shaped/${name}.pdf`, import.meta.url);
const names = ['classic', 'object-stream', 'incremental'] as const;
const modes = ['incremental', 'full'] as const;
const changedDate = pdfDate({ year: 2026, month: 9, day: 28, hour: 1, minute: 2, second: 3, offset: { sign: '+', hours: 9, minutes: 0 } });
const plateName = new TextEncoder().encode('Varnish');
const text = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const inflateBytes = promisify(inflate);
const decompressZstd = promisify(zstdDecompress);

const pieceBytes = (document: ReturnType<typeof loadDocument>): Uint8Array => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new Error('missing document internals');
  const [page] = parts.pages;
  if (page === undefined) throw new Error('missing page');
  const original = originalValue(parts.objects.store, page.reference.objectNumber, parts.maxNesting);
  const node = original?.node.entries?.find(entry => text(entry.key) === 'PieceInfo')?.node;
  if (original === undefined || node === undefined) throw new Error('missing direct PieceInfo source bytes');
  return original.bytes.slice(node.start, node.end);
};

const pieceReferences = (document: ReturnType<typeof loadDocument>): readonly number[] => {
  const page = document.get(document.page(0).reference);
  if (page.kind !== 'dictionary') throw new Error('page is not a dictionary');
  const piece = page.entries.get(pdfName('PieceInfo').bytes);
  if (piece?.kind !== 'dictionary') throw new Error('PieceInfo is not direct');
  const illustrator = piece.entries.get(pdfName('Illustrator').bytes);
  if (illustrator?.kind !== 'reference') throw new Error('Illustrator data is not indirect');
  const data = document.get(illustrator);
  if (data.kind !== 'dictionary') throw new Error('Illustrator data is not a dictionary');
  const privateRef = data.entries.get(pdfName('Private').bytes);
  if (privateRef?.kind !== 'reference') throw new Error('Private data is not indirect');
  const privateData = document.get(privateRef);
  if (privateData.kind !== 'dictionary') throw new Error('Private data is not a dictionary');
  const streams = [...privateData.entries.entries()].flatMap(([, value]) => (value.kind === 'reference' ? [value.objectNumber] : []));
  return [illustrator.objectNumber, privateRef.objectNumber, ...streams];
};

const privateStreams = async (document: ReturnType<typeof loadDocument>): Promise<readonly Uint8Array[]> => {
  const [, reference] = pieceReferences(document);
  if (reference === undefined) throw new Error('missing Private reference');
  const privateData = document.get({ kind: 'reference', objectNumber: reference, generation: 0 });
  if (privateData.kind !== 'dictionary') throw new Error('Private data is not a dictionary');
  const entries = [...privateData.entries.entries()]
    .filter(([key]) => text(key).startsWith('AIPDFPrivateData'))
    .toSorted(([left], [right]) => Number(text(left).slice(16)) - Number(text(right).slice(16)));
  return Promise.all(
    entries.map(async ([, value]) => {
      if (value.kind !== 'reference') throw new Error('private block is not indirect');
      const stream = document.get(value);
      if (stream.kind !== 'stream') throw new Error('private block is not a stream');
      return stream.dictionary.has(pdfName('Filter').bytes) ? inflateBytes(stream.data) : stream.data;
    }),
  );
};

const assertPieceBytes = (before: ReturnType<typeof loadDocument>, after: ReturnType<typeof loadDocument>): void => {
  expect(Buffer.compare(pieceBytes(after), pieceBytes(before))).toBe(0);
  const refs = pieceReferences(before);
  expect(pieceReferences(after)).toStrictEqual(refs);
  const left = internalsOf(before);
  const right = internalsOf(after);
  if (left === undefined || right === undefined) throw new Error('missing document internals');
  for (const number of refs) {
    const original = originalValue(left.objects.store, number, left.maxNesting)?.bytes;
    const saved = originalValue(right.objects.store, number, right.maxNesting)?.bytes;
    if (original === undefined || saved === undefined) throw new Error('missing source object');
    expect(Buffer.compare(original, saved)).toBe(0);
    const reference = { kind: 'reference', objectNumber: number, generation: 0 } as const;
    const source = before.get(reference);
    const result = after.get(reference);
    if (source.kind === 'stream' && result.kind === 'stream') expect(Buffer.compare(result.data, source.data)).toBe(0);
  }
};

const edit = (source: Uint8Array, mode: (typeof modes)[number], updateDate: boolean): Uint8Array => {
  const document = loadDocument(source);
  const page = document.page(0);
  const [left, bottom, right, top] = page.boxes().TrimBox.rect;
  page.setBox('TrimBox', rect(pt(left + 2), pt(bottom + 2), pt(right - 2), pt(top - 2)));
  const separation = document.separation({ name: plateName, alternate: cmyk(0, 0, 0.2, 0) });
  page.appendContent(content => {
    content.graphicsState({ overprintFill: true, overprintMode: 1 });
    content.fillColor(separation, 1);
    content.path(draw => draw.rect(pt(120), pt(120), pt(40), pt(30)));
    content.fill('nonzero');
  });
  if (updateDate) page.setLastModified(changedDate);
  return document.save({ mode }).toBytes();
};

const checkQpdf = async (file: string): Promise<void> => {
  const child = spawn('qpdf', ['--check', file]);
  const events = await once(child, 'close');
  const closed: unknown = events[0];
  expect(closed).toBe(0);
};

const assertAcceptance = (source: Uint8Array, saved: Uint8Array, updateDate: boolean): void => {
  const before = loadDocument(source);
  const after = loadDocument(saved);
  expect([before.structure.status, after.structure.status, before.pageCount, after.pageCount]).toStrictEqual(['intact', 'intact', 1, 1]);
  expect(after.warnings).toStrictEqual([]);
  assertPieceBytes(before, after);
  const differences = compareDocuments(before, after)
    .differences.map(difference => difference.kind)
    .toSorted();
  expect(differences).toStrictEqual([...(updateDate ? ['last-modified'] : []), 'page-box', 'page-content', 'page-resources', 'page-resources'].toSorted());
  if (updateDate) expect(after.page(0).lastModified()).not.toStrictEqual(before.page(0).lastModified());
  else expect(after.page(0).lastModified()).toStrictEqual(before.page(0).lastModified());
};

const variants = [
  { name: 'classic', sections: ['classic'], pageType: IN_FILE },
  { name: 'object-stream', sections: ['stream'], pageType: COMPRESSED },
  { name: 'incremental', sections: ['classic', 'classic'], pageType: IN_FILE },
] as const;

const assertFixtureStructure = async (document: ReturnType<typeof loadDocument>, source: Uint8Array, variant: (typeof variants)[number]): Promise<void> => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new Error('missing document internals');
  const chunks = await privateStreams(document);
  expect({
    status: document.structure.status,
    pages: document.pageCount,
    warnings: document.warnings,
    piece: text(pieceBytes(document)),
    date: text(source).includes("D:20260927204901+09'00'"),
    sections: document.structure.sections.map(section => section.kind),
    pageType: parts.objects.store.index.get(3).type,
    chunked: chunks.length > 1,
  }).toStrictEqual({
    status: 'intact',
    pages: 1,
    warnings: [],
    piece: '<< /Illustrator 5 0 R >>',
    date: true,
    sections: variant.sections,
    pageType: variant.pageType,
    chunked: true,
  });
  expect(chunks.slice(0, -1).map(chunk => chunk.length)).toStrictEqual(Array.from({ length: chunks.length - 1 }, () => 65_536));
  const wrapped = Buffer.concat(chunks);
  expect(text(wrapped.subarray(0, 20))).toBe('%AI24_ZStandard_Data');
  expect([...wrapped.subarray(20, 26)]).toStrictEqual([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]);
  const decoded = await decompressZstd(wrapped.subarray(20));
  expect(decoded.length).toBeGreaterThan(2_097_152);
};

const processDifferenceOutsideMark = async (beforeFiles: readonly PlateFile[], afterFiles: readonly PlateFile[]): Promise<number> => {
  const colors = ['Cyan', 'Magenta', 'Yellow', 'Black'];
  const pairs = await Promise.all(
    colors.map(async color => {
      const key = new TextEncoder().encode(color);
      return Promise.all([readPlate(beforeFiles, key), readPlate(afterFiles, key)]);
    }),
  );
  let differences = 0;
  for (const [before, after] of pairs) {
    if (before.width !== after.width || before.height !== after.height) return Number.POSITIVE_INFINITY;
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        const outside = x < 118 || x > 162 || y < before.height - 152 || y > before.height - 118;
        differences += Number(outside && after.inkAt(x, y) !== before.inkAt(x, y));
      }
    }
  }
  return differences;
};

const acceptanceCases = names.flatMap(name => modes.flatMap(mode => [false, true].map(updateDate => ({ name, mode, updateDate }))));

const assertPlateEdit = async (source: Uint8Array, saved: Uint8Array): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-plates-'));
  try {
    const beforeFile = path.join(directory, 'before.pdf');
    const afterFile = path.join(directory, 'after.pdf');
    await Promise.all([writeFile(beforeFile, source), writeFile(afterFile, saved)]);
    const [beforePlates, afterPlates] = await Promise.all([
      renderPlates(beforeFile, path.join(directory, 'before'), true),
      renderPlates(afterFile, path.join(directory, 'after'), true),
    ]);
    const varnish = await readPlate(afterPlates, plateName);
    const centerY = Math.max(0, Math.floor(varnish.height - 130));
    expect(varnish.inkAt(130, centerY)).toBeGreaterThan(0);
    await expect(processDifferenceOutsideMark(beforePlates, afterPlates)).resolves.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('synthetic Illustrator-shaped acceptance', () => {
  it.each(variants)('loads the $name fixture with its observed structure', async variant => {
    const source = await readFile(fixture(variant.name));
    const document = loadDocument(source);
    expect(document.pageCount).toBe(1);
    await assertFixtureStructure(document, source, variant);
  });

  it.each(acceptanceCases)('$name: $mode save with updateDate=$updateDate keeps Illustrator data byte-identical', async ({ name, mode, updateDate }) => {
    const source = await readFile(fixture(name));
    const saved = edit(source, mode, updateDate);
    expect(saved.length).toBeGreaterThan(source.length / 2);
    assertAcceptance(source, saved, updateDate);
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-illustrator-acceptance-'));
    try {
      const file = path.join(directory, 'edited.pdf');
      await writeFile(file, saved);
      await checkQpdf(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(names)('renders process plates outside the added mark and adds Varnish on %s', async name => {
    const source = await readFile(fixture(name));
    const saved = edit(source, 'incremental', false);
    expect(saved.length).toBeGreaterThan(0);
    await assertPlateEdit(source, saved);
  });
});

const realExports = env['PDFWRIGHT_ADOBE_EXPORTS_DIR'];
if (realExports === undefined) stdout.write('Local Adobe export acceptance not run: PDFWRIGHT_ADOBE_EXPORTS_DIR is unset.\n');

const localSource = async (file: string): Promise<Uint8Array> => {
  if (realExports === undefined) throw new Error('PDFWRIGHT_ADOBE_EXPORTS_DIR is unset');
  return readFile(path.join(realExports, file));
};

const localManifest = realExports === undefined ? undefined : await readIllustratorExportManifest(realExports);
const localFiles = localManifest?.acceptance ?? [];
const localCases = localFiles.flatMap(({ label, file }) => modes.flatMap(mode => [false, true].map(updateDate => ({ label, file, mode, updateDate }))));

describe('local Adobe export acceptance', () => {
  it.skipIf(realExports === undefined)('selects local acceptance exports', () => {
    expect(localFiles.length).toBeGreaterThan(0);
  });

  it.skipIf(realExports === undefined).each(localCases)(
    '$label: $mode save with updateDate=$updateDate preserves native data',
    async ({ file, mode, updateDate }) => {
      const source = await localSource(file);
      const saved = edit(source, mode, updateDate);
      expect(saved.length).toBeGreaterThan(source.length / 2);
      assertAcceptance(source, saved, updateDate);
      const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-local-acceptance-'));
      try {
        const output = path.join(directory, 'edited.pdf');
        await writeFile(output, saved);
        await checkQpdf(output);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(realExports === undefined).each(localFiles)('$label renders unchanged process plates outside the new mark', async ({ file }) => {
    const source = await localSource(file);
    const saved = edit(source, 'incremental', false);
    expect(saved.length).toBeGreaterThan(0);
    await assertPlateEdit(source, saved);
  });
});

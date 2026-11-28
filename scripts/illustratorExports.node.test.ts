import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readIllustratorExportManifest } from './illustratorExports.ts';

// The export directory is named `exports` inside a temporary parent, so a sibling such as `exports-evil` shares its name as a prefix.
const inExportDirectory = async <T>(run: (root: string) => Promise<T>, name = 'exports'): Promise<T> => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pdfwright-exports-'));
  const root = path.join(parent, name);
  try {
    await mkdir(root);
    return await run(root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
};

const writeManifest = async (root: string, manifest: string): Promise<void> => {
  await writeFile(path.join(root, 'illustrator-samples.json'), manifest);
};

const readManifestText = (manifest: string): ReturnType<typeof readIllustratorExportManifest> =>
  inExportDirectory(async root => {
    await writeManifest(root, manifest);
    return readIllustratorExportManifest(root);
  });

const readManifest = (manifest: unknown): ReturnType<typeof readIllustratorExportManifest> => readManifestText(JSON.stringify(manifest));

const sample = { file: 'first.pdf', blocks: 3, lastLength: 12, layers: 5, rasters: 2, widthMm: 100, heightMm: 70, paint: [1, 2, 3, 4, 5] } as const;
const second = { file: 'second.pdf', blocks: 7, lastLength: 40, layers: 6, rasters: 1, widthMm: 210, heightMm: 297, paint: [6, 7, 8, 9, 10] } as const;
interface SampleOverrides {
  readonly file?: string | number;
  readonly paint?: ReadonlyArray<number | string | null> | string;
  readonly widthMm?: string;
}

const withSample = (overrides: SampleOverrides) => ({ samples: [{ ...sample, ...overrides }], ladderSample: 0, acceptance: [] });
const withoutField = (field: string) => ({
  samples: [Object.fromEntries(Object.entries(sample).filter(([name]) => name !== field))],
  ladderSample: 0,
  acceptance: [],
});

const insideRefusal = (error: unknown): undefined => {
  if (!(error instanceof Error) || !error.message.includes('inside the selected directory')) {
    throw error;
  }
  return undefined;
};

describe('local Illustrator export manifest', () => {
  it('reads every sample field, the ladder sample, the acceptance list and the lock sample', async () => {
    await expect(
      readManifest({
        samples: [sample, second],
        ladderSample: 1,
        acceptance: [
          { label: 'native', file: 'native.ai' },
          { label: 'saved', file: 'saved.pdf' },
        ],
        lockSample: 'lock.pdf',
      }),
    ).resolves.toStrictEqual({
      samples: [sample, second],
      ladderSample: 1,
      acceptance: [
        { label: 'native', file: 'native.ai' },
        { label: 'saved', file: 'saved.pdf' },
      ],
      lockSample: 'lock.pdf',
    });
  });

  it('omits the lock sample when the manifest names none', async () => {
    const manifest = await readManifest({ samples: [sample], ladderSample: 0, acceptance: [] });
    expect('lockSample' in manifest).toBe(false);
  });

  it.each([
    { case: 'an upper-case extension', file: 'SAMPLE.PDF', expected: 'SAMPLE.PDF' },
    { case: 'a path through a subdirectory and back', file: 'sub/../a.pdf', expected: 'a.pdf' },
    { case: 'a path out of the directory and back in', file: '../exports/a.pdf', expected: 'a.pdf' },
    { case: 'a nested file', file: 'sub/a.pdf', expected: path.join('sub', 'a.pdf') },
  ])('accepts a sample file given as $case', async ({ file, expected }) => {
    await expect(readManifest(withSample({ file }))).resolves.toMatchObject({ samples: [{ file: expected }] });
  });

  it.each([
    { case: 'a parent-directory path', file: '../outside.pdf' },
    { case: 'a sibling directory that shares the name as a prefix', file: '../exports-evil/a.pdf' },
    { case: 'an absolute path', file: '/etc/a.pdf' },
    { case: 'an Illustrator file', file: 'sample.ai' },
    { case: 'a text file', file: 'notes.txt' },
  ])('refuses a sample file given as $case', async ({ file }) => {
    await expect(readManifest(withSample({ file }))).rejects.toThrow(/inside the selected directory/u);
  });

  // A directory named like a PDF passes the extension check, so only the rule that the file lies below the directory refuses it.
  it.each(['', '.', '../exports.pdf'])('refuses the directory itself, given as %j, even when its name ends in .pdf', async file => {
    const reading = inExportDirectory(async root => {
      await writeManifest(root, JSON.stringify(withSample({ file })));
      return readIllustratorExportManifest(root);
    }, 'exports.pdf');
    await expect(reading).rejects.toThrow(/inside the selected directory/u);
  });

  it.each([
    { file: 'native.ai', expected: 'native.ai' },
    { file: 'NATIVE.AI', expected: 'NATIVE.AI' },
    { file: 'saved.pdf', expected: 'saved.pdf' },
  ])('accepts the acceptance file $file', async ({ file, expected }) => {
    await expect(readManifest({ samples: [sample], ladderSample: 0, acceptance: [{ label: 'x', file }] })).resolves.toMatchObject({
      acceptance: [{ label: 'x', file: expected }],
    });
  });

  it.each(['notes.txt', '../native.ai'])('refuses the acceptance file %s', async file => {
    await expect(readManifest({ samples: [sample], ladderSample: 0, acceptance: [{ label: 'x', file }] })).rejects.toThrow(/inside the selected directory/u);
  });

  it.each([
    { case: 'four', paint: [1, 2, 3, 4] },
    { case: 'six', paint: [1, 2, 3, 4, 5, 6] },
    { case: 'a string of', paint: '12345' },
  ])('refuses $case paint counts', async ({ paint }) => {
    await expect(readManifest(withSample({ paint }))).rejects.toThrow(/invalid Illustrator paint counts/u);
  });

  it.each([
    { case: 'null', paint: [1, 2, null, 4, 5] },
    { case: 'a string', paint: [1, '1', 3, 4, 5] },
  ])('refuses a paint count that is $case', async ({ paint }) => {
    const reading = readManifest(withSample({ paint }));
    await expect(reading).rejects.toThrow(TypeError);
    await expect(reading).rejects.toThrow(/paint count$/u);
  });

  it.each(['1e999', '-1e999'])('refuses a paint count of %s, which JSON reads as an infinity', async infinity => {
    const manifest = JSON.stringify(withSample({ paint: [1, 2, 0, 4, 5] })).replace('[1,2,0,4,5]', `[1,2,${infinity},4,5]`);
    const reading = readManifestText(manifest);
    await expect(reading).rejects.toThrow(TypeError);
    await expect(reading).rejects.toThrow(/paint count$/u);
  });

  it.each([
    { field: 'blocks', name: 'block count' },
    { field: 'lastLength', name: 'last block length' },
    { field: 'layers', name: 'layer count' },
    { field: 'rasters', name: 'raster count' },
    { field: 'widthMm', name: 'width' },
    { field: 'heightMm', name: 'height' },
  ])('refuses a sample without $field and names the $name', async ({ field, name }) => {
    const reading = readManifest(withoutField(field));
    await expect(reading).rejects.toThrow(TypeError);
    await expect(reading).rejects.toThrow(new RegExp(`export ${name}$`, 'u'));
  });

  it('refuses a sample whose width is a string', async () => {
    await expect(readManifest(withSample({ widthMm: '100' }))).rejects.toThrow(/export width$/u);
  });

  it.each([
    { case: 'below the first sample', ladderSample: -1 },
    { case: 'at the sample count', ladderSample: 2 },
    { case: 'a fraction', ladderSample: 0.5 },
    { case: 'a string', ladderSample: '0' },
  ])('refuses a ladder sample $case', async ({ ladderSample }) => {
    await expect(readManifest({ samples: [sample, second], ladderSample, acceptance: [] })).rejects.toThrow(/invalid Illustrator export ladder sample/u);
  });

  it('accepts the last sample as the ladder sample', async () => {
    await expect(readManifest({ samples: [sample, second], ladderSample: 1, acceptance: [] })).resolves.toMatchObject({ ladderSample: 1 });
  });

  it('refuses a ladder sample when there are no samples', async () => {
    await expect(readManifest({ samples: [], ladderSample: 0, acceptance: [] })).rejects.toThrow(/invalid Illustrator export ladder sample/u);
  });

  it.each([
    { case: 'a number', lockSample: 5, message: /invalid Illustrator lock sample/u },
    { case: 'null', lockSample: null, message: /invalid Illustrator lock sample/u },
    { case: 'outside the directory', lockSample: '../x.pdf', message: /inside the selected directory/u },
    { case: 'an Illustrator file', lockSample: 'lock.ai', message: /inside the selected directory/u },
  ])('refuses a lock sample that is $case', async ({ lockSample, message }) => {
    await expect(readManifest({ samples: [sample], ladderSample: 0, acceptance: [], lockSample })).rejects.toThrow(message);
  });

  it.each([
    { case: 'an array', manifest: [] },
    { case: 'null', manifest: null },
    { case: 'without samples', manifest: { ladderSample: 0, acceptance: [] } },
    { case: 'with samples that are not an array', manifest: { samples: {}, ladderSample: 0, acceptance: [] } },
    { case: 'without a ladder sample', manifest: { samples: [sample], acceptance: [] } },
    { case: 'without acceptance', manifest: { samples: [sample], ladderSample: 0 } },
    { case: 'with acceptance that is not an array', manifest: { samples: [sample], ladderSample: 0, acceptance: 'x.pdf' } },
  ])('refuses a manifest that is $case', async ({ manifest }) => {
    await expect(readManifest(manifest)).rejects.toThrow(/invalid Illustrator export manifest/u);
  });

  it('refuses a sample whose file is not a string', async () => {
    await expect(readManifest(withSample({ file: 5 }))).rejects.toThrow(/invalid Illustrator export sample$/u);
  });

  it.each([
    { case: 'without a label', entry: { file: 'a.pdf' } },
    { case: 'whose file is not a string', entry: { label: 'x', file: 5 } },
  ])('refuses an acceptance entry $case', async ({ entry }) => {
    await expect(readManifest({ samples: [sample], ladderSample: 0, acceptance: [entry] })).rejects.toThrow(/invalid Illustrator export acceptance entry$/u);
  });

  it('refuses a manifest that is not JSON', async () => {
    await expect(readManifestText('{"samples": [')).rejects.toThrow(SyntaxError);
  });

  it('reports a missing manifest as a missing file', async () => {
    await expect(inExportDirectory(async root => readIllustratorExportManifest(root))).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  describe('properties', () => {
    const segment = fc.constantFrom('..', '.', '', 'sub', 'exports', 'exports-evil', 'a.pdf', 'b.ai', 'C.PDF', 'd.txt', 'e');
    const relative = fc
      .tuple(fc.boolean(), fc.array(segment, { minLength: 1, maxLength: 5 }))
      .map(([absolute, parts]) => `${absolute ? '/' : ''}${parts.join('/')}`);
    const extensions = new Set(['.pdf', '.ai']);

    it('returns a path inside the directory that names the same file and reads back unchanged, or refuses one outside it', async () => {
      await fc.assert(
        fc.asyncProperty(relative, async file =>
          inExportDirectory(async root => {
            const target = path.resolve(root, file);
            const fromRoot = path.relative(root, target);
            const inside = fromRoot !== '' && !path.isAbsolute(fromRoot) && fromRoot.split(path.sep)[0] !== '..';
            const allowed = inside && extensions.has(path.extname(target).toLowerCase());
            const read = async (name: string): Promise<string | undefined> => {
              await writeManifest(root, JSON.stringify({ samples: [sample], ladderSample: 0, acceptance: [{ label: 'x', file: name }] }));
              return readIllustratorExportManifest(root).then(manifest => manifest.acceptance[0]?.file, insideRefusal);
            };
            const returned = await read(file);
            expect(returned !== undefined).toBe(allowed);
            expect(returned === undefined ? target : path.resolve(root, returned)).toBe(target);
            const reread = returned === undefined ? undefined : await read(returned);
            expect(reread).toBe(returned);
          }),
        ),
      );
    });
  });
});

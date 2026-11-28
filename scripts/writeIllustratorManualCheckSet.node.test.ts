import type { ContainerFacts } from '../packages/illustrator/src/testing/readIllustratorPdf.ts';

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, execPath, stdout } from 'node:process';
import { zstdDecompressSync } from 'node:zlib';

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { createDocument, loadDocument, pdfName } from '../packages/core/src/index.ts';
import { attachPrivateData } from '../packages/illustrator/src/container/privateData.ts';
import { writeNative } from '../packages/illustrator/src/native/writeNative.ts';
import { drawPage } from '../packages/illustrator/src/page/drawPage.ts';
import { manualCheckModel } from '../packages/illustrator/src/testing/manualCheckModel.ts';
import { readIllustratorContainer, readIllustratorPdf } from '../packages/illustrator/src/testing/readIllustratorPdf.ts';

import { readIllustratorExportManifest } from './illustratorExports.ts';
import { contentSizeFrame, writeDiagnosticLadder, writeManualCheckSet } from './writeIllustratorManualCheckSet.ts';

const exportsDirectory = env['PDFWRIGHT_ADOBE_EXPORTS_DIR'];
if (exportsDirectory === undefined) {
  stdout.write('Local Illustrator transplant ladder not run: PDFWRIGHT_ADOBE_EXPORTS_DIR is unset.\n');
}
const manifest = exportsDirectory === undefined ? undefined : await readIllustratorExportManifest(exportsDirectory);
const ladderSource = manifest?.samples[manifest.ladderSample]?.file ?? '';

const repository = path.resolve(import.meta.dirname, '..');
const script = path.join(import.meta.dirname, 'writeIllustratorManualCheckSet.ts');
// Native data is handled as one character per byte, so offsets in the text are offsets in the bytes.
const latin1 = { decode: (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1') };

const inTemporaryDirectory = async <T>(prefix: string, run: (directory: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const withManualCheckSet = async <T>(run: (directory: string, names: ReadonlyArray<string>) => Promise<T>): Promise<T> =>
  inTemporaryDirectory('pdfwright-illustrator-manual-', async directory => run(directory, await writeManualCheckSet(directory)));

const container = async (directory: string, name: string): Promise<ContainerFacts> => readIllustratorContainer(await readFile(path.join(directory, name)));
const total = (lengths: ReadonlyArray<number>): number => lengths.reduce((sum, length) => sum + length, 0);
const occurrences = (text: string, part: string): number => text.split(part).length - 1;

// The wrapper Illustrator writes before the Zstandard frame in the joined private-data blocks.
const WRAPPER_LENGTH = '%AI24_ZStandard_Data'.length;
const RAW_BLOCK_SIZE = 128 * 1024;

describe('illustrator manual-check file set', () => {
  it('writes the PDFs and a checklist that names each of them', async () => {
    await withManualCheckSet(async (directory, names) => {
      await expect(readdir(directory)).resolves.toStrictEqual([...names, 'CHECKLIST.md']);
      const standard = await readFile(path.join(directory, '01-standard.pdf'));
      expect(new TextDecoder().decode(standard.subarray(0, 8))).toBe('%PDF-1.7');
      const checklist = await readFile(path.join(directory, 'CHECKLIST.md'), 'utf8');
      const listed = [...checklist.matchAll(/^- `([^`]+)`:/gmu)].map(match => match[1]);
      expect(listed).toStrictEqual(names);
    });
  });

  it.each([
    { case: 'the repository root', directory: repository },
    { case: 'a directory inside the repository', directory: path.join(repository, 'tmp-manual') },
    { case: 'a relative path inside the repository', directory: path.relative(process.cwd(), path.join(repository, 'scripts', 'tmp-manual')) },
  ])('refuses $case as the output directory', async ({ directory }) => {
    await expect(writeManualCheckSet(directory)).rejects.toThrow(/outside the repository/u);
  });

  it('accepts a sibling of the repository whose name starts with the repository name', async () => {
    const sibling = `${repository}-manual-check-${String(process.pid)}`;
    try {
      await expect(writeManualCheckSet(sibling)).resolves.toContain('01-standard.pdf');
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('writes the locked variant', async () => {
    await withManualCheckSet(async directory => {
      const locked = readIllustratorPdf(await readFile(path.join(directory, '07-locked.pdf')));
      expect(locked.document.layers.slice(-3)).toMatchObject([
        { name: 'Locked layer', locked: true },
        { name: 'Locked object', locked: false, items: [{ locked: true }] },
        { name: 'Locked and hidden', locked: true, visible: false },
      ]);
    });
  });

  it('writes the compound-path variant with its clipped raster', async () => {
    await withManualCheckSet(async directory => {
      const compound = readIllustratorPdf(await readFile(path.join(directory, '08-compound.pdf')));
      expect(compound.document.layers).toMatchObject([
        { name: 'Even-odd clip', items: [{ kind: 'clipGroup', clip: { fillRule: 'evenodd' }, items: [{ kind: 'raster' }] }] },
        { name: 'Compound fills', items: [{ geometry: { fillRule: 'nonzero' } }, { geometry: { fillRule: 'evenodd' } }] },
        { name: 'Compound die', items: [{ kind: 'path', geometry: { fillRule: 'nonzero' } }] },
      ]);
    });
  });

  it('keeps identical native artwork across compression variants that differ in their frames', async () => {
    await withManualCheckSet(async directory => {
      const [standard, contentSize, rawBlocks] = await Promise.all(
        ['01-standard.pdf', '02-content-size.pdf', '04-raw-blocks.pdf'].map(async name => container(directory, name)),
      );
      if (standard === undefined || contentSize === undefined || rawBlocks === undefined) {
        throw new Error('a compression variant is missing');
      }
      expect([contentSize.native, rawBlocks.native]).toStrictEqual([standard.native, standard.native]);
      // RFC 8878, 3.1.1.1.1: 0xa0 sets a 4-byte Frame_Content_Size and the Single_Segment_flag, which drops the 1-byte Window_Descriptor.
      expect([standard.frameHeaderDescriptor, contentSize.frameHeaderDescriptor]).toStrictEqual([0, 0xa0]);
      expect([standard.windowDescriptor, contentSize.windowDescriptor]).toStrictEqual([0x58, undefined]);
      expect(total(contentSize.blockLengths)).toBe(total(standard.blockLengths) + 3);
      // RFC 8878, 3.1.1 and 3.1.1.2: a 6-byte header, then one 3-byte header per raw block of at most 128 KiB, each carrying its bytes unchanged.
      const length = standard.native.length;
      expect(total(rawBlocks.blockLengths)).toBe(WRAPPER_LENGTH + 6 + 3 * Math.ceil(length / RAW_BLOCK_SIZE) + length);
      expect(total(standard.blockLengths)).toBeLessThan(total(rawBlocks.blockLengths));
    });
  });

  it('writes the top-left variant with the top-left native origin', async () => {
    await withManualCheckSet(async directory => {
      const origins = await Promise.all(
        ['01-standard.pdf', '05-top-left.pdf'].map(async name => readIllustratorPdf(await readFile(path.join(directory, name))).nativeOrigin),
      );
      expect(origins).toStrictEqual(['artboard-bottom-left', 'artboard-top-left']);
    });
  });

  it('writes the unequal-dates variant as an incremental update of the standard file with a newer page date', async () => {
    await withManualCheckSet(async directory => {
      const standardBytes = await readFile(path.join(directory, '01-standard.pdf'));
      const unequalBytes = await readFile(path.join(directory, '06-unequal-dates.pdf'));
      const [standard, unequal] = [readIllustratorContainer(standardBytes), readIllustratorContainer(unequalBytes)];
      expect(standard.pageDate).toStrictEqual(standard.applicationDate);
      expect(unequal.applicationDate).toStrictEqual(standard.applicationDate);
      expect(unequal.pageDate).not.toStrictEqual(unequal.applicationDate);
      // ISO 32000-1:2008, 7.5.6: an incremental update appends to the original file and leaves its bytes unchanged.
      expect(unequalBytes.length).toBeGreaterThan(standardBytes.length);
      expect(unequalBytes.subarray(0, standardBytes.length)).toStrictEqual(standardBytes);
    });
  });
});

interface FrameFacts {
  readonly magic: Uint8Array;
  readonly descriptor: number | undefined;
  readonly contentSize: number;
  readonly decoded: Uint8Array;
}

const frameFacts = (native: Uint8Array): FrameFacts => {
  const frame = contentSizeFrame(native);
  return {
    magic: frame.subarray(0, 4),
    descriptor: frame.at(4),
    contentSize: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(5, true),
    decoded: new Uint8Array(zstdDecompressSync(frame)),
  };
};

describe('content-size frame', () => {
  // RFC 8878, 3.1.1: the magic number 0xFD2FB528 is stored little-endian.
  const magic = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd);

  it.each([
    { case: 'the manual-check native data', native: writeNative(manualCheckModel()).bytes },
    { case: 'no data', native: new Uint8Array(0) },
    { case: 'data longer than one block', native: Uint8Array.from({ length: 300_000 }, (_, index) => index % 251) },
  ])('declares the content size of $case and decodes to it', ({ native }) => {
    expect(frameFacts(native)).toStrictEqual({ magic, descriptor: 0xa0, contentSize: native.length, decoded: native });
  });

  describe('properties', () => {
    const bytes = fc.oneof(
      fc.uint8Array({ maxLength: 4096 }),
      fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 4096 }).map(values => Uint8Array.from(values)),
    );

    it('decodes to the input and declares its length', () => {
      fc.assert(
        fc.property(bytes, native => {
          expect(frameFacts(native)).toStrictEqual({ magic, descriptor: 0xa0, contentSize: native.length, decoded: native });
        }),
      );
    });
  });
});

// A stand-in for an Illustrator export: the generated native data with every structure the diagnostic ladder transplants planted in it.
const planted = {
  plugins: '%AI5_Begin_NonPrinting\rsynthetic plugin groups\r%AI5_End_NonPrinting--\r',
  artStyles: '%AI5_Begin_NonPrinting\rsynthetic art styles\r%AI5_End_NonPrinting--\r',
  styleList: '%AI5_Begin_NonPrinting\rsynthetic art style list\r%AI5_End_NonPrinting--\r',
  symbolList: '%AI5_Begin_NonPrinting\rsynthetic symbol list\r%AI5_End_NonPrinting--\r',
  registration: '1 1 1 1 ([Registration]) 0 1 synthetic Pc\r',
  registrationComment: '%%CMYKProcessColor: 1 1 1 1 ([Registration])\r',
  textDocument: '%AI11_BeginTextDocument\r/SyntheticText 1 2 /RulerOrigin ,\r%AI11_EndTextDocument\r',
  documentData: '%_/SyntheticSourceData ,\r',
  creator: '%%Creator: Synthetic Illustrator\r',
} as const;

const plant = (native: string, target: string, addition: string): string => {
  if (!native.includes(target)) {
    throw new Error(`the generated native data has no ${target}`);
  }
  return native.replace(target, `${target}${addition}`);
};

const syntheticExportNative = (): string => {
  let native = latin1.decode(writeNative(manualCheckModel()).bytes);
  native = native.replace('%%Creator: @pdfwright/illustrator\r', planted.creator);
  native = plant(native, '%%BeginSetup\r', `${planted.plugins}${planted.artStyles}${planted.styleList}${planted.symbolList}`);
  native = plant(native, '%AI5_BeginPalette\r', planted.registration);
  native = native.replace('%%EndComments\r', `${planted.registrationComment}%%EndComments\r`);
  native = native.replace('%%EndSetup\r', `${planted.textDocument}%%EndSetup\r`);
  return plant(native, '%AI9_BeginDocumentData\r', planted.documentData);
};

const exportPdf = (native: string): Uint8Array => {
  const model = manualCheckModel();
  const document = createDocument();
  const page = drawPage(document, model);
  const bytes = Buffer.from(native, 'latin1');
  const endComments = '%%EndComments\r';
  attachPrivateData(document, page, {
    native: { bytes, metaDataLength: native.indexOf(endComments) + endComments.length },
    lastModified: model.lastModified,
    options: { compression: 'zstandard' },
  });
  return document.save().toBytes();
};

const diagnosticNames = [
  'diagnostic-01-plugin-groups.pdf',
  'diagnostic-02-art-styles.pdf',
  'diagnostic-03-art-style-list.pdf',
  'diagnostic-04-symbol-list.pdf',
  'diagnostic-05-registration.pdf',
  'diagnostic-06-text-document.pdf',
  'diagnostic-07-document-data.pdf',
  'diagnostic-08-creator.pdf',
  'diagnostic-09-indirect-dictionary.pdf',
] as const;

interface LadderStep {
  readonly nonPrinting: number;
  readonly registration: boolean;
  readonly textDocument: boolean;
  readonly creator: string;
  readonly illustratorPieceKind: string | undefined;
}

// Facts that hold for any export the ladder starts from, read back from each written file.
const ladderStep = (pdf: Uint8Array): LadderStep => {
  const native = latin1.decode(readIllustratorContainer(pdf).native);
  const loaded = loadDocument(pdf);
  const pageObject = loaded.get(loaded.page(0).reference);
  // ISO 32000-1:2008, 14.5: the page's PieceInfo dictionary holds the Illustrator page-piece dictionary.
  const pieceInfo = pageObject.kind === 'dictionary' ? pageObject.entries.get(pdfName('PieceInfo').bytes) : undefined;
  return {
    nonPrinting: occurrences(native, '%AI5_Begin_NonPrinting\r'),
    registration: native.includes('%%CMYKProcessColor:'),
    textDocument: native.includes('%AI11_BeginTextDocument\r'),
    creator: /%%Creator:[^\r]*\r/u.exec(native)?.[0] ?? '',
    illustratorPieceKind: pieceInfo?.kind === 'dictionary' ? pieceInfo.entries.get(pdfName('Illustrator').bytes)?.kind : undefined,
  };
};

const expectedSteps = (sourceCreator: string): Array<LadderStep> => {
  const generated = '%%Creator: @pdfwright/illustrator\r';
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map(step => ({
    nonPrinting: Math.min(step, 4),
    registration: step >= 5,
    textDocument: step >= 6,
    creator: step >= 8 ? sourceCreator : generated,
    illustratorPieceKind: step === 9 ? 'reference' : 'dictionary',
  }));
};

const readLadder = async (directory: string): Promise<Array<Uint8Array>> =>
  Promise.all(diagnosticNames.map(async name => readFile(path.join(directory, name))));

describe('illustrator diagnostic ladder', () => {
  it('adds one transplanted structure per file, cumulatively, from the export it reads', async () => {
    await inTemporaryDirectory('pdfwright-illustrator-exports-', async root => {
      await writeFile(path.join(root, 'source.pdf'), exportPdf(syntheticExportNative()));
      vi.stubEnv('PDFWRIGHT_ADOBE_EXPORTS_DIR', root);
      const output = path.join(root, 'ladder');
      await expect(writeDiagnosticLadder(output, 'source.pdf')).resolves.toStrictEqual(diagnosticNames);
      const files = await readLadder(output);
      expect(files.map(ladderStep)).toStrictEqual(expectedSteps(planted.creator));
      const additions = [
        [planted.plugins],
        [planted.artStyles],
        [planted.styleList],
        [planted.symbolList],
        [planted.registration, planted.registrationComment],
        ['/SyntheticText '],
        [planted.documentData],
        [planted.creator],
        [],
      ];
      const present = files.map(pdf => {
        const native = latin1.decode(readIllustratorContainer(pdf).native);
        return additions.map(parts => parts.length > 0 && parts.every(part => native.includes(part)));
      });
      expect(present).toStrictEqual(diagnosticNames.map((_, file) => additions.map((parts, step) => parts.length > 0 && step <= file)));
      const rewritten = files.slice(5).map(pdf => latin1.decode(readIllustratorContainer(pdf).native));
      for (const native of rewritten) {
        expect(native).not.toContain('1 2 /RulerOrigin ,');
        expect(native).toMatch(/\/SyntheticText \d+(?:\.\d+)? \d+(?:\.\d+)? \/RulerOrigin ,/u);
      }
    });
  });

  it.each([
    { case: 'no Setup section', native: (): string => syntheticExportNative().replace('%%BeginSetup\r', ''), marker: '%%BeginSetup' },
    { case: 'no NonPrinting blocks', native: (): string => latin1.decode(writeNative(manualCheckModel()).bytes), marker: '%AI5_Begin_NonPrinting' },
    { case: 'no text document', native: (): string => syntheticExportNative().replace(planted.textDocument, ''), marker: '%AI11_BeginTextDocument' },
  ])('refuses an export with $case and names the missing marker', async ({ native, marker }) => {
    await inTemporaryDirectory('pdfwright-illustrator-exports-', async root => {
      await writeFile(path.join(root, 'source.pdf'), exportPdf(native()));
      vi.stubEnv('PDFWRIGHT_ADOBE_EXPORTS_DIR', root);
      await expect(writeDiagnosticLadder(path.join(root, 'ladder'), 'source.pdf')).rejects.toThrow(`diagnostic marker is absent: ${marker}`);
    });
  });

  it('requires the exports directory variable', async () => {
    vi.stubEnv('PDFWRIGHT_ADOBE_EXPORTS_DIR', undefined);
    await inTemporaryDirectory('pdfwright-illustrator-ladder-', async directory => {
      await expect(writeDiagnosticLadder(directory, 'source.pdf')).rejects.toThrow(/PDFWRIGHT_ADOBE_EXPORTS_DIR is required/u);
    });
  });

  it.each([
    { case: 'a parent-directory path', relative: '../source.pdf' },
    { case: 'a sibling directory that shares the name as a prefix', relative: '../exports-evil/source.pdf' },
    { case: 'an absolute path', relative: '/etc/source.pdf' },
    { case: 'the directory itself', relative: '' },
  ])('refuses an export given as $case', async ({ relative }) => {
    await inTemporaryDirectory('pdfwright-illustrator-exports-', async parent => {
      const root = path.join(parent, 'exports');
      await mkdir(root);
      vi.stubEnv('PDFWRIGHT_ADOBE_EXPORTS_DIR', root);
      await expect(writeDiagnosticLadder(path.join(parent, 'ladder'), relative)).rejects.toThrow(/inside PDFWRIGHT_ADOBE_EXPORTS_DIR/u);
    });
  });

  it.each([
    { case: 'the repository root', directory: repository },
    { case: 'a directory inside the repository', directory: path.join(repository, 'tmp-diagnostic') },
  ])('refuses $case as the output directory', async ({ directory }) => {
    await inTemporaryDirectory('pdfwright-illustrator-exports-', async root => {
      vi.stubEnv('PDFWRIGHT_ADOBE_EXPORTS_DIR', root);
      await expect(writeDiagnosticLadder(directory, 'source.pdf')).rejects.toThrow(/outside the repository/u);
    });
  });

  it.skipIf(exportsDirectory === undefined)('writes diagnostic transplants of the local export to an external directory', async () => {
    await inTemporaryDirectory('pdfwright-illustrator-ladder-', async directory => {
      const sourceNative = latin1.decode(readIllustratorContainer(await readFile(path.resolve(exportsDirectory ?? '', ladderSource))).native);
      const sourceCreator = /%%Creator:[^\r]*\r/u.exec(sourceNative)?.[0] ?? '';
      await expect(writeDiagnosticLadder(directory, ladderSource)).resolves.toStrictEqual(diagnosticNames);
      const files = await readLadder(directory);
      expect(files.map(ladderStep)).toStrictEqual(expectedSteps(sourceCreator));
    });
  });
});

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = (directory: string | undefined, ...rest: ReadonlyArray<string>): CommandResult => {
  const result = spawnSync(execPath, [script, ...(directory === undefined ? [] : [directory]), ...rest], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('manual-check command line', () => {
  it('writes the file set and prints the output directory', async () => {
    await inTemporaryDirectory('pdfwright-illustrator-manual-', async directory => {
      const output = path.join(directory, 'set');
      expect(runCommand(output)).toMatchObject({ status: 0, stdout: `${output}\n` });
      await expect(readdir(output)).resolves.toContain('CHECKLIST.md');
    });
  });

  it('asks for an output directory when none is given', () => {
    const result = runCommand(undefined);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('provide an output directory');
  });

  it.each([
    { case: 'an unknown flag', rest: ['--transplant'] },
    { case: 'an unknown flag with a path', rest: ['--transplant', 'source.pdf'] },
    { case: 'the transplant flag without a path', rest: ['--transplant-from'] },
  ])('refuses $case', async ({ rest }) => {
    await inTemporaryDirectory('pdfwright-illustrator-manual-', directory => {
      const result = runCommand(path.join(directory, 'set'), ...rest);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('use --transplant-from');
      return Promise.resolve();
    });
  });
});

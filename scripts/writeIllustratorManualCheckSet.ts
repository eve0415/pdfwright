import type { NativeData, PrivateDataOptions } from '../packages/illustrator/src/container/privateData.ts';
import type { Coordinate, IllustratorDocument } from '../packages/illustrator/src/model/illustratorDocument.ts';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';
import { pathToFileURL } from 'node:url';

import { createDocument, loadDocument, pdfDate, pdfName } from '../packages/core/src/index.ts';
import { attachPrivateData } from '../packages/illustrator/src/container/privateData.ts';
import { formatNativeNumber } from '../packages/illustrator/src/native/formatNativeNumber.ts';
import { writeNative } from '../packages/illustrator/src/native/writeNative.ts';
import { drawPage } from '../packages/illustrator/src/page/drawPage.ts';
import { manualCheckModel } from '../packages/illustrator/src/testing/manualCheckModel.ts';
import { readIllustratorContainer } from '../packages/illustrator/src/testing/readIllustratorPdf.ts';
import { writeIllustratorPdf } from '../packages/illustrator/src/writeIllustratorPdf.ts';
import { encodeZstandardFrame } from '../packages/illustrator/src/zstd/frame.ts';

const FILENAMES = ['01-standard.pdf', '02-content-size.pdf', '03-zlib-wrapper.pdf', '04-raw-blocks.pdf', '05-top-left.pdf', '06-unequal-dates.pdf'] as const;
const CHECKLIST = `# Illustrator 30.8.2 manual check

These files have not been open-tested in Illustrator.

- \`01-standard.pdf\`: Check the six editable layers in panel order: Die (outer), Spot shapes, White, Primer 30%, Design, 非表示. Check that 非表示 is hidden, Primer 30% has 30% opacity, the artboard is 100 × 70 mm with 3 mm bleed, and the artwork is positioned on the artboard. The die strokes and the fill-plus-stroke rectangle should each be one path. Check the Cut, White, Primer and ＣＵＴ spot swatches, embedded transparent rasters, clipping, and Overprint Fill on the small Cut rectangle.
- \`02-content-size.pdf\`: Check that all six layers remain editable with a frame content size.
- \`03-zlib-wrapper.pdf\`: Check that all six layers remain editable with the zlib wrapper.
- \`04-raw-blocks.pdf\`: Check that all six layers remain editable with raw Zstandard blocks.
- \`05-top-left.pdf\`: Check that artwork positions and artboard setup match 01 with top-left native coordinates.
- \`06-unequal-dates.pdf\`: Record whether Illustrator restores the layers or opens only the visible page when page and application dates differ.
`;

const contentSizeFrame = (native: Uint8Array): Uint8Array => {
  const frame = encodeZstandardFrame(native);
  const output = new Uint8Array(frame.length + 3);
  output.set(frame.subarray(0, 4));
  output[4] = 0xa0;
  new DataView(output.buffer).setUint32(5, native.length, true);
  output.set(frame.subarray(6), 9);
  return output;
};
const coordinate = (value: Coordinate): number => (typeof value === 'number' ? value : Number(value.numerator) / Number(value.denominator));

const makePdf = (model: IllustratorDocument, native: NativeData, options: PrivateDataOptions): Uint8Array => {
  const document = createDocument();
  const page = drawPage(document, model);
  attachPrivateData(document, page, { native, lastModified: model.lastModified, options });
  return document.save().toBytes();
};

/** Writes the six Illustrator open-test candidates and their checklist to an external directory. */
export const writeManualCheckSet = async (directory: string): Promise<readonly string[]> => {
  const destination = path.resolve(directory);
  const repository = path.resolve(import.meta.dirname, '..');
  if (destination === repository || destination.startsWith(`${repository}${path.sep}`)) throw new Error('manual-check output must be outside the repository');
  await mkdir(destination, { recursive: true });
  const model = manualCheckModel();
  const native = writeNative(model);
  const standard = writeIllustratorPdf(model);
  const contentSize = makePdf(model, native, { compression: 'zstandard', frameOverride: contentSizeFrame(native.bytes) });
  const zlib = makePdf(model, native, { compression: 'zstandard', wrapper: 'zlib' });
  const rawBlocks = writeIllustratorPdf(model, { compression: 'zstandard-raw-blocks' });
  const topLeft = makePdf(model, writeNative(model, { convention: 'top-left' }), { compression: 'zstandard' });
  const changed = loadDocument(standard);
  changed.page(0).setLastModified(pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 1, second: 0, offset: 'Z' }));
  const unequal = changed.save({ mode: 'incremental' }).toBytes();
  const outputs = [standard, contentSize, zlib, rawBlocks, topLeft, unequal];
  await Promise.all(
    FILENAMES.map(async (filename, index) => {
      const bytes = outputs[index];
      if (bytes === undefined) throw new Error('manual-check output is missing');
      await writeFile(path.join(destination, filename), bytes);
    }),
  );
  await writeFile(path.join(destination, 'CHECKLIST.md'), CHECKLIST);
  return FILENAMES;
};

const marker = (text: string): Buffer => Buffer.from(text);
const requireIndex = (bytes: Buffer, text: string, start = 0): number => {
  const index = bytes.indexOf(text, start);
  if (index === -1) throw new Error(`diagnostic marker is absent: ${text}`);
  return index;
};
const blockThrough = (bytes: Buffer, [startText, endText]: readonly [string, string], after = 0): Buffer => {
  const start = requireIndex(bytes, startText, after);
  const end = requireIndex(bytes, endText, start) + Buffer.byteLength(endText);
  return bytes.subarray(start, end);
};
const replaceOnce = (bytes: Buffer, oldBytes: Uint8Array, newBytes: Uint8Array): Buffer => {
  const start = bytes.indexOf(oldBytes);
  if (start === -1) throw new Error('diagnostic replacement target is absent');
  return Buffer.concat([bytes.subarray(0, start), newBytes, bytes.subarray(start + oldBytes.length)]);
};
const insertBefore = (bytes: Buffer, target: string, addition: Uint8Array): Buffer =>
  replaceOnce(bytes, marker(target), Buffer.concat([addition, marker(target)]));
const insertAfter = (bytes: Buffer, target: string, addition: Uint8Array): Buffer =>
  replaceOnce(bytes, marker(target), Buffer.concat([marker(target), addition]));
const artboardSpan = (bytes: Buffer): Buffer => {
  const endMarker = '%_; (ArtboardArray) ,\r';
  const end = requireIndex(bytes, endMarker) + Buffer.byteLength(endMarker);
  const start = bytes.lastIndexOf('%_/Array :\r', end);
  if (start === -1) throw new Error('artboard array is absent');
  return bytes.subarray(start, end);
};
const nativeData = (bytes: Buffer): NativeData => ({ bytes, metaDataLength: requireIndex(bytes, '%%EndComments\r') + Buffer.byteLength('%%EndComments\r') });

const indirectIllustrator = (bytes: Uint8Array): Uint8Array => {
  const loaded = loadDocument(bytes);
  const page = loaded.page(0);
  const pageObject = loaded.get(page.reference);
  if (pageObject.kind !== 'dictionary') throw new Error('diagnostic page dictionary is missing');
  const pieceInfo = pageObject.entries.get(pdfName('PieceInfo').bytes);
  if (pieceInfo?.kind !== 'dictionary') throw new Error('diagnostic PieceInfo is missing');
  const illustrator = pieceInfo.entries.get(pdfName('Illustrator').bytes);
  if (illustrator?.kind !== 'dictionary') throw new Error('diagnostic Illustrator data is missing');
  pieceInfo.entries.set(pdfName('Illustrator').bytes, loaded.object(illustrator));
  pageObject.entries.set(pdfName('PieceInfo').bytes, pieceInfo);
  loaded.set(page.reference, pageObject);
  return loaded.save({ mode: 'full' }).toBytes();
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

/** Writes cumulative local-only transplants from a supplied Illustrator export. */
export const writeDiagnosticLadder = async (directory: string, relativeExport: string): Promise<readonly string[]> => {
  const exportsDirectory = env['PDFWRIGHT_ADOBE_EXPORTS_DIR'];
  if (exportsDirectory === undefined) throw new Error('PDFWRIGHT_ADOBE_EXPORTS_DIR is required for diagnostic transplants');
  const root = path.resolve(exportsDirectory);
  const sourcePath = path.resolve(root, relativeExport);
  if (!sourcePath.startsWith(`${root}${path.sep}`)) throw new Error('diagnostic export must be inside PDFWRIGHT_ADOBE_EXPORTS_DIR');
  const destination = path.resolve(directory);
  const repository = path.resolve(import.meta.dirname, '..');
  if (destination === repository || destination.startsWith(`${repository}${path.sep}`)) throw new Error('diagnostic output must be outside the repository');
  await mkdir(destination, { recursive: true });
  const model = manualCheckModel();
  const base = Buffer.from(writeNative(model).bytes);
  const source = Buffer.from(readIllustratorContainer(await readFile(sourcePath)).native);
  const nonPrinting: Buffer[] = [];
  let search = requireIndex(source, '%%BeginSetup\r');
  for (let index = 0; index < 4; index++) {
    const block = blockThrough(source, ['%AI5_Begin_NonPrinting\r', '%AI5_End_NonPrinting--\r'], search);
    nonPrinting.push(block);
    search = source.indexOf(block, search) + block.length;
  }
  const outputs: Uint8Array[] = [];
  let current: Buffer = base;
  const add = (next: Buffer): void => {
    current = next;
    outputs.push(makePdf(model, nativeData(current), { compression: 'zstandard' }));
  };
  const [plugins, artStyles, styleList, symbolList] = nonPrinting;
  if (plugins === undefined || artStyles === undefined || styleList === undefined || symbolList === undefined) {
    throw new Error('diagnostic Setup blocks are missing');
  }
  add(insertBefore(current, '%AI5_BeginPalette\r', plugins));
  add(insertBefore(current, '%AI5_BeginPalette\r', artStyles));
  add(insertBefore(current, '%AI9_BeginDocumentData\r', styleList));
  add(insertBefore(current, '%AI9_BeginDocumentData\r', symbolList));
  const registration = blockThrough(source, ['1 1 1 1 (', 'Pc\r'], requireIndex(source, '%AI5_BeginPalette\r'));
  const registrationComment = blockThrough(source, ['%%CMYKProcessColor:', '\r']);
  add(insertAfter(insertBefore(current, '%AI3_Cropmarks:', registrationComment), '0 0 Pb\r', registration));
  const textDocument = blockThrough(source, ['%AI11_BeginTextDocument\r', '%AI11_EndTextDocument\r']);
  const rulerX = Math.floor(8191.5 - coordinate(model.artboard.width) / 2);
  const height = coordinate(model.artboard.height);
  const rulerY = Math.floor(8191.5 - height / 2) + height;
  const textDocumentString = textDocument.toString('utf8');
  if (!Buffer.from(textDocumentString).equals(textDocument)) throw new Error('diagnostic text document is not UTF-8 safe to splice');
  const revisedText = Buffer.from(
    textDocumentString.replace(/\d+(?:\.\d+)? \d+(?:\.\d+)? \/RulerOrigin ,/u, `${formatNativeNumber(rulerX)} ${formatNativeNumber(rulerY)} /RulerOrigin ,`),
  );
  add(insertBefore(current, '%%EndSetup\r', revisedText));
  const sourceData = blockThrough(source, ['%AI9_BeginDocumentData\r', '%AI9_EndDocumentData\r']);
  const generatedData = blockThrough(base, ['%AI9_BeginDocumentData\r', '%AI9_EndDocumentData\r']);
  const arrayEnd = requireIndex(base, '%_; (ArtboardArray) ,\r') + Buffer.byteLength('%_; (ArtboardArray) ,\r');
  const recorded = requireIndex(base, '%_; /Recorded ,\r', arrayEnd);
  const bleed = base.subarray(arrayEnd, recorded);
  const revisedData = replaceOnce(sourceData, artboardSpan(sourceData), Buffer.concat([artboardSpan(base), bleed]));
  add(replaceOnce(current, generatedData, revisedData));
  const creator = blockThrough(source, ['%%Creator:', '\r']);
  add(replaceOnce(current, marker('%%Creator: @pdfwright/illustrator\r'), creator));
  const direct = makePdf(model, nativeData(current), { compression: 'zstandard' });
  outputs.push(indirectIllustrator(direct));
  await Promise.all(
    diagnosticNames.map(async (filename, index) => {
      const bytes = outputs[index];
      if (bytes === undefined) throw new Error('diagnostic output is missing');
      await writeFile(path.join(destination, filename), bytes);
    }),
  );
  await writeFile(
    path.join(destination, 'DIAGNOSTICS.md'),
    '# Illustrator diagnostic variants\n\nEach file adds the named structure to the preceding variant. The first file that restores editable layers identifies the added structure.\n',
  );
  return diagnosticNames;
};

const [, invokedFile, destination, flag, exportFile] = process.argv;
if (invokedFile !== undefined && import.meta.url === pathToFileURL(invokedFile).href) {
  if (destination === undefined) throw new Error('provide an output directory outside the repository');
  await writeManualCheckSet(destination);
  if (flag !== undefined) {
    if (flag !== '--transplant-from' || exportFile === undefined) throw new Error('use --transplant-from with a relative export path');
    await writeDiagnosticLadder(destination, exportFile);
  }
  process.stdout.write(`${path.resolve(destination)}\n`);
}

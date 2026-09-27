import type { LoadedDocument } from '../document/loadDocument.ts';
import type { TestSection } from '../testing/pdfBuilder.ts';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPlate, renderPlates } from '../../../../scripts/plateOracle.ts';
import { readerReports, spotColors } from '../../../../scripts/readerOracle.ts';
import { cmyk } from '../document/color.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { pt } from '../length/length.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' };
const page = {
  number: 3,
  body: "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/ArtBox[0.242187 2.38184 199.611 192.0]/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')/Contents 4 0 R/Resources<<>>>>",
};
const drawing = latin1Text(deflateZlib(latin1Bytes('0 0 0 1 k 20 20 60 60 re f')));
const content = { number: 4, body: streamBody('/Filter/FlateDecode', drawing) };
const piece = { number: 9, body: "<</LastModified(D:20070624192720-05'00')/Private 10 0 R>>" };
const privateData = { number: 10, body: streamBody('', '%AI private data') };
const hidden = { number: 11, body: '(an object only a cross-reference stream lists)' };

// The bases the incremental rule has to serve: classic, cross-reference streams with and without object streams (the page inside one, as current Illustrator writes it), and an Acrobat-style hybrid.
const classicBase: TestSection[] = [{ xref: 'classic', objects: [catalog, pages, page, content, piece, privateData], trailer: '/Root 1 0 R' }];
const streamBase: TestSection[] = [{ xref: 'stream', objects: [catalog, pages, page, content, piece, privateData], trailer: '/Root 1 0 R' }];
const objectStreamBase: TestSection[] = [
  { xref: 'stream', objects: [catalog, content, privateData], objectStreams: [{ number: 6, members: [pages, page, piece] }], trailer: '/Root 1 0 R' },
];
const hybridBase: TestSection[] = [
  { xref: 'classic', objects: [catalog, pages, page, content, piece, privateData], trailer: '/Root 1 0 R' },
  { xref: 'hybrid', objects: [], objectStreams: [{ number: 12, members: [hidden] }], trailer: '/Root 1 0 R' },
];

const CASES = [
  ['classic', classicBase, 'incremental'],
  ['classic', classicBase, 'full'],
  ['stream', streamBase, 'incremental'],
  ['stream', streamBase, 'full'],
  ['object streams', objectStreamBase, 'incremental'],
  ['object streams', objectStreamBase, 'full'],
  ['hybrid', hybridBase, 'incremental'],
  ['hybrid', hybridBase, 'full'],
] as const;

const addPlate = (document: LoadedDocument): void => {
  const plate = document.separation({ name: 'Varnish', alternate: cmyk(0, 0, 0.2, 0) });
  document.page(0).appendContent(builder => {
    builder.fillColor(plate, 1);
    builder.path(draw => draw.rect(100, 100, 50, 50));
    builder.fill('nonzero');
  });
};

interface Checked {
  readonly reports: (string | number | readonly number[] | readonly string[] | undefined)[][];
  readonly spots: string[];
}

const readEdited = async (sections: readonly TestSection[], mode: 'incremental' | 'full'): Promise<Checked> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-save-'));
  try {
    const document = loadDocument(buildPdf(sections).bytes);
    document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(190), pt(180)));
    addPlate(document);
    const file = path.join(directory, 'edited.pdf');
    await writeFile(file, document.save({ mode }).toBytes());
    const reports = await readerReports(file);
    return { reports: reports.map(report => [report.tool, report.code, report.trimBox, report.notices]), spots: await spotColors(file) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

interface Inks {
  readonly blackBefore: number[];
  readonly blackAfter: number[];
  readonly varnish: number[];
}

// Pixels at 72 dpi, counted from the top left: inside the source's black square, inside the new varnish square, and outside both.
const SAMPLES = [
  [30, 170],
  [120, 75],
  [170, 20],
] as const;

const renderInks = async (): Promise<Inks> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-plates-'));
  try {
    const source = buildPdf(objectStreamBase).bytes;
    const document = loadDocument(source);
    addPlate(document);
    const sourceFile = path.join(directory, 'source.pdf');
    const editedFile = path.join(directory, 'edited.pdf');
    await writeFile(sourceFile, source);
    await writeFile(editedFile, document.save().toBytes());
    const before = await renderPlates(sourceFile, path.join(directory, 'before'), true);
    const after = await renderPlates(editedFile, path.join(directory, 'after'), true);
    const black = new TextEncoder().encode('Black');
    const [blackBefore, blackAfter, varnish] = await Promise.all([
      readPlate(before, black),
      readPlate(after, black),
      readPlate(after, new TextEncoder().encode('Varnish')),
    ]);
    return {
      blackBefore: SAMPLES.map(([x, y]) => blackBefore.inkAt(x, y)),
      blackAfter: SAMPLES.map(([x, y]) => blackAfter.inkAt(x, y)),
      varnish: SAMPLES.map(([x, y]) => varnish.inkAt(x, y)),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('saves read by qpdf, MuPDF, Ghostscript and poppler', () => {
  it.each(CASES)('reads the edited box without repairs: %s base, %s save', async (_, sections, mode) => {
    await expect(readEdited(sections, mode)).resolves.toStrictEqual({
      reports: [
        ['qpdf', 0, [10, 10, 190, 180], []],
        ['mutool', 0, [10, 10, 190, 180], []],
        ['gs', 0, [10, 10, 190, 180], []],
        ['poppler', 0, [10, 10, 190, 180], []],
      ],
      spots: ['Varnish'],
    });
  });

  it('renders the source plates unchanged and adds the new plate', async () => {
    await expect(renderInks()).resolves.toStrictEqual({ blackBefore: [255, 0, 0], blackAfter: [255, 0, 0], varnish: [0, 255, 0] });
  });
});

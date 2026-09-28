import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { FontEntry } from './listFonts.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';
import { text as streamText } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../../document/loadDocument.ts';
import { latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { listFonts } from './listFonts.ts';

const CORPUS = path.join(import.meta.dirname, '../../../test/corpus');

/** The columns of a pdffonts row that pdfwright reports too: name, type, emb, sub and uni. */
interface FontRow {
  readonly name: string;
  readonly type: string;
  readonly emb: string;
  readonly sub: string;
  readonly uni: string;
  /** `objectNumber generation`, or `[none]` for a direct font dictionary. */
  readonly object: string;
}

// pdffonts pads each column to the width of the dashes under its heading, and names and types contain spaces, so rows are cut at those widths.
const parsePdffonts = (output: string): FontRow[] => {
  const lines = output.split('\n');
  const rule = lines.findIndex(line => line.startsWith('---'));
  if (rule === -1) return [];
  const widths = (lines[rule] ?? '').split(' ').map(dashes => dashes.length);
  return lines
    .slice(rule + 1)
    .filter(line => line.trim() !== '')
    .map(line => {
      let offset = 0;
      const cells = widths.map(width => {
        const cell = line.slice(offset, offset + width).trim();
        offset += width + 1;
        return cell;
      });
      const [name = '', type = '', , emb = '', sub = '', uni = '', object = ''] = cells;
      return { name, type, emb, sub, uni, object: object.replaceAll(/\s+/gu, ' ') };
    });
};

// Only standard output holds the table: poppler writes its syntax errors and warnings to standard error.
const pdffonts = async (file: string): Promise<FontRow[]> => {
  const child = spawn('pdffonts', [file]);
  child.stderr.resume();
  const [stdout] = await Promise.all([streamText(child.stdout), once(child, 'close')]);
  return parsePdffonts(stdout);
};

const text = (bytes: Uint8Array | undefined): string => (bytes === undefined ? '' : latin1Text(bytes));

// poppler's type names: the font type, and for embedded programs the FontFile3 subtype (Type1C, CIDFontType0C, OpenType).
const typeName = (font: FontEntry): string => {
  const { embedding } = font;
  const file = embedding.state === 'embedded' ? text(embedding.fileSubtype) : '';
  if (font.subtype === 'Type3') return 'Type 3';
  if (font.subtype === 'Type1' || font.subtype === 'MMType1') return { Type1C: 'Type 1C', OpenType: 'Type 1C (OT)' }[file] ?? 'Type 1';
  if (font.subtype === 'TrueType') return file === 'OpenType' ? 'TrueType (OT)' : 'TrueType';
  if (font.descendant?.subtype === 'CIDFontType0') return { CIDFontType0C: 'CID Type 0C', OpenType: 'CID Type 0C (OT)' }[file] ?? 'CID Type 0';
  if (font.descendant?.subtype === 'CIDFontType2') return file === 'OpenType' ? 'CID TrueType (OT)' : 'CID TrueType';
  return 'unknown';
};

const yes = (value: boolean): string => (value ? 'yes' : 'no');

/**
 * The row pdffonts prints for a font, from pdfwright's entry. Recorded differences for Type 3 fonts: pdffonts says emb yes, where pdfwright says embedding is not applicable, and sub yes for a subset tag, where pdfwright reports the tag with the state not applicable; for a Type 3 font with neither a FontName nor a BaseFont pdffonts prints the resource name, where pdfwright reports no name.
 */
const objectOf = (font: FontEntry): string =>
  font.reference === undefined ? '[none]' : `${String(font.reference.objectNumber)} ${String(font.reference.generation)}`;

const expectedRow = (font: FontEntry, printed: readonly FontRow[]): FontRow => {
  const type3 = font.subtype === 'Type3';
  const tagged = font.subset.state === 'subset' || (font.subset.state === 'not-applicable' && font.subset.tag !== undefined);
  const object = objectOf(font);
  const resourceName = printed.find(row => row.object === object)?.name ?? '';
  return {
    name: type3 && font.name === undefined ? resourceName : text(font.name),
    type: typeName(font),
    emb: yes(font.embedding.state === 'embedded' || type3),
    sub: yes(tagged),
    uni: yes(font.toUnicode === 'present'),
    object,
  };
};

const byObject = (rows: readonly FontRow[]): FontRow[] =>
  rows.toSorted((left, right) => `${left.object} ${left.name}`.localeCompare(`${right.object} ${right.name}`));

// pdffonts does not list fonts that only a graphics state parameter dictionary's Font entry names (8.4.5, Table 58), which pdfwright lists.
const compare = async (file: string, omitted: ReadonlySet<string> = new Set()): Promise<{ readonly pdffonts: FontRow[]; readonly pdfwright: FontRow[] }> => {
  const printed = await pdffonts(file);
  const bytes = new Uint8Array(await readFile(file));
  const inventory = listFonts(loadDocument(bytes), { shownOn: false });
  const listed = inventory.fonts.filter(font => !omitted.has(font.key));
  return {
    pdffonts: byObject(printed),
    pdfwright: byObject(listed.map(font => expectedRow(font, printed))),
  };
};

const program = latin1Text(
  syntheticTrueType({
    name: 'Synthetic',
    glyphs: [{ advance: 500 }, { advance: 600, box: [50, 0, 550, 700] }, { advance: 700, box: [50, 0, 650, 700] }],
    characters: [
      [0x41, 1],
      [0x42, 2],
    ],
  }),
);

const TO_UNICODE = streamBody('', 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <41> <0041> <42> <0042> endbfchar endcmap');
const CID_TO_UNICODE = streamBody(
  '',
  'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0041> <0002> <0042> endbfchar endcmap',
);
const descriptor = (name: string, file: number): string =>
  `<</Type/FontDescriptor/FontName/${name}/Flags 32/FontBBox[0 0 700 700]/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80/FontFile2 ${String(file)} 0 R>>`;
const form = (font: string): string =>
  streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 100 100]/Resources<</Font<</F1 ${font}>>>>`, 'BT /F1 12 Tf 0 0 Td (A) Tj ET');

// A page that reaches fonts through its resources, a form, a tiling pattern, a graphics state and an annotation appearance: a direct standard 14 font, an embedded TrueType subset, a Type 0 CIDFontType2 subset, a Type 3 font shaped as Chromium writes one for a CFF face, and further standard 14 fonts.
const FIXTURE: readonly TestObject[] = [
  {
    number: 100,
    body: '<</Type/Font/Subtype/TrueType/BaseFont/BCDEFG+Synthetic/FirstChar 65/LastChar 66/Widths[600 700]/Encoding/WinAnsiEncoding/FontDescriptor 101 0 R/ToUnicode 103 0 R>>',
  },
  { number: 101, body: descriptor('BCDEFG+Synthetic', 102) },
  { number: 102, body: streamBody('', program) },
  { number: 103, body: TO_UNICODE },
  { number: 110, body: '<</Type/Font/Subtype/Type0/BaseFont/CDEFGH+Synthetic/Encoding/Identity-H/DescendantFonts[111 0 R]/ToUnicode 114 0 R>>' },
  {
    number: 111,
    body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/CDEFGH+Synthetic/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor 112 0 R/CIDToGIDMap/Identity/W[1[600 700]]>>',
  },
  { number: 112, body: descriptor('CDEFGH+Synthetic', 113) },
  { number: 113, body: streamBody('', program) },
  { number: 114, body: CID_TO_UNICODE },
  {
    number: 120,
    body: '<</Type/Font/Subtype/Type3/FontBBox[100 120 900 -880]/FontMatrix[0.001 0 0 -0.001 0 0]/CharProcs<</g0 121 0 R/g1A 122 0 R>>/Encoding<</Type/Encoding/Differences[0/g0/g1A]>>/FirstChar 0/LastChar 1/Widths[1000 1000]/FontDescriptor 123 0 R/ToUnicode 124 0 R/Resources<<>>>>',
  },
  { number: 121, body: streamBody('', '1000 0 100 -880 900 120 d1 100 -880 800 1000 re f') },
  { number: 122, body: streamBody('', '1000 0 100 -880 900 120 d1 100 -880 m 900 -880 l 500 120 l h f') },
  {
    number: 123,
    body: '<</Type/FontDescriptor/FontName/AAAAAA+NotoSansJP-Regular/Flags 4/FontBBox[100 120 900 -880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>',
  },
  { number: 124, body: streamBody('', 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <5C71> endbfchar endcmap') },
  { number: 130, body: '<</Type/Font/Subtype/Type1/BaseFont/Times-Roman>>' },
  { number: 131, body: '<</Type/Font/Subtype/Type1/BaseFont/Symbol>>' },
  { number: 132, body: '<</Type/Font/Subtype/Type1/BaseFont/ZapfDingbats>>' },
  { number: 133, body: '<</Type/Font/Subtype/Type1/BaseFont/Courier-Bold>>' },
  { number: 140, body: form('131 0 R') },
  { number: 141, body: form('132 0 R') },
  { number: 142, body: streamBody('/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<</Font<</F1 133 0 R>>>>', '') },
];

const FIXTURE_PAGE = {
  resources:
    '/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Courier>>/F2 100 0 R/F3 110 0 R/T3 120 0 R>>/ExtGState<</G1<</Font[130 0 R 12]>>>>/XObject<</X1 140 0 R>>/Pattern<</P1 142 0 R>>',
  content: 'BT /F2 12 Tf 10 700 Td (AB) Tj /F3 12 Tf <00010002> Tj /T3 12 Tf <0001> Tj ET /X1 Do',
  entries: '/Annots[<</Type/Annot/Subtype/Square/Rect[0 0 100 100]/F 4/AP<</N 141 0 R>>>>]',
};

/** How a corpus file is expected to fail loading. */
const expectedErrors = async (): Promise<ReadonlySet<string>> => {
  const parsed: unknown = JSON.parse(await readFile(path.join(CORPUS, 'expected-failures.json'), 'utf8'));
  const failing = new Set<string>();
  if (typeof parsed !== 'object' || parsed === null) return failing;
  for (const [file, entry] of Object.entries(parsed)) {
    if (typeof entry === 'object' && entry !== null && 'error' in entry) failing.add(file);
  }
  return failing;
};

const corpusFiles = async (set: string, directory = path.join(CORPUS, set)): Promise<readonly string[]> => {
  try {
    const names = await readdir(directory);
    const files = names
      .filter(name => name.endsWith('.pdf'))
      .toSorted()
      .map(name => path.join(directory, name));
    if (set === 'govdocs1' && env['CI'] !== undefined && files.length === 0) throw new Error('govdocs1 corpus is missing');
    return files;
  } catch {
    if (set === 'govdocs1' && env['CI'] !== undefined) throw new Error('govdocs1 corpus is missing');
    return [];
  }
};

// Every file of a set that loads: pdfwright lists exactly the fonts pdffonts lists, with the same name, type, embedding, subset and ToUnicode columns.
const differencesIn = async (set: string, directory?: string): Promise<string[]> => {
  const failing = await expectedErrors();
  const files = await corpusFiles(set, directory);
  const differences: string[] = [];
  // Files run one after another, so that a large set does not start every pdffonts process at once.
  const next = async (index: number): Promise<string[]> => {
    const file = files[index];
    if (file === undefined) return differences;
    if (!failing.has(`${set}/${path.basename(file)}`)) {
      const { pdffonts: printed, pdfwright } = await compare(file);
      if (JSON.stringify(printed) !== JSON.stringify(pdfwright)) {
        differences.push(`${path.basename(file)}: pdffonts ${JSON.stringify(printed)} pdfwright ${JSON.stringify(pdfwright)}`);
      }
    }
    return next(index + 1);
  };
  return next(0);
};

describe('font inventory against pdffonts', () => {
  it('lists the fonts of generated files as pdffonts does, apart from a graphics state font and the recorded Type 3 columns', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-fonts-'));
    try {
      const file = path.join(directory, 'fonts.pdf');
      await writeFile(file, textPdfBytes({ pages: [FIXTURE_PAGE], objects: FIXTURE }));
      const { pdffonts: printed, pdfwright } = await compare(file, new Set(['130.0']));
      expect(pdfwright).toStrictEqual(printed);
      expect(printed.find(row => row.object === '120 0')).toStrictEqual({
        name: 'AAAAAA+NotoSansJP-Regular',
        type: 'Type 3',
        emb: 'yes',
        sub: 'yes',
        uni: 'yes',
        object: '120 0',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['qpdf', 'cabinet', 'safedocs'])('lists the fonts of the %s set as pdffonts does', { timeout: 120_000 }, async set => {
    await expect(differencesIn(set)).resolves.toStrictEqual([]);
  });

  it('lists the fonts of the fetched govdocs1 files as pdffonts does', { timeout: 600_000 }, async () => {
    await expect(differencesIn('govdocs1', path.join(CORPUS, 'govdocs1/.cache/files'))).resolves.toStrictEqual([]);
  });
});

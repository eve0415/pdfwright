import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { TestPage } from '../../testing/textPdf.ts';
import type { PageGlyph } from './extractText.ts';

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runTool } from '../../../../../scripts/readerOracle.ts';
import { loadDocument } from '../../document/loadDocument.ts';
import { latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { syntheticTrueType } from '../../testing/syntheticTrueType.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { extractText } from './extractText.ts';

const CORPUS = path.join(import.meta.dirname, '../../../test/corpus');

// The pages textPdf builds are 600 by 800 points, and both readers report positions from the top-left corner.
const PAGE_HEIGHT = 800;

// The tolerances of the cross-check: origins agree closely; box edges along the baseline closely; vertical extents loosely, since MuPDF takes them from the font program and poppler from the descriptor.
const ORIGIN_TOLERANCE = 0.01;
const EDGE_TOLERANCE = 0.05;
const EXTENT_FRACTION = 0.25;

// Glyph 1 is a full-width box for U+0041, glyph 2 a half-width box reaching below the baseline for U+0042, glyph 3 another full-width box for U+0043, glyph 4 an empty space.
const full = { advance: 1000, box: [100, 0, 900, 700] } as const;
const half = { advance: 500, box: [50, -100, 450, 600] } as const;
const PROGRAM = syntheticTrueType({
  name: 'Test',
  glyphs: [{ advance: 1000 }, full, half, full, { advance: 250 }],
  characters: [
    [0x41, 1],
    [0x42, 2],
    [0x43, 3],
    [0x20, 4],
  ],
});

const SIMPLE_WIDTHS = [250, ...Array.from({ length: 32 }, () => 0), 1000, 500, 1000].join(' ');

const FONTS: readonly TestObject[] = [
  { number: 105, body: '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Test/Encoding/Identity-H/DescendantFonts[106 0 R]/ToUnicode 107 0 R>>' },
  { number: 108, body: '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Test/Encoding/Identity-V/DescendantFonts[106 0 R]/ToUnicode 107 0 R>>' },
  { number: 109, body: '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Test/Encoding/Identity-V/DescendantFonts[110 0 R]/ToUnicode 107 0 R>>' },
  {
    number: 106,
    body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/W[1[1000 500 1000]]/FontDescriptor 111 0 R>>',
  },
  {
    number: 110,
    body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Test/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/W[1[1000 500 1000]]/W2[1[-900 500 700] 2 3 -1200 250 950]/FontDescriptor 111 0 R>>',
  },
  {
    number: 107,
    body: streamBody(
      '',
      'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <0041> <0002> <0042> <0003> <0043> endbfchar endcmap',
    ),
  },
  {
    number: 111,
    body: '<</Type/FontDescriptor/FontName/AAAAAA+Test/Flags 4/FontBBox[0 -200 1000 800]/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80/FontFile2 112 0 R>>',
  },
  { number: 112, body: streamBody('', latin1Text(PROGRAM)) },
  {
    number: 113,
    body: `<</Type/Font/Subtype/TrueType/BaseFont/AAAAAA+Test/FirstChar 32/LastChar 67/Widths[${SIMPLE_WIDTHS}]/Encoding/WinAnsiEncoding/FontDescriptor 114 0 R>>`,
  },
  {
    number: 114,
    body: '<</Type/FontDescriptor/FontName/AAAAAA+Test/Flags 32/FontBBox[0 -200 1000 800]/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80/FontFile2 112 0 R>>',
  },
];

const RESOURCES = '/Font<</H 105 0 R/V 108 0 R/W 109 0 R/S 113 0 R>>';

// One line per BT block, top to bottom, so that both readers keep content order.
const UPRIGHT: TestPage = {
  resources: RESOURCES,
  content: [
    'BT /H 20 Tf 100 750 Td <000100020003> Tj ET',
    'BT /H 20 Tf 2 Tc 50 Tz 100 700 Td [<0001> -300 <0002> 250 <0003>] TJ ET',
    'BT /S 12 Tf 5 Tw 100 650 Td (A BC) Tj ET',
    'BT /H 16 Tf 3 Ts 100 600 Td <00030002> Tj ET',
    'q 1.5 0 0 1.5 20 0 cm BT /H 10 Tf 60 360 Td <00010002> Tj ET Q',
    'BT /S 12 Tf 14 TL 100 500 Td (AB) Tj T* (CA) Tj 1 2 (BC) " ET',
  ].join('\n'),
};

// Rotated and flipped text, whose origins alone are compared.
const TURNED: TestPage = {
  resources: RESOURCES,
  content: 'BT /H 12 Tf 0 1 -1 0 300 300 Tm <00010002> Tj ET 1 0 0 -1 0 800 cm BT /H 12 Tf 1 0 0 -1 100 100 Tm <00030001> Tj ET',
};

interface Char {
  readonly x: number;
  readonly y: number;
  /** The quad's left and right edges. */
  readonly left: number;
  readonly right: number;
  readonly c: string;
}

const attribute = (element: string, name: string): string => new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(element)?.[1] ?? '';

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

// XML character references and the five predefined entities.
const unescapeXml = (text: string): string =>
  text.replaceAll(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, reference: string) => {
    if (reference.startsWith('#x') || reference.startsWith('#X')) return String.fromCodePoint(Number.parseInt(reference.slice(2), 16));
    if (reference.startsWith('#')) return String.fromCodePoint(Number(reference.slice(1)));
    return ENTITIES.get(reference) ?? '';
  });

// mutool draw -F stext: one char element per glyph, with its origin as x and y and its quad; chars MuPDF adds between words carry flag 4 and are skipped.
const mupdfChars = (xml: string, page: number): Char[] => {
  const pages = xml.split('<page ').slice(1);
  return [...(pages[page] ?? '').matchAll(/<char [^>]*\/>/gu)]
    .map(([element]) => element)
    .filter(element => Math.floor(Number(attribute(element, 'flags')) / 4) % 2 === 0)
    .map(element => {
      const quad = attribute(element, 'quad').split(' ').map(Number);
      const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
      return {
        x: Number(attribute(element, 'x')),
        y: Number(attribute(element, 'y')),
        left: Math.min(...xs),
        right: Math.max(...xs),
        c: unescapeXml(attribute(element, 'c')),
      };
    });
};

interface Word {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
  readonly text: string;
}

// pdftotext -bbox: one word element per word with its box.
const popplerWords = (html: string, page: number): Word[] => {
  const pages = html.split('<page ').slice(1);
  return [...(pages[page] ?? '').matchAll(/<word ([^>]*)>([^<]*)<\/word>/gu)].map(([, attributes = '', text = '']) => ({
    xMin: Number(attribute(` ${attributes}`, 'xMin')),
    yMin: Number(attribute(` ${attributes}`, 'yMin')),
    xMax: Number(attribute(` ${attributes}`, 'xMax')),
    yMax: Number(attribute(` ${attributes}`, 'yMax')),
    text: unescapeXml(text),
  }));
};

const xs = (glyph: PageGlyph): number[] => [glyph.quad[0], glyph.quad[2], glyph.quad[4], glyph.quad[6]];
const ys = (glyph: PageGlyph): number[] => [glyph.quad[1], glyph.quad[3], glyph.quad[5], glyph.quad[7]].map(y => PAGE_HEIGHT - y);

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

// Each glyph against the MuPDF char at the same position in content order: its origin, its text, and, for upright text, its box's left and right edges.
const mupdfDifferences = (glyphs: readonly PageGlyph[], chars: readonly Char[], edges: boolean): string[] => {
  if (glyphs.length !== chars.length) return [`${String(glyphs.length)} glyphs against ${String(chars.length)} MuPDF chars`];
  return glyphs.flatMap((glyph, index) => {
    const char = chars[index];
    if (char === undefined) return [];
    const [x, y] = [glyph.origin[0], PAGE_HEIGHT - glyph.origin[1]];
    const problems = [
      near(x, char.x, ORIGIN_TOLERANCE) && near(y, char.y, ORIGIN_TOLERANCE)
        ? ''
        : `origin (${String(x)}, ${String(y)}) against (${String(char.x)}, ${String(char.y)})`,
      glyph.text === char.c ? '' : `text ${String(glyph.text)} against ${char.c}`,
      !edges || (near(Math.min(...xs(glyph)), char.left, EDGE_TOLERANCE) && near(Math.max(...xs(glyph)), char.right, EDGE_TOLERANCE))
        ? ''
        : `edges ${String(Math.min(...xs(glyph)))}–${String(Math.max(...xs(glyph)))} against ${String(char.left)}–${String(char.right)}`,
    ];
    return problems.filter(problem => problem !== '').map(problem => `glyph ${String(index)}: ${problem}`);
  });
};

// Each poppler word against the glyphs whose text makes it up, in order: its left and right edges closely, its top and bottom within a quarter of the font size.
const popplerDifferences = (glyphs: readonly PageGlyph[], words: readonly Word[]): string[] => {
  const shown = glyphs.filter(glyph => glyph.text !== null && glyph.text.trim() !== '');
  let next = 0;
  return words.flatMap(word => {
    const part: PageGlyph[] = [];
    while (part.map(glyph => glyph.text).join('').length < word.text.length && next < shown.length) {
      const glyph = shown[next++];
      if (glyph !== undefined) part.push(glyph);
    }
    const [first] = part;
    const last = part.at(-1);
    if (first === undefined || last === undefined || part.map(glyph => glyph.text).join('') !== word.text) return [`word ${word.text} has no glyphs`];
    const size = first.fontSize * EXTENT_FRACTION;
    const top = Math.min(...part.flatMap(glyph => ys(glyph)));
    const bottom = Math.max(...part.flatMap(glyph => ys(glyph)));
    const edges = near(Math.min(...xs(first)), word.xMin, EDGE_TOLERANCE) && near(Math.max(...xs(last)), word.xMax, EDGE_TOLERANCE);
    const extent = near(top, word.yMin, size) && near(bottom, word.yMax, size);
    return edges && extent
      ? []
      : [`word ${word.text}: box ${JSON.stringify([Math.min(...xs(first)), top, Math.max(...xs(last)), bottom])} against ${JSON.stringify(word)}`];
  });
};

const withFile = async <T>(bytes: Uint8Array, use: (file: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-text-'));
  try {
    const file = path.join(directory, 'text.pdf');
    await writeFile(file, bytes);
    return await use(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Ghostscript's bbox device: the bounds of the page's ink in default user space.
const inkBounds = async (file: string): Promise<readonly number[]> => {
  const { output } = await runTool('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=bbox', file]);
  return (/%%HiResBoundingBox: (\S+) (\S+) (\S+) (\S+)/u.exec(output)?.slice(1) ?? []).map(Number);
};

const INK_TOLERANCE = 0.01;

// Whether the ink of a page showing one glyph lies inside that glyph's box, with both for the report.
const inkInsideBox = async (content: string): Promise<{ readonly inside: boolean; readonly ink: readonly number[]; readonly box: readonly number[] }> => {
  const bytes = textPdfBytes({ pages: [{ resources: RESOURCES, content }], objects: FONTS });
  const [glyph] = extractText(loadDocument(bytes), 0).glyphs;
  if (glyph === undefined) return { inside: false, ink: [], box: [] };
  const box = [
    Math.min(...xs(glyph)),
    Math.min(glyph.quad[1], glyph.quad[3], glyph.quad[5], glyph.quad[7]),
    Math.max(...xs(glyph)),
    Math.max(glyph.quad[1], glyph.quad[3], glyph.quad[5], glyph.quad[7]),
  ];
  const ink = await withFile(bytes, inkBounds);
  const [left = Number.NaN, bottom = Number.NaN, right = Number.NaN, top = Number.NaN] = ink;
  const [boxLeft = 0, boxBottom = 0, boxRight = 0, boxTop = 0] = box;
  const inside = left >= boxLeft - INK_TOLERANCE && right <= boxRight + INK_TOLERANCE && bottom >= boxBottom - INK_TOLERANCE && top <= boxTop + INK_TOLERANCE;
  return { inside, ink, box };
};

/** Corpus files expected to fail loading, as `set/name`. */
const expectedErrors = async (): Promise<ReadonlySet<string>> => {
  const parsed: unknown = JSON.parse(await readFile(path.join(CORPUS, 'expected-failures.json'), 'utf8'));
  const failing = new Set<string>();
  if (typeof parsed !== 'object' || parsed === null) return failing;
  for (const [file, entry] of Object.entries(parsed)) {
    if (typeof entry === 'object' && entry !== null && 'error' in entry) failing.add(file);
  }
  return failing;
};

// Extracts the text of every page of a file, and says why when that throws.
const extractionFailure = async (file: string): Promise<string | undefined> => {
  try {
    const bytes = await readFile(file);
    const document = loadDocument(new Uint8Array(bytes));
    for (let page = 0; page < document.pageCount; page++) extractText(document, page);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
};

// Extracts the text of every page of every file of a corpus set that loads, one file after another, and lists the files where extraction throws.
const extractionFailures = async (set: string, directory: string): Promise<string[]> => {
  const failing = await expectedErrors();
  const names = await readdir(directory).catch((): string[] => []);
  const files = names.filter(name => name.endsWith('.pdf') && !failing.has(`${set}/${name}`)).toSorted();
  const thrown: string[] = [];
  const next = async (index: number): Promise<string[]> => {
    const name = files[index];
    if (name === undefined) return thrown;
    const failure = await extractionFailure(path.join(directory, name));
    if (failure !== undefined) thrown.push(`${set}/${name}: ${failure}`);
    return next(index + 1);
  };
  return next(0);
};

describe('glyph positions against MuPDF and poppler', () => {
  it('places glyphs of upright horizontal text where MuPDF and poppler do', async () => {
    const bytes = textPdfBytes({ pages: [UPRIGHT], objects: FONTS });
    const { glyphs } = extractText(loadDocument(bytes), 0);
    const [stext, bbox] = await withFile(bytes, async file =>
      Promise.all([runTool('mutool', ['draw', '-F', 'stext', '-o', '-', file]), runTool('pdftotext', ['-bbox', file, '-'])]),
    );
    expect([stext.code, bbox.code]).toStrictEqual([0, 0]);
    expect(mupdfDifferences(glyphs, mupdfChars(stext.output, 0), true)).toStrictEqual([]);
    expect(popplerDifferences(glyphs, popplerWords(bbox.output, 0))).toStrictEqual([]);
  });

  it('places glyphs of rotated and flipped text at MuPDF’s origins', async () => {
    const bytes = textPdfBytes({ pages: [TURNED], objects: FONTS });
    const { glyphs } = extractText(loadDocument(bytes), 0);
    const stext = await withFile(bytes, async file => runTool('mutool', ['draw', '-F', 'stext', '-o', '-', file]));
    expect(mupdfDifferences(glyphs, mupdfChars(stext.output, 0), false)).toStrictEqual([]);
  });

  // The readers disagree with each other and with ISO 32000-1:2008, 9.2.4 and 9.7.4.3 in writing mode 1, so vertical boxes are checked against the ink Ghostscript renders for each glyph alone.
  it.each([
    ['the default DW2', 'BT /V 20 Tf 300 400 Td <0001> Tj ET'],
    ['the default DW2 and a glyph below the baseline', 'BT /V 20 Tf 300 400 Td <0002> Tj ET'],
    ['a W2 position vector', 'BT /W 20 Tf 300 400 Td <0001> Tj ET'],
    ['a W2 range', 'BT /W 20 Tf 300 400 Td <0003> Tj ET'],
    ['horizontal scaling', 'BT /V 20 Tf 50 Tz 300 400 Td <0002> Tj ET'],
    ['a rotated CTM', '0 1 -1 0 500 100 cm BT /V 20 Tf 300 400 Td <0001> Tj ET'],
  ])('boxes a vertical glyph around the ink Ghostscript renders, with %s', async (_, content) => {
    await expect(inkInsideBox(content)).resolves.toMatchObject({ inside: true });
  });

  it.each(['qpdf', 'cabinet', 'safedocs'])('extracts the text of every page of the %s set without throwing', { timeout: 120_000 }, async set => {
    await expect(extractionFailures(set, path.join(CORPUS, set))).resolves.toStrictEqual([]);
  });

  it('extracts the text of every page of the fetched govdocs1 files without throwing', { timeout: 600_000 }, async () => {
    await expect(extractionFailures('govdocs1', path.join(CORPUS, 'govdocs1/.cache/files'))).resolves.toStrictEqual([]);
  });
});

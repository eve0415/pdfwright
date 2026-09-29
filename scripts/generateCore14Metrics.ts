// Writes packages/core/src/font/core14Metrics.ts from the AFM files of Adobe's Core14_AFMs.zip: each font's character widths by glyph name and its FontBBox, nothing else.
// Run with: node scripts/generateCore14Metrics.ts <directory holding the 14 AFM files extracted from the zip below>

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE = 'https://web.archive.org/web/2005id_/http://partners.adobe.com/public/developer/en/pdf/Core14_AFMs.zip';
const SOURCE_SHA256 = '8c892c3c49553cfd2d2a27c4495b4bb12e2875115be7fd127ed3876df19d8654';
const OUTPUT = path.join(import.meta.dirname, '../packages/core/src/font/core14Metrics.ts');

// ISO 32000-1:2008, 9.6.2.2 lists the standard 14 fonts; each has an AFM file of its name in the zip, with this sha256.
const FONTS = {
  Courier: '521e0d7c7521efd4be78a5a9c5398e4c67d0771e396115b0346bc4ef74ada53d',
  'Courier-Bold': 'ad0150d4bedcc8877742bf94251fcec13e348dd599d4603f679d92027d1e6e99',
  'Courier-BoldOblique': 'cb82e69ef5f6d421e8f404fe00bb0d993425aae79725331d0ebf847e94e97e92',
  'Courier-Oblique': 'b27103b2a2ef6030c110626597e2ab47bb8279075a039ab9170facb0aa1f70e1',
  Helvetica: 'da33f1870474c8e68bfe3e2353ff107ab6c6eea1f9836ce2aaf1e1a07b17982f',
  'Helvetica-Bold': 'b880d96baf56d0cc059f258f60b4d764ef49b555ab9db294b959c0016dee41f2',
  'Helvetica-BoldOblique': '69984a35ca26973a39f261cf83e0d367ea2e6517c590b0b030d4d4a219d9c269',
  'Helvetica-Oblique': 'b4609b71b660a392ac09df35060271a876c2ce66617dd83bf826f742bb9d9721',
  Symbol: '3d2128a820375a10de9bc8bf6cfb15ded482c01ca0f95cc0b3277f37ec8bde66',
  'Times-Bold': 'b4a000ed85cb22c6cdd985aa0fd3f6f78ed5079b7c6860dc4f0234e0d0e3c522',
  'Times-BoldItalic': '93c4744ba955215de02c4aae0b777133442ada2f7ab5a2af30a040b792b3c55d',
  'Times-Italic': 'ed37fa2e6a67b5b17dfd47f36fc7e90df32891a4408860dbc8d4cbbe9959e242',
  'Times-Roman': '768e1cabea085d489a63da3e80b96bc5abf0ec98d3073c9b4d6ba76e7bccba64',
  ZapfDingbats: 'a32565c90afd1b57a7008fc567b78d95cf1c22adff5e086094d666d88b039859',
} as const;

interface Metrics {
  readonly names: readonly string[];
  readonly widths: readonly number[];
  readonly bbox: readonly number[];
  readonly copyright: string;
  readonly notice: string;
}

const lineValue = (lines: readonly string[], key: string): string => {
  const line = lines.find(candidate => candidate.startsWith(`${key} `));
  if (line === undefined) throw new Error(`the AFM file has no ${key} line`);
  return line.slice(key.length + 1).trim();
};

// Each character metrics line reads `C code ; WX width ; N name ; B llx lly urx ury ; …` (Adobe Font Metrics File Format Specification).
const readMetrics = (text: string): Metrics => {
  const lines = text.split(/\r?\n/u);
  const names: string[] = [];
  const widths: number[] = [];
  for (const line of lines) {
    if (!line.startsWith('C ')) continue;
    const match = /^C -?\d+ ; WX (\d+) ; N (\S+) ;/u.exec(line);
    if (match === null) throw new Error(`unexpected character metrics line: ${line}`);
    const [, width = '', name = ''] = match;
    widths.push(Number(width));
    names.push(name);
  }
  const bbox = lineValue(lines, 'FontBBox').split(/\s+/u).map(Number);
  if (bbox.length !== 4 || bbox.some(value => !Number.isInteger(value))) throw new Error('the FontBBox line is not four integers');
  return { names, widths, bbox, copyright: lineValue(lines, 'Comment Copyright'), notice: lineValue(lines, 'Notice') };
};

const PRINT_WIDTH = 160;

// Lines as the repository's formatter writes them, so that generated output passes its check unchanged: a string too long for one line moves to the next, indented further.
const stringProperty = (indent: string, key: string, value: string): string => {
  const line = `${indent}${key}: '${value}',`;
  return line.length <= PRINT_WIDTH ? line : `${indent}${key}:\n${indent}  '${value}',`;
};

const propertyKey = (name: string): string => (/^[A-Za-z_$][\w$]*$/u.test(name) ? name : `'${name}'`);

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index]);

const main = async (): Promise<void> => {
  const [directory] = process.argv.slice(2);
  if (directory === undefined) throw new Error('usage: node scripts/generateCore14Metrics.ts <AFM directory>');
  const metrics = new Map<string, Metrics>();
  const files = await Promise.all(
    Object.entries(FONTS).map(async ([font, sha256]) => [font, sha256, await readFile(path.join(directory, `${font}.afm`))] as const),
  );
  for (const [font, sha256, bytes] of files) {
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`${font}.afm does not have the sha256 of the file in the zip`);
    metrics.set(font, readMetrics(bytes.toString('latin1')));
  }
  const latin = metrics.get('Helvetica')?.names ?? [];
  const entries = Object.keys(FONTS).map(font => {
    const { names, widths, bbox, copyright, notice } = metrics.get(font) ?? readMetrics('');
    const shared = sameNames(names, latin);
    return [
      `  // ${font}.afm: Comment Copyright ${copyright}`,
      `  // ${font}.afm: Notice ${notice}`,
      `  ${propertyKey(font)}: {`,
      `    bbox: [${bbox.join(', ')}],`,
      shared ? '    names: undefined,' : stringProperty('    ', 'names', names.join(' ')),
      stringProperty('    ', 'widths', widths.join(' ')),
      '  },',
    ].join('\n');
  });
  const output = [
    '// Generated by scripts/generateCore14Metrics.ts: do not edit.',
    `// This file is a modification of the 14 PostScript AFM files of Adobe's Core14_AFMs.zip (${SOURCE}, sha256 ${SOURCE_SHA256}): each font's character widths (the WX and N values of its character metrics) and its FontBBox were extracted and reformatted, and nothing else of the AFM files is kept.`,
    "// Each font's Comment Copyright and Notice lines are kept beside its metrics; the licence paragraph of the MustRead.html file that accompanies the AFM files is in THIRD-PARTY-NOTICES.md, unmodified.",
    '',
    '/** One standard 14 font: FontBBox, glyph names in AFM order (undefined for the Latin set of `CORE14_LATIN_NAMES`) and the width of each name, in glyph space. */',
    'export interface Core14Font {',
    '  readonly bbox: readonly [number, number, number, number];',
    '  readonly names: string | undefined;',
    '  readonly widths: string;',
    '}',
    '',
    '/** The glyph names that the twelve Courier, Helvetica and Times fonts share, in AFM order. */',
    `export const CORE14_LATIN_NAMES =\n  '${latin.join(' ')}';`,
    '',
    '/** The standard 14 fonts by PostScript name. */',
    'export interface Core14Fonts {',
    ...Object.keys(FONTS).map(font => `  readonly ${propertyKey(font)}: Core14Font;`),
    '}',
    '',
    '/** The metrics of each standard 14 font. */',
    'export const CORE14_FONTS: Core14Fonts = {',
    ...entries,
    '};',
    '',
  ].join('\n');
  await writeFile(OUTPUT, output);
  console.log(`wrote the metrics of ${String(metrics.size)} fonts to ${OUTPUT}`);
};

await main();

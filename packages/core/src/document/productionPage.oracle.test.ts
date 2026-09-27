import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { readPlate, renderPlates } from '../../../../scripts/plateOracle.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { formatLength, mm } from '../length/length.ts';

import { createProductionPage } from './productionPageFixture.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const key = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

interface QpdfField {
  value: unknown;
}

const runQpdf = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const child = spawn('qpdf', args);
  const [closed, stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
  if (closed[0] !== 0) throw new Error(`qpdf exited ${String(closed[0])}: ${stdout}${stderr}`);
  return { stdout, stderr };
};

const entry = (dictionary: unknown, name: string): QpdfField => {
  if (typeof dictionary !== 'object' || dictionary === null) throw new Error('qpdf omitted a dictionary');
  return { value: Object.entries(dictionary).find(([keyName]) => keyName === name)?.[1] };
};

const pageDictionary = (json: unknown): QpdfField => {
  const pages = entry(json, 'pages').value;
  const qpdf = entry(json, 'qpdf').value;
  if (!Array.isArray(pages) || !Array.isArray(qpdf)) throw new Error('qpdf omitted pages or objects');
  const reference = entry(pages[0], 'object').value;
  if (typeof reference !== 'string') throw new Error('qpdf omitted page reference');
  const object = entry(qpdf[1], `obj:${reference}`).value;
  return entry(object, 'value');
};

const qpdfObjects = (json: unknown): QpdfField => {
  const sections = entry(json, 'qpdf').value;
  if (!Array.isArray(sections)) throw new Error('qpdf omitted objects');
  return { value: sections[1] };
};

const scanNumbers = (bytes: Uint8Array): string[] => {
  const pdf = ascii(bytes);
  let cursor = 0;
  let nonstream = '';
  const contents: string[] = [];
  let marker = pdf.indexOf('\nstream\n', cursor);
  while (marker !== -1) {
    const start = marker + 8;
    const end = pdf.indexOf('\nendstream', start);
    if (end === -1) throw new Error('unterminated PDF stream');
    nonstream += pdf.slice(cursor, start);
    const objectMarker = pdf.lastIndexOf(' obj\n', marker);
    const dictionary = pdf.slice(objectMarker + 5, marker);
    if (/\/Filter\/FlateDecode/u.test(dictionary) && !/\/Subtype\/Image/u.test(dictionary)) {
      const compressed = bytes.subarray(start, end);
      const content = inflateZlib(compressed).data;
      contents.push(ascii(content));
    }
    cursor = end;
    marker = pdf.indexOf('\nstream\n', cursor);
  }
  nonstream += pdf.slice(cursor);
  const searchable = `${nonstream.replaceAll(/<[0-9A-F]+>/gu, '')}\n${contents.join('\n')}`;
  return [...searchable.matchAll(/(?<![A-Za-z0-9_.])[-+]?(?:\d+(?:\.\d*)?|\.\d+)[eE][-+]?\d+(?![A-Za-z0-9_.])/gu)].map(match => match[0]);
};

const hasInk = (plate: Awaited<ReturnType<typeof readPlate>>): boolean => {
  for (let y = 0; y < plate.height; y++) {
    for (let x = 0; x < plate.width; x++) {
      if (plate.inkAt(x, y) > 0) return true;
    }
  }
  return false;
};

const hasInkOutsideDie = (plate: Awaited<ReturnType<typeof readPlate>>): boolean => {
  const dieLeft = Number(formatLength(mm(5), 5));
  const dieRight = Number(formatLength(mm(45), 5));
  const dieTop = Number(formatLength(mm(35), 5));
  const left = Math.floor(dieLeft) - 1;
  const right = Math.ceil(dieRight) + 1;
  const top = Math.floor(plate.height - dieTop) - 1;
  const bottom = Math.ceil(plate.height - dieLeft) + 1;
  for (let y = 0; y < plate.height; y++) {
    for (let x = 0; x < plate.width; x++) {
      if ((x < left || x > right || y < top || y > bottom) && plate.inkAt(x, y) > 0) return true;
    }
  }
  return false;
};

describe('production page oracle', () => {
  it('passes qpdf and reports exact boxes, PieceInfo dates, and separation spaces', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-production-'));
    try {
      const fixture = createProductionPage();
      const file = path.join(directory, 'page.pdf');
      await writeFile(file, fixture.saved.toBytes());
      const check = await runQpdf(['--check', file]);
      const report = await runQpdf(['--json', file]);
      const json: unknown = JSON.parse(report.stdout);
      const page = pageDictionary(json).value;
      const trim = [mm(5), mm(5), mm(45), mm(35)].map(value => Number(formatLength(value, 5)));
      const bleed = [mm(3), mm(3), mm(47), mm(37)].map(value => Number(formatLength(value, 5)));
      const pieceInfo = entry(page, '/PieceInfo').value;
      const appData = entry(pieceInfo, '/Illustrator').value;
      expect([check.stderr, check.stdout.toLowerCase().includes('warning')]).toStrictEqual(['', false]);
      expect(entry(page, '/TrimBox').value).toStrictEqual(trim);
      expect(entry(page, '/BleedBox').value).toStrictEqual(bleed);
      expect(entry(appData, '/LastModified').value).toStrictEqual(entry(page, '/LastModified').value);
      expect(JSON.stringify(qpdfObjects(json).value).match(/"\/Separation"/gu)).toHaveLength(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renders exactly four custom plates with the expected coverage inside the die line', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-production-plates-'));
    try {
      const fixture = createProductionPage();
      const file = path.join(directory, 'page.pdf');
      await writeFile(file, fixture.saved.toBytes());
      const plates = await renderPlates(file, directory);
      const names = [fixture.whiteName, fixture.primerName, fixture.cutName, fixture.foldName].map(value => key(value)).toSorted();
      expect(plates.map(plate => key(plate.name)).toSorted()).toStrictEqual(names);
      const white = await readPlate(plates, fixture.whiteName);
      const primer = await readPlate(plates, fixture.primerName);
      const cut = await readPlate(plates, fixture.cutName);
      const fold = await readPlate(plates, fixture.foldName);
      for (const error of [Math.abs(white.inkAt(43, 70) - 255), Math.abs(white.inkAt(71, 70) - 128), Math.abs(primer.inkAt(43, 42) - 77)]) {
        expect(error).toBeLessThanOrEqual(2);
      }
      expect([hasInk(cut), hasInk(fold)]).toStrictEqual([true, true]);
      for (const plate of [white, primer, cut, fold]) {
        expect([hasInkOutsideDie(plate)]).toStrictEqual([false]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses no exponent-form number tokens outside streams or in content streams', () => {
    const bytes = createProductionPage().saved.toBytes();
    expect(scanNumbers(bytes)).toStrictEqual([]);
  });
});

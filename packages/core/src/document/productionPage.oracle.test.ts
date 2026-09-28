import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { readPlate, renderPlates } from '../../../../scripts/plateOracle.ts';
import { pdfDate } from '../date/pdfDate.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { formatLength, mm, pt } from '../length/length.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfReal } from '../object/pdfObject.ts';

import { cmyk, gray, rgb } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { createProductionPage } from './productionPageFixture.ts';
import { rect } from './rect.ts';

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
    if (!/\/Subtype\/(?:Image|XML)/u.test(dictionary)) {
      const stream = bytes.subarray(start, end);
      contents.push(ascii(/\/Filter\/FlateDecode/u.test(dictionary) ? inflateZlib(stream).data : stream));
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
  const dieBottom = Number(formatLength(mm(5), 5));
  const dieRight = Number(formatLength(mm(45), 5));
  const dieTop = Number(formatLength(mm(35), 5));
  const left = Math.floor(dieLeft) - 1;
  const right = Math.ceil(dieRight) + 1;
  const top = Math.floor(plate.height - dieTop) - 1;
  const bottom = Math.ceil(plate.height - dieBottom) + 1;
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
      const plates = await renderPlates(file, directory, true);
      const names = [fixture.whiteName, fixture.primerName, fixture.cutName, fixture.foldName].map(value => key(value)).toSorted();
      const processNames = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);
      expect(
        plates
          .filter(plate => !processNames.has(ascii(plate.name)))
          .map(plate => key(plate.name))
          .toSorted(),
      ).toStrictEqual(names);
      const white = await readPlate(plates, fixture.whiteName);
      const primer = await readPlate(plates, fixture.primerName);
      const cut = await readPlate(plates, fixture.cutName);
      const fold = await readPlate(plates, fixture.foldName);
      for (const error of [Math.abs(white.inkAt(43, 70) - 255), Math.abs(white.inkAt(71, 70) - 128), Math.abs(primer.inkAt(43, 42) - 77)]) {
        expect(error).toBeLessThanOrEqual(2);
      }
      expect([hasInk(cut), hasInk(fold)]).toStrictEqual([true, true]);
      expect([cut.inkAt(14, 57), cut.inkAt(127, 57), cut.inkAt(70, 13), cut.inkAt(70, 98)]).toStrictEqual([255, 255, 255, 255]);
      expect(cut.inkAt(70, 57)).toBe(0);
      const magenta = await readPlate(plates, new TextEncoder().encode('Magenta'));
      const yellow = await readPlate(plates, new TextEncoder().encode('Yellow'));
      for (const plate of [white, primer, cut, fold, magenta, yellow]) {
        expect([hasInkOutsideDie(plate)]).toStrictEqual([false]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('detects process ink outside the die line when the artwork clip is absent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-production-unclipped-'));
    try {
      const file = path.join(directory, 'page.pdf');
      await writeFile(file, createProductionPage({ clipArtwork: false }).saved.toBytes());
      const plates = await renderPlates(file, directory, true);
      const magenta = await readPlate(plates, new TextEncoder().encode('Magenta'));
      const yellow = await readPlate(plates, new TextEncoder().encode('Yellow'));
      expect([hasInkOutsideDie(magenta), hasInkOutsideDie(yellow)]).toStrictEqual([true, true]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses no exponent-form number tokens outside streams or in content streams', () => {
    const bytes = createProductionPage().saved.toBytes();
    expect(scanNumbers(bytes)).toStrictEqual([]);
  });

  it('writes tiny and huge values across page, resource, object and drawing APIs without exponent tokens', () => {
    const tiny = 1e-7;
    const huge = 1e21;
    const lastModified = pdfDate({ year: 2024, month: 3, day: 2, hour: 1, minute: 4, second: 5, offset: 'Z' });
    const document = createDocument({ fractionDigits: 10, info: { title: 'Number forms', modificationDate: lastModified } });
    const spot = document.separation({ name: 'Spot', alternate: cmyk(tiny, 0, 0, 0) });
    const image = document.image({ width: 1, height: 1, colorSpace: 'DeviceGray', bitsPerComponent: 8, samples: new Uint8Array([128]) });
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(10), pt(10)), isolated: true, colorSpace: 'DeviceRGB' }, content => {
      content.fillColor(rgb(tiny, 0, 0));
      content.path(draw => draw.rect(tiny, tiny, 1, 1));
      content.fill('nonzero');
    });
    const privateData = document.object({
      kind: 'stream',
      dictionary: new PdfDictionaryEntries(),
      data: new TextEncoder().encode('0.0000001 1000000000000000000000'),
    });
    document.object(pdfReal(huge));
    const page = document.addPage({
      mediaBox: rect(pt(0), pt(0), pt(huge), pt(huge)),
      cropBox: rect(pt(tiny), pt(tiny), pt(100), pt(100)),
      bleedBox: rect(pt(tiny), pt(tiny), pt(90), pt(90)),
      trimBox: rect(pt(tiny), pt(tiny), pt(80), pt(80)),
      artBox: rect(pt(tiny), pt(tiny), pt(70), pt(70)),
      group: { colorSpace: 'DeviceRGB' },
    });
    page.pieceInfo({ lastModified, data: { Illustrator: { private: privateData } } });
    page.draw(content => {
      content.save();
      content.transform(huge, 0, 0, tiny, tiny, huge);
      content.lineWidth(tiny);
      content.lineJoin('round');
      content.lineCap('square');
      content.miterLimit(huge);
      content.dash([tiny, huge], tiny);
      content.graphicsState({ fillAlpha: tiny, strokeAlpha: tiny, blendMode: 'Multiply' });
      content.fillColor(spot, tiny);
      content.strokeColor(gray(tiny));
      content.path(draw => draw.moveTo(tiny, huge).lineTo(huge, tiny).curveTo(tiny, huge, huge, tiny, tiny, huge).close());
      content.fillAndStroke('evenodd');
      content.path(draw => draw.rect(tiny, tiny, huge, huge));
      content.clip('nonzero');
      content.image(image, [tiny, 0, 0, huge, tiny, huge]);
      content.group(group, [huge, 0, 0, tiny, tiny, huge]);
      content.restore();
    });
    const bytes = document.save().toBytes();
    expect(ascii(bytes)).toContain('1000000000000000000000');
    expect(ascii(bytes)).toContain('0.0000001');
    expect(scanNumbers(bytes)).toStrictEqual([]);
    const unfiltered = new TextEncoder().encode('1 0 obj\n<</Length 4>>\nstream\n1e-7\nendstream\nendobj');
    expect(scanNumbers(unfiltered)).toStrictEqual(['1e-7']);
  });
});

import type { WriteIllustratorPdfOptions } from './index.ts';
import type { IllustratorDocument } from './model/illustratorDocument.ts';

import { ValidationError, compareDocuments, loadDocument, pdfDate, pdfDateString } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { readIllustratorContainer, readIllustratorPdf } from './testing/readIllustratorPdf.ts';
import { writeIllustratorPdfExample } from './writeIllustratorPdfExample.ts';

import { writeIllustratorPdf } from './index.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const model: IllustratorDocument = {
  artboard: { width: 100, height: 70 },
  layers: [
    {
      name: 'Die',
      items: [
        {
          kind: 'path',
          geometry: {
            start: [0, 0],
            segments: [
              { kind: 'line', to: [10, 0] },
              { kind: 'line', to: [10, 10] },
              { kind: 'line', to: [0, 10] },
            ],
          },
          stroke: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] }, width: 0 },
        },
      ],
    },
  ],
  lastModified: date,
};

describe('illustrator PDF writer', () => {
  it('writes a deterministic PDF with equal page and Illustrator dates', () => {
    const bytes = writeIllustratorPdf(model);
    const loaded = loadDocument(bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-1.7');
    expect(loaded.pageCount).toBe(1);
    expect(loaded.page(0).pieceInfo()).toBeDefined();
    expect(writeIllustratorPdf(model)).toStrictEqual(bytes);
  });

  it('writes identical page and application date bytes for three offsets', () => {
    const dates = [
      pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' }),
      pdfDate({ year: 2026, month: 9, day: 28, hour: 21, minute: 34, second: 56, offset: { sign: '+', hours: 9, minutes: 0 } }),
      pdfDate({ year: 2026, month: 9, day: 28, hour: 7, minute: 4, second: 56, offset: { sign: '-', hours: 5, minutes: 30 } }),
    ];
    for (const lastModified of dates) {
      const facts = readIllustratorContainer(writeIllustratorPdf({ ...model, lastModified }));
      const expected = new TextEncoder().encode(pdfDateString(lastModified));
      expect(facts.pageDate).toStrictEqual(expected);
      expect(facts.applicationDate).toStrictEqual(expected);
    }
  });

  it('writes locked layers', () => {
    const locked: IllustratorDocument = { ...model, layers: [{ name: 'Die', locked: true, items: [] }] };
    expect(() => writeIllustratorPdf(locked)).not.toThrow();
  });

  it('runs the production-style page example', () => {
    const bytes = writeIllustratorPdfExample();
    const pdf = new TextDecoder('latin1').decode(bytes);
    expect(loadDocument(bytes).pageCount).toBe(1);
    expect(pdf).toContain('/Separation /Cut');
    expect(pdf).toContain('/Separation /White');
    expect(pdf).toContain('/Separation /Primer');
    expect([pdf.includes('/ImageMask true'), [...pdf.matchAll(/\/ColorSpace\[\/Separation \/(?:White|Primer)/gu)].length]).toStrictEqual([false, 2]);
  });

  it('scans model colors once across the native and visible page writers', () => {
    let reads = 0;
    const process = {
      kind: 'process' as const,
      get cmyk(): readonly [number, number, number, number] {
        reads++;
        return [0, 0, 0, 1];
      },
    };
    const counted: IllustratorDocument = {
      ...model,
      layers: [{ name: 'Ink', items: [{ kind: 'path', geometry: { start: [0, 0], segments: [{ kind: 'line', to: [10, 0] }] }, fill: { paint: process } }] }],
    };
    writeIllustratorPdf(counted);
    expect(reads).toBe(4);
  });
});

const declarations = (options: WriteIllustratorPdfOptions = {}): readonly string[] => {
  const read = readIllustratorPdf(writeIllustratorPdf(model, options));
  const native = new TextDecoder().decode(read.native);
  const artboard = /%_(\S+ \S+) \/RealPointRelToROrigin\r%_ \(PositionPoint1\) ,\r%_(\S+ \S+) \/RealPointRelToROrigin\r%_ \(PositionPoint2\) ,\r/u.exec(native);
  const ruler = /%_(\S+ \S+) \/RealPoint\r%_ \(RulerOrigin\) ,\r/u.exec(native);
  const firstMove = /\r(\S+ \S+) m\r/u.exec(native);
  return [
    read.header.get('%AI3_Cropmarks') ?? '',
    read.header.get('%%PageOrigin') ?? '',
    artboard?.[1] ?? '',
    artboard?.[2] ?? '',
    ruler?.[1] ?? '',
    firstMove?.[1] ?? '',
  ];
};

describe('native coordinate origin', () => {
  it('keeps the artboard-bottom-left declarations by default', () => {
    const expected = ['0 0 100 70', '0 70', '0 70', '100 0', '8141 8156', '0 0'];
    expect(declarations()).toStrictEqual(expected);
    expect(declarations({ nativeOrigin: 'artboard-bottom-left' })).toStrictEqual(expected);
    expect(writeIllustratorPdf(model, { nativeOrigin: 'artboard-bottom-left' })).toStrictEqual(writeIllustratorPdf(model));
  });

  it('writes the artboard-top-left header, artboard and artwork declarations', () => {
    // Cropmarks 0 −H W 0, PageOrigin 0 0, PositionPoint1 (0, 0), PositionPoint2 (W, −H), RulerOrigin (8191.5 − W/2, 8191.5 + H/2), and artwork moved down by H.
    expect(declarations({ nativeOrigin: 'artboard-top-left' })).toStrictEqual(['0 -70 100 0', '0 0', '0 0', '100 -70', '8141.5 8226.5', '0 -70']);
  });

  it('leaves the visible page unchanged and stays deterministic', () => {
    const bottomLeft = writeIllustratorPdf(model);
    const topLeft = writeIllustratorPdf(model, { nativeOrigin: 'artboard-top-left' });
    expect(writeIllustratorPdf(model, { nativeOrigin: 'artboard-top-left' })).toStrictEqual(topLeft);
    const comparison = compareDocuments(loadDocument(bottomLeft), loadDocument(topLeft));
    expect(comparison.differences.length).toBeGreaterThan(0);
    expect(comparison.differences.filter(difference => difference.kind !== 'piece-info')).toStrictEqual([]);
  });

  it('refuses an unknown native origin', () => {
    const options: WriteIllustratorPdfOptions = {};
    Object.defineProperty(options, 'nativeOrigin', { value: 'top-left' });
    expect(() => writeIllustratorPdf(model, options)).toThrow(ValidationError);
  });
});

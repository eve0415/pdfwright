import type { IllustratorDocument } from './model/illustratorDocument.ts';

import { loadDocument, pdfDate, pdfDateString } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { readIllustratorContainer } from './testing/readIllustratorPdf.ts';
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

  it('rejects locked layers before output', () => {
    const locked: IllustratorDocument = { ...model, layers: [{ name: 'Die', locked: true, items: [] }] };
    expect(() => writeIllustratorPdf(locked)).toThrow('locked layers');
  });

  it('runs the production-style page example', () => {
    const bytes = writeIllustratorPdfExample();
    const pdf = new TextDecoder('latin1').decode(bytes);
    expect(loadDocument(bytes).pageCount).toBe(1);
    expect(pdf).toContain('/Separation /Cut');
    expect(pdf).toContain('/Separation /White');
    expect(pdf).toContain('/Separation /Primer');
    expect(pdf).toContain('/ImageMask true');
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

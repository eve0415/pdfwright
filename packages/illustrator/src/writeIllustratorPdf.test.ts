import type { IllustratorDocument } from './model/illustratorDocument.ts';

import { loadDocument, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

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
});

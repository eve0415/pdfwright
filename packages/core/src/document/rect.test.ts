import type { Length } from '../length/length.ts';
import type { PdfRect } from './rect.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { compare, mm, pt } from '../length/length.ts';

import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('page boxes', () => {
  // ISO 32000-1:2008, 7.9.5: a rectangle may be given by any two diagonally opposite corners.
  it.each([
    { corners: 'both axes reversed', input: [pt(10), pt(20), pt(0), pt(5)], output: [pt(0), pt(5), pt(10), pt(20)] },
    { corners: 'only x reversed', input: [pt(10), pt(5), pt(0), pt(20)], output: [pt(0), pt(5), pt(10), pt(20)] },
    { corners: 'only y reversed', input: [pt(0), pt(20), pt(10), pt(5)], output: [pt(0), pt(5), pt(10), pt(20)] },
    { corners: 'already normal', input: [pt(0), pt(5), pt(10), pt(20)], output: [pt(0), pt(5), pt(10), pt(20)] },
    { corners: 'in mixed units', input: [mm(10), pt(0), pt(10), pt(5)], output: [pt(10), pt(0), mm(10), pt(5)] },
    { corners: 'equal', input: [pt(5), pt(5), pt(5), pt(5)], output: [pt(5), pt(5), pt(5), pt(5)] },
  ] as const satisfies Array<{ corners: string; input: PdfRect; output: PdfRect }>)('normalizes corners that are $corners', ({ input, output }) => {
    expect(rect(...input)).toStrictEqual(output);
  });

  it('writes only supplied boxes', () => {
    const document = createDocument();
    document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)), trimBox: rect(pt(10), pt(10), pt(90), pt(90)) });
    const pdf = ascii(document.save().toBytes());
    expect(pdf).toContain('/MediaBox[0 0 100 100]');
    expect(pdf).toContain('/TrimBox[10 10 90 90]');
    expect(pdf).not.toContain('/CropBox');
    expect(pdf).not.toContain('/BleedBox');
    expect(pdf).not.toContain('/ArtBox');
  });

  it('rejects boxes outside MediaBox and zero area after rounding', () => {
    const document = createDocument();
    const mediaBox = rect(pt(0), pt(0), pt(100), pt(100));
    expect(() => {
      document.addPage({ mediaBox, cropBox: rect(pt(-1), pt(0), pt(100), pt(100)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox, artBox: rect(pt(0), pt(0), pt(101), pt(100)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox, cropBox: rect(pt(0), pt(-1), pt(100), pt(100)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox, trimBox: rect(pt(0), pt(0), pt(100), pt(101)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox, bleedBox: rect(mm(0.0000001), pt(0), mm(0.0000002), pt(10)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox: rect(pt(0), pt(0), pt(0), pt(100)) });
    }).toThrow(ValidationError);
  });
});

describe('properties', () => {
  const length = fc.oneof(
    fc.integer({ min: -100_000, max: 100_000 }).map(value => pt(value / 100)),
    fc.integer({ min: -100_000, max: 100_000 }).map(value => mm(value / 100)),
  );

  it('orders the corners of any rectangle whichever diagonal and direction gives it', () => {
    fc.assert(
      fc.property(length, length, length, length, (x1: Length, y1: Length, x2: Length, y2: Length) => {
        const normal = rect(x1, y1, x2, y2);
        const [left, bottom, right, top] = normal;
        expect([compare(left, right) <= 0, compare(bottom, top) <= 0]).toStrictEqual([true, true]);
        expect([rect(...normal), rect(x2, y2, x1, y1), rect(x1, y2, x2, y1), rect(x2, y1, x1, y2)]).toStrictEqual([normal, normal, normal, normal]);
      }),
    );
  });
});

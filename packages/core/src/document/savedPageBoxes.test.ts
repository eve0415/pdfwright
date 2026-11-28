import type { TestObject } from '../testing/pdfBuilder.ts';
import type { BoxName, LoadedPage } from './loadedPage.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { formatLength, pt } from '../length/length.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const loadPage = (media: 'own' | 'inherited' | 'indirect' = 'own', boxes = '') => {
  const objects: Array<TestObject> = [
    { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
    { number: 2, body: `<</Type/Pages/Kids[3 0 R]/Count 1${media === 'inherited' ? '/MediaBox[0 0 100.6 100.6]' : ''}>>` },
    {
      number: 3,
      body: `<</Type/Page/Parent 2 0 R/Resources<<>>${media === 'own' ? '/MediaBox[0 0 100.6 100.6]' : ''}${media === 'indirect' ? '/MediaBox 4 0 R' : ''}${boxes}>>`,
    },
  ];
  if (media === 'indirect') {
    objects.push({ number: 4, body: '[0 0 5 0 R 5 0 R]' }, { number: 5, body: '100.6' });
  }
  return loadDocument(buildPdf([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }]).bytes);
};

const boxNames: ReadonlyArray<BoxName> = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'];

describe.each(['incremental', 'full'] as const)('%s page box saves', mode => {
  it.each(['own', 'inherited', 'indirect'] as const)('checks a rounded TrimBox against the preserved %s MediaBox', media => {
    const document = loadPage(media);
    document.page(0).setBox('TrimBox', rect(pt(0.2), pt(0.2), pt(100.6), pt(100.6)));
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(ValidationError);
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(/extends beyond the MediaBox/u);
    const saved = document.save({ mode, fractionDigits: 1 });
    const reloaded = loadDocument(saved.chunks);
    expect(reloaded.page(0).boxes()).toMatchObject({
      MediaBox: { rect: [0, 0, 100.6, 100.6] },
      TrimBox: { rect: [0.2, 0.2, 100.6, 100.6] },
    });
  });

  it.each(boxNames)('rejects a %s that loses its area at the save precision', name => {
    const document = loadPage();
    document.page(0).setBox(name, rect(pt(0.2), pt(0.2), pt(0.4), pt(0.4)));
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(ValidationError);
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(/zero area/u);
  });

  it('preserves a TrimBox when the changed MediaBox shrinks after rounding', () => {
    const document = loadPage('own', '/TrimBox[0.2 0.2 100.2 100.2]');
    document.page(0).setBox('MediaBox', rect(pt(0), pt(0), pt(100.4), pt(100.4)));
    const saved = document.save({ mode, fractionDigits: 0 });
    const reloaded = loadDocument(saved.chunks);
    expect(reloaded.page(0).boxes().MediaBox.rect).toStrictEqual([0, 0, 100, 100]);
    expect(reloaded.page(0).boxes().TrimBox.rect).toStrictEqual([0.2, 0.2, 100.2, 100.2]);
  });

  it.each([
    {
      edit: 'none',
      apply: (page: LoadedPage) => {
        page.boxes();
      },
    },
    {
      edit: 'content',
      apply: (page: LoadedPage) => {
        page.appendContent(new TextEncoder().encode('q Q'));
      },
    },
    {
      edit: 'box',
      apply: (page: LoadedPage) => {
        page.setBox('BleedBox', rect(pt(1), pt(1), pt(99), pt(99)));
      },
    },
  ])('preserves an original TrimBox outside MediaBox ($edit)', ({ apply }) => {
    const document = loadPage('own', '/TrimBox[0.2 0.2 101.2 101.2]');
    apply(document.page(0));
    for (const fractionDigits of [0, 5, 10]) {
      const saved = document.save({ mode, fractionDigits });
      const reloaded = loadDocument(saved.chunks);
      expect(reloaded.page(0).boxes()).toMatchObject({
        MediaBox: { rect: [0, 0, 100.6, 100.6] },
        TrimBox: { rect: [0.2, 0.2, 101.2, 101.2] },
      });
    }
  });

  it('preserves an unchanged malformed TrimBox while adding content', () => {
    const document = loadPage('own', '/TrimBox[0 0 50]');
    document.page(0).appendContent(new TextEncoder().encode('q Q'));
    expect(latin1Text(document.save({ mode }).toBytes())).toContain('/TrimBox[0 0 50]');
  });

  it('accepts boxes when their written coordinates have area and fit together', () => {
    const document = loadPage();
    const page = document.page(0);
    page.setBox('MediaBox', rect(pt(0), pt(0), pt(100.7), pt(100.7)));
    page.setBox('TrimBox', rect(pt(0.2), pt(0.2), pt(100.6), pt(100.6)));
    page.setBox('BleedBox', rect(pt(0.2), pt(0.2), pt(1.2), pt(1.2)));
    const saved = document.save({ mode, fractionDigits: 0 });
    const reloaded = loadDocument(saved.chunks);
    expect(reloaded.page(0).boxes()).toMatchObject({
      MediaBox: { rect: [0, 0, 101, 101] },
      TrimBox: { rect: [0, 0, 101, 101] },
      BleedBox: { rect: [0, 0, 1, 1] },
    });
  });

  it('checks finer save precision without rounding the stored lengths first', () => {
    const document = loadPage('own', '/TrimBox[0 0 100.6 100.6]');
    document.page(0).setBox('TrimBox', rect(pt(0), pt(0), pt(100.600004), pt(100.600004)));
    expect(() => document.save({ mode, fractionDigits: 10 })).toThrow(ValidationError);
    const saved = document.save({ mode });
    const reloaded = loadDocument(saved.chunks);
    expect(reloaded.page(0).boxes().TrimBox.rect).toStrictEqual([0, 0, 100.6, 100.6]);
  });

  it('accepts a box whose area requires finer precision than the default', () => {
    const document = loadPage();
    document.page(0).setBox('BleedBox', rect(pt(0.000001), pt(0.000001), pt(0.000002), pt(0.000002)));
    expect(() => document.save({ mode })).toThrow(ValidationError);
    const saved = document.save({ mode, fractionDigits: 10 });
    expect(loadDocument(saved.chunks).page(0).boxes().BleedBox.rect).toStrictEqual([0.000001, 0.000001, 0.000002, 0.000002]);
  });

  it('accepts a box that fits MediaBox after rounding at the save precision', () => {
    const document = loadPage();
    document.page(0).setBox('TrimBox', rect(pt(0), pt(0), pt(100.64), pt(100.64)));
    const saved = document.save({ mode, fractionDigits: 1 });
    expect(loadDocument(saved.chunks).page(0).boxes().TrimBox.rect).toStrictEqual([0, 0, 100.6, 100.6]);
    expect(() => document.save({ mode })).toThrow(ValidationError);
  });

  it('retains source precision for an unchanged box set to the same value', () => {
    const document = loadPage('own', '/TrimBox[0.2 0.2 100.4 100.4]');
    document.page(0).setBox('TrimBox', rect(pt(0.2), pt(0.2), pt(100.4), pt(100.4)));
    const saved = document.save({ mode, fractionDigits: 0 });
    const reloaded = loadDocument(saved.chunks);
    expect(reloaded.page(0).boxes().TrimBox.rect).toStrictEqual([0.2, 0.2, 100.4, 100.4]);
  });

  it('checks changes to an indirect MediaBox coordinate', () => {
    const document = loadPage('indirect');
    document.set(pdfReference(5, 0), pdfReal(0.4));
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(ValidationError);
    expect(
      loadDocument(document.save({ mode, fractionDigits: 1 }).chunks)
        .page(0)
        .boxes().MediaBox.rect,
    ).toStrictEqual([0, 0, 0.4, 0.4]);
  });

  it('validates a changed BleedBox even when rounding reproduces its original zero area', () => {
    const document = loadPage('own', '/BleedBox[0 0 0 0]');
    document.page(0).setBox('BleedBox', rect(pt(0.2), pt(0.2), pt(0.4), pt(0.4)));
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(ValidationError);
  });

  it.each([
    { edge: 'left', box: rect(pt(-1), pt(20), pt(50), pt(50)) },
    { edge: 'bottom', box: rect(pt(20), pt(-1), pt(50), pt(50)) },
  ])('rejects a TrimBox that extends past the MediaBox on the $edge only', ({ box }) => {
    const document = loadPage();
    document.page(0).setBox('TrimBox', box);
    expect(() => document.save({ mode })).toThrow(ValidationError);
    expect(() => document.save({ mode })).toThrow(/extends beyond the MediaBox/u);
  });

  it('checks a changed box against the MediaBox an edited ancestor will have', () => {
    const document = loadPage('inherited');
    const node = document.get(pdfReference(2, 0));
    if (node.kind !== 'dictionary') {
      throw new Error('expected the page tree node to be a dictionary');
    }
    node.entries.set(pdfName('MediaBox').bytes, pdfArray([0, 0, 50, 50].map(value => pdfInteger(value))));
    document.set(pdfReference(2, 0), pdfDictionary(node.entries));
    document.page(0).setBox('TrimBox', rect(pt(0), pt(0), pt(80), pt(80)));
    expect(() => document.save({ mode })).toThrow(ValidationError);
    document.page(0).setBox('TrimBox', rect(pt(0), pt(0), pt(40), pt(40)));
    expect(loadDocument(document.save({ mode }).chunks).page(0).boxes()).toMatchObject({
      MediaBox: { rect: [0, 0, 50, 50] },
      TrimBox: { rect: [0, 0, 40, 40] },
    });
  });
});

// Corners anywhere around the MediaBox, and corners within a point of its edges, where rounding decides the outcome.
const corner = fc
  .oneof(fc.integer({ min: -500, max: 11_000 }), fc.integer({ min: -100, max: 100 }), fc.integer({ min: 9960, max: 10_160 }))
  .map(value => value / 100);

const rounded = (values: ReadonlyArray<number>, fractionDigits: number): Array<number> =>
  values.map(value => Number(formatLength(pt(value), fractionDigits))).toSorted((left, right) => left - right);

// The reloaded corners of a saved box, or 'refused' when the save throws ValidationError.
const savedCorners = (save: () => Uint8Array | ReadonlyArray<Uint8Array>, name: BoxName): ReadonlyArray<number> | 'refused' => {
  try {
    return loadDocument(save()).page(0).boxes()[name].rect;
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return 'refused';
    }
    throw error;
  }
};

describe('properties', () => {
  it('saves a changed box exactly when its rounded corners have area inside the written MediaBox, and reloads the rounded corners', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<BoxName>('CropBox', 'BleedBox', 'TrimBox', 'ArtBox'),
        fc.tuple(corner, corner, corner, corner),
        fc.integer({ min: 0, max: 4 }),
        fc.constantFrom('incremental', 'full'),
        (name, [x1, y1, x2, y2], fractionDigits, mode) => {
          const document = loadPage();
          document.page(0).setBox(name, rect(pt(x1), pt(y1), pt(x2), pt(y2)));
          const [left = 0, right = 0] = rounded([x1, x2], fractionDigits);
          const [bottom = 0, top = 0] = rounded([y1, y2], fractionDigits);
          // ISO 32000-1:2008, 7.7.3.3, Table 30 defines the boxes; the writer requires non-zero area within the MediaBox as written, [0 0 100.6 100.6].
          const fits = left < right && bottom < top && left >= 0 && bottom >= 0 && right <= 100.6 && top <= 100.6;
          expect(savedCorners(() => document.save({ mode, fractionDigits }).chunks, name)).toStrictEqual(fits ? [left, bottom, right, top] : 'refused');
        },
      ),
    );
  });
});

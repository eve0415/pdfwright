import type { TestObject } from '../testing/pdfBuilder.ts';
import type { BoxName, LoadedPage } from './loadedPage.ts';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';
import { pdfReal, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const loadPage = (media: 'own' | 'inherited' | 'indirect' = 'own', boxes = '') => {
  const objects: TestObject[] = [
    { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
    { number: 2, body: `<</Type/Pages/Kids[3 0 R]/Count 1${media === 'inherited' ? '/MediaBox[0 0 100.6 100.6]' : ''}>>` },
    {
      number: 3,
      body: `<</Type/Page/Parent 2 0 R/Resources<<>>${media === 'own' ? '/MediaBox[0 0 100.6 100.6]' : ''}${media === 'indirect' ? '/MediaBox 4 0 R' : ''}${boxes}>>`,
    },
  ];
  if (media === 'indirect') objects.push({ number: 4, body: '[0 0 5 0 R 5 0 R]' }, { number: 5, body: '100.6' });
  return loadDocument(buildPdf([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }]).bytes);
};

const boxNames: readonly BoxName[] = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'];

describe.each(['incremental', 'full'] as const)('%s page box saves', mode => {
  it.each(['own', 'inherited', 'indirect'] as const)('checks a rounded TrimBox against the preserved %s MediaBox', media => {
    const document = loadPage(media);
    document.page(0).setBox('TrimBox', rect(pt(0.2), pt(0.2), pt(100.6), pt(100.6)));
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(
      new ValidationError('the TrimBox extends beyond the MediaBox; pdfwright requires every page box to lie within it'),
    );
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
    expect(() => document.save({ mode, fractionDigits: 0 })).toThrow(
      new ValidationError(`the ${name} has zero area after rounding; pdfwright requires page boxes with non-zero area`),
    );
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
});

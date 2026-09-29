import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertForms } from './convertForms.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const displayP3 = parseIccProfile(await fixture('DisplayP3-v4.icc'));

const pdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Fm Do') },
      { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0.2 0.3 0.4 rg 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const formText = (document: ReturnType<typeof loadDocument>): string => {
  const form = document.get(pdfReference(5, 0));
  const internals = internalsOf(document);
  if (form.kind !== 'stream' || internals === undefined) throw new Error('form is missing');
  const data = decodedData(internals, form);
  if (typeof data === 'string') throw new Error(data);
  return latin1Text(data);
};

const sharedFormPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 7 0 R>>>>>>' },
      { number: 4, body: streamBody('', '0 0 0 rg /Fm Do') },
      { number: 5, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 6 0 R/Resources<</XObject<</Fm 7 0 R>>>>>>' },
      { number: 6, body: streamBody('', '0 0 0 rg /Fm Do') },
      { number: 7, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '0.5 0.5 0.5 sc 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const samePagePdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '0 0 0 rg /Fm Do /P3 cs 0 0 0 sc /Fm Do') },
      { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '0.5 0.5 0.5 sc 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const selfContainedFormPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 7 0 R>>>>>>' },
      { number: 4, body: streamBody('', '0 0 0 rg /Fm Do') },
      { number: 5, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 6 0 R/Resources<</XObject<</Fm 7 0 R>>>>>>' },
      { number: 6, body: streamBody('', '/Perceptual ri /Fm Do') },
      { number: 7, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<<>>', '0.5 0.5 0.5 rg 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const overprintFormPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Fm Do') },
      {
        number: 5,
        body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources 8 0 R', '/GS gs 0 0 0 RG 0 0 m 10 10 l S'),
      },
      { number: 8, body: '<</ExtGState<</GS<</OP true/OPM 1>>>>>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const nestedFormsPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Outer 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '0 0 0 rg /Outer Do') },
      { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</XObject<</Inner 6 0 R>>>>', '/Inner Do') },
      { number: 6, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '0.5 0.5 0.5 sc 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const inlineFormPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Fm Do') },
      {
        number: 5,
        body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 50 25]/Resources<<>>', `BI /W 50 /H 25 /BPC 8 /CS /RGB ID\n${'\0'.repeat(3750)}\nEI`),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const formReference = (document: ReturnType<typeof loadDocument>, page: number, name = 'Fm'): ReturnType<typeof pdfReference> => {
  const resources = document.page(page).resources();
  const xobjects = resources.get(pdfName('XObject').bytes);
  if (xobjects?.kind !== 'dictionary') throw new Error('missing XObject resources');
  const reference = xobjects.entries.get(pdfName(name).bytes);
  if (reference?.kind !== 'reference') throw new Error('missing form reference');
  return reference;
};

const dictionaryValue = (value: PdfObject): Extract<PdfObject, { kind: 'dictionary' }> => {
  if (value.kind !== 'dictionary') throw new Error('expected dictionary');
  return value;
};

const streamValue = (value: PdfObject): Extract<PdfObject, { kind: 'stream' }> => {
  if (value.kind !== 'stream') throw new Error('expected stream');
  return value;
};

const textOf = (document: ReturnType<typeof loadDocument>, reference: ReturnType<typeof pdfReference>): string => {
  const form = document.get(reference);
  const internals = internalsOf(document);
  if (form.kind !== 'stream' || internals === undefined) throw new Error('form is missing');
  const data = decodedData(internals, form);
  if (typeof data === 'string') throw new Error(data);
  return latin1Text(data);
};

const pageText = (document: ReturnType<typeof loadDocument>): string => {
  const page = document.get(document.page(0).reference);
  const internals = internalsOf(document);
  if (page.kind !== 'dictionary' || internals === undefined) throw new Error('page is missing');
  const stream = internals.objects.deref(page.entries.get(pdfName('Contents').bytes));
  if (stream?.kind !== 'stream') throw new Error('page content is missing');
  const data = decodedData(internals, stream);
  if (typeof data === 'string') throw new Error(data);
  return latin1Text(data);
};

const formImageData = (document: ReturnType<typeof loadDocument>, reference: ReturnType<typeof pdfReference>): Uint8Array => {
  const form = streamValue(document.get(reference));
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('document internals are missing');
  const resources = internals.objects.deref(form.dictionary.get(pdfName('Resources').bytes));
  if (resources?.kind !== 'dictionary') throw new Error('form resources are missing');
  const xobjects = internals.objects.deref(resources.entries.get(pdfName('XObject').bytes));
  if (xobjects?.kind !== 'dictionary') throw new Error('form images are missing');
  const image = xobjects.entries.get(pdfName('PWIM0').bytes);
  if (image?.kind !== 'reference') throw new Error('converted image is missing');
  const data = decodedData(internals, streamValue(document.get(image)));
  if (typeof data === 'string') throw new Error(data);
  return data;
};

describe('form colour conversion', () => {
  it('rewrites a form with its own colour state and keeps its reference', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report).toStrictEqual({ forms: 1, clones: 0 });
    expect(formText(document)).toMatch(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ k 0 0 10 10 re f/u);
    expect(document.save().mode).toBe('full');
  });

  it('clones a shared form for distinct inherited RGB source profiles', () => {
    const document = loadDocument(sharedFormPdf.bytes);
    const profile = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('N').bytes, pdfInteger(3)]]), data: displayP3.bytes });
    const page = dictionaryValue(document.get(document.page(1).reference));
    const xobjects = new PdfDictionaryEntries([[pdfName('Fm').bytes, pdfReference(7, 0)]]);
    const spaces = new PdfDictionaryEntries([[pdfName('DefaultRGB').bytes, pdfArray([pdfName('ICCBased'), profile])]]);
    const resourceEntries = new PdfDictionaryEntries([
      [pdfName('XObject').bytes, pdfDictionary(xobjects)],
      [pdfName('ColorSpace').bytes, pdfDictionary(spaces)],
    ]);
    page.entries.set(pdfName('Resources').bytes, pdfDictionary(resourceEntries));
    document.set(document.page(1).reference, page);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination });
    const first = formReference(document, 0);
    const second = formReference(document, 1);
    expect(report).toStrictEqual({ forms: 2, clones: 1 });
    expect(first).toStrictEqual(pdfReference(7, 0));
    expect(second).not.toStrictEqual(first);
    expect(textOf(document, first)).not.toBe(textOf(document, second));
  });

  it('renames one Do call when a page uses the same form under two colour spaces', () => {
    const document = loadDocument(samePagePdf.bytes);
    const profile = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('N').bytes, pdfInteger(3)]]), data: displayP3.bytes });
    const page = dictionaryValue(document.get(document.page(0).reference));
    const resources = document.page(0).resources();
    const p3 = pdfArray([pdfName('ICCBased'), profile]);
    const spaces = new PdfDictionaryEntries([[pdfName('P3').bytes, p3]]);
    resources.set(pdfName('ColorSpace').bytes, pdfDictionary(spaces));
    page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
    document.set(document.page(0).reference, page);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination });
    const text = pageText(document);
    expect(report).toStrictEqual({ forms: 2, clones: 1 });
    expect(text).toContain('/Fm Do');
    expect(text).toContain('/PWFORM0 Do');
    const saved = loadDocument(document.save().toBytes());
    expect(pageText(saved)).toContain('/PWFORM0 Do');
    expect(formReference(saved, 0, 'PWFORM0')).not.toStrictEqual(formReference(saved, 0));
  });

  it('reuses a form when its own colour state yields identical converted content', () => {
    const document = loadDocument(selfContainedFormPdf.bytes);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination, intent: 'relativeColorimetric' });
    expect(report).toStrictEqual({ forms: 1, clones: 0 });
    expect(formReference(document, 0)).toStrictEqual(formReference(document, 1));
  });

  it('installs OPM states in a converted form resource dictionary', () => {
    const document = loadDocument(overprintFormPdf.bytes);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report).toStrictEqual({ forms: 1, clones: 0 });
    expect(formText(document)).toMatch(/\/PWOPM0 gs\s+0 0 m 10 10 l S\s+\/PWOPM1 gs/u);
    expect(document.get(pdfReference(8, 0)).kind).toBe('null');
  });

  it('passes inherited colour state into a nested form', () => {
    const document = loadDocument(nestedFormsPdf.bytes);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report).toStrictEqual({ forms: 2, clones: 0 });
    expect(textOf(document, pdfReference(6, 0))).toMatch(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ sc 0 0 10 10 re f/u);
  });

  it('adds an XObject for a large converted inline image in a form', () => {
    const document = loadDocument(inlineFormPdf.bytes);
    const report = convertForms(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.forms).toBe(1);
    expect(formText(document)).toContain('/PWIM0 Do');
    expect(formImageData(document, pdfReference(5, 0))).toHaveLength(5000);
  });
});

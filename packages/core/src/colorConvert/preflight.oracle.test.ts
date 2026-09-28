import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { checkConversionRefusals } from './preflight.ts';

const base = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const output = parseIccProfile(await fixture('fogra28l.icc'));
const other = parseIccProfile(await fixture('synthetic-cmyk.icc'));

const dictionaryValue = (value: PdfObject): Extract<PdfObject, { kind: 'dictionary' }> => {
  if (value.kind !== 'dictionary') throw new Error('expected dictionary');
  return value;
};

const documentWith = (owner: 'catalog' | 'page', key: string): ReturnType<typeof loadDocument> => {
  const document = loadDocument(base.bytes);
  const reference = pdfReference(owner === 'catalog' ? 1 : 3, 0);
  const value = document.get(reference);
  if (value.kind !== 'dictionary') throw new Error('expected dictionary');
  value.entries.set(pdfName(key).bytes, pdfDictionary());
  document.set(reference, value);
  return document;
};

const withOutputIntent = (profile: Uint8Array): ReturnType<typeof loadDocument> => {
  const document = loadDocument(base.bytes);
  const profileReference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: profile });
  const intentEntries = new PdfDictionaryEntries([
    [pdfName('S').bytes, pdfName('GTS_PDFA1')],
    [pdfName('DestOutputProfile').bytes, profileReference],
  ]);
  const intentReference = document.object(pdfDictionary(intentEntries));
  const catalog = document.get(pdfReference(1, 0));
  if (catalog.kind !== 'dictionary') throw new Error('expected catalog');
  catalog.entries.set(pdfName('OutputIntents').bytes, pdfArray([intentReference]));
  document.set(pdfReference(1, 0), catalog);
  return document;
};

const withDefault = (name: 'DefaultGray' | 'DefaultCMYK', profile?: Uint8Array): ReturnType<typeof loadDocument> => {
  const document = loadDocument(base.bytes);
  const page = document.get(pdfReference(3, 0));
  if (page.kind !== 'dictionary') throw new Error('expected page');
  const colorSpaces = new PdfDictionaryEntries();
  const profileReference = profile === undefined ? undefined : document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: profile });
  const value = profileReference === undefined ? pdfName('DeviceGray') : pdfArray([pdfName('ICCBased'), profileReference]);
  colorSpaces.set(pdfName(name).bytes, value);
  const resourceEntries = new PdfDictionaryEntries([[pdfName('ColorSpace').bytes, pdfDictionary(colorSpaces)]]);
  page.entries.set(pdfName('Resources').bytes, pdfDictionary(resourceEntries));
  document.set(pdfReference(3, 0), page);
  return document;
};

describe('colour conversion preflight', () => {
  it.each(['catalog', 'page'] as const)('refuses %s PieceInfo before editing', owner => {
    const document = documentWith(owner, 'PieceInfo');
    expect(() => {
      checkConversionRefusals(document, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'application-data' }));
    expect(document.save().mode).toBe('incremental');
  });

  it('allows explicit removal of application data', () => {
    expect(() => {
      checkConversionRefusals(documentWith('page', 'PieceInfo'), output, { applicationData: 'remove' });
    }).not.toThrow();
  });

  it('finds PieceInfo on a reachable form', () => {
    const document = loadDocument(base.bytes);
    const formDictionary = new PdfDictionaryEntries([
      [pdfName('Subtype').bytes, pdfName('Form')],
      [pdfName('PieceInfo').bytes, pdfDictionary()],
    ]);
    const form = document.object({ kind: 'stream', dictionary: formDictionary, data: new Uint8Array() });
    const page = dictionaryValue(document.get(pdfReference(3, 0)));
    const xobjects = new PdfDictionaryEntries([[pdfName('Fm').bytes, form]]);
    const resources = new PdfDictionaryEntries([[pdfName('XObject').bytes, pdfDictionary(xobjects)]]);
    page.entries.set(pdfName('Resources').bytes, pdfDictionary(resources));
    document.set(pdfReference(3, 0), page);
    expect(() => {
      checkConversionRefusals(document, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'application-data' }));
  });

  it('refuses a conflicting output intent of another subtype', () => {
    expect(() => {
      checkConversionRefusals(withOutputIntent(other.bytes), output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'output-intent-conflict' }));
    expect(() => {
      checkConversionRefusals(withOutputIntent(output.bytes), output);
    }).not.toThrow();
  });

  it('allows explicit replacement of a conflicting output intent', () => {
    expect(() => {
      checkConversionRefusals(withOutputIntent(other.bytes), output, { outputIntent: { existing: 'replace' } });
    }).not.toThrow();
  });

  it('refuses DefaultGray unless removal is selected', () => {
    const document = withDefault('DefaultGray');
    expect(() => {
      checkConversionRefusals(document, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'default-gray' }));
    expect(() => {
      checkConversionRefusals(document, output, { removeDefaultGray: true });
    }).not.toThrow();
  });

  it('refuses a mismatched DefaultCMYK and accepts the output profile', () => {
    expect(() => {
      checkConversionRefusals(withDefault('DefaultCMYK', other.bytes), output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'default-cmyk-conflict' }));
    expect(() => {
      checkConversionRefusals(withDefault('DefaultCMYK', output.bytes), output);
    }).not.toThrow();
  });
});

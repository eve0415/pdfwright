import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

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
const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });

// ICC.1:2022, 7.2.5 Table 18: the profile class is the four bytes at offset 12, so a copy with only that signature changed differs from the original in class alone.
const withClass = async (name: string, profileClass: string): Promise<Uint8Array> => {
  const bytes = await fixture(name);
  bytes.set(new TextEncoder().encode(profileClass), 12);
  return bytes;
};
const outputRgb = parseIccProfile(await withClass('sRGB.icm', 'prtr'));
const displayCmyk = parseIccProfile(await withClass('fogra28l.icc', 'mntr'));

const loaded = (objects: ReadonlyArray<{ readonly number: number; readonly body: string }>, catalog = ''): ReturnType<typeof loadDocument> =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [{ number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` }, { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' }, ...objects],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );
const other = parseIccProfile(await fixture('synthetic-cmyk.icc'));
const rgb = parseIccProfile(await fixture('sRGB.icm'));

const dictionaryValue = (value: PdfObject): Extract<PdfObject, { kind: 'dictionary' }> => {
  if (value.kind !== 'dictionary') {
    throw new Error('expected dictionary');
  }
  return value;
};

const documentWith = (owner: 'catalog' | 'page', key: string): ReturnType<typeof loadDocument> => {
  const document = loadDocument(base.bytes);
  const reference = pdfReference(owner === 'catalog' ? 1 : 3, 0);
  const value = document.get(reference);
  if (value.kind !== 'dictionary') {
    throw new Error('expected dictionary');
  }
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
  if (catalog.kind !== 'dictionary') {
    throw new Error('expected catalog');
  }
  catalog.entries.set(pdfName('OutputIntents').bytes, pdfArray([intentReference]));
  document.set(pdfReference(1, 0), catalog);
  return document;
};

const withDefault = (name: 'DefaultGray' | 'DefaultCMYK', profile?: Uint8Array): ReturnType<typeof loadDocument> => {
  const document = loadDocument(base.bytes);
  const page = document.get(pdfReference(3, 0));
  if (page.kind !== 'dictionary') {
    throw new Error('expected page');
  }
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
  it.each([
    { profile: 'display-class sRGB', destination: rgb },
    { profile: 'output-class sRGB', destination: outputRgb },
    { profile: 'display-class FOGRA28', destination: displayCmyk },
  ])('requires an output-class CMYK destination, refusing $profile', ({ destination }) => {
    expect([destination.header.profileClass === 'output', destination.header.colorSpace === 'CMYK']).not.toStrictEqual([true, true]);
    expect(() => {
      checkConversionRefusals(loadDocument(base.bytes), destination);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
  });

  it.each(['catalog', 'page'] as const)('refuses %s PieceInfo before editing', owner => {
    const document = documentWith(owner, 'PieceInfo');
    const before = document.save().toBytes();
    expect(() => {
      checkConversionRefusals(document, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'application-data' }));
    expect(document.save().toBytes()).toStrictEqual(before);
  });

  it('skips the PieceInfo check when the caller invalidates application data', () => {
    expect(() => {
      checkConversionRefusals(documentWith('page', 'PieceInfo'), output, { applicationData: { invalidate: date } });
    }).not.toThrow();
  });

  it('ignores PieceInfo on an object nothing reachable references', () => {
    const page = { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' };
    const orphan = loaded([page, { number: 4, body: '<</PieceInfo<</App<<>>>>>>' }]);
    expect(() => {
      checkConversionRefusals(orphan, output);
    }).not.toThrow();
    const referenced = loaded([page, { number: 4, body: '<</PieceInfo<</App<<>>>>>>' }], '/Extra 4 0 R');
    expect(() => {
      checkConversionRefusals(referenced, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'application-data' }));
  });

  it('refuses a reachable object it cannot parse', () => {
    const document = loaded([
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>/Broken 4 0 R>>' },
      { number: 4, body: '<</Broken (unterminated' },
    ]);
    expect(() => {
      checkConversionRefusals(document, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'unreadable-resource' }));
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

  it('refuses an OutputIntents entry that is not an array', () => {
    const document = loaded([{ number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' }], '/OutputIntents<<>>');
    expect(() => {
      checkConversionRefusals(document, output, { outputIntent: { existing: 'replace' } });
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'output-intent-conflict' }));
  });

  it.each([
    { intent: 'no DestOutputProfile', body: '<</Type/OutputIntent/S/GTS_PDFX>>' },
    { intent: 'a dictionary DestOutputProfile', body: '<</Type/OutputIntent/S/GTS_PDFX/DestOutputProfile<<>>>>' },
  ])('refuses an intent with $intent unless replacement is selected', ({ body }) => {
    const objects = [
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
      { number: 4, body },
    ];
    expect(() => {
      checkConversionRefusals(loaded(objects, '/OutputIntents[4 0 R]'), output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'output-intent-conflict' }));
    expect(() => {
      checkConversionRefusals(loaded(objects, '/OutputIntents[4 0 R]'), output, { outputIntent: { existing: 'replace' } });
    }).not.toThrow();
  });

  it('refuses a DestOutputProfile stream it cannot decode, even when replacement is selected', () => {
    const document = loaded(
      [
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
        { number: 4, body: '<</Type/OutputIntent/S/GTS_PDFX/DestOutputProfile 5 0 R>>' },
        { number: 5, body: streamBody('/Filter/FlateDecode', 'not zlib') },
      ],
      '/OutputIntents[4 0 R]',
    );
    expect(() => {
      checkConversionRefusals(document, output, { outputIntent: { existing: 'replace' } });
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'unreadable-resource' }));
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

  it.each([
    { value: '/DeviceCMYK', space: 'DeviceCMYK' },
    { value: '[/ICCBased<<>>]', space: 'an ICCBased array without a stream' },
    { value: '[/CalRGB 4 0 R]', space: 'a family other than ICCBased over the output profile' },
  ])('refuses DefaultCMYK set to $space', ({ value }) => {
    const document = loaded([
      { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</ColorSpace<</DefaultCMYK${value}>>>>>>` },
      { number: 4, body: streamBody('/N 4', latin1Text(output.bytes)) },
    ]);
    expect(() => {
      checkConversionRefusals(document, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'default-cmyk-conflict' }));
  });

  it('refuses DefaultGray in the own resources of a reachable form', () => {
    const document = loaded([
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</XObject<</Fm 4 0 R>>>>>>' },
      { number: 4, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</ColorSpace<</DefaultGray/DeviceGray>>>>', '') },
    ]);
    expect(() => {
      checkConversionRefusals(document, output);
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'default-gray' }));
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

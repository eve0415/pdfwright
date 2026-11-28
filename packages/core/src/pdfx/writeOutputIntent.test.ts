import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { OutputIntentOptions } from './writeOutputIntent.ts';

import { describe, expect, it } from 'vitest';

import profile from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgb from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import other from '../../../../tests/fixtures/icc/synthetic-cmyk.icc?icc-bytes';
import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pdfTextString, readTextString } from '../metadata/documentInfo.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName } from '../object/pdfObject.ts';
import { iccProfileBytes } from '../testing/iccProfileBytes.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { checkPdfX4 } from './checkPdfX4.ts';
import { registeredPrintingConditions } from './printingConditions.ts';
import { setCatalogEntry, setPageEntry } from './testing/pdfxDocument.ts';
import { writeGtsPdfxOutputIntent } from './writeOutputIntent.ts';

const base = (header = '1.7') =>
  buildPdf(
    [
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
        ],
        trailer: '/Root 1 0 R',
      },
    ],
    { header: `%PDF-${header}` },
  );

const intentOf = (document: LoadedDocument) => {
  const intents = document.catalog().get(pdfName('OutputIntents').bytes);
  if (intents?.kind !== 'array' || intents.items[0]?.kind !== 'reference') {
    throw new Error('missing output intent');
  }
  const intent = document.get(intents.items[0]);
  if (intent.kind !== 'dictionary') {
    throw new Error('output intent is not a dictionary');
  }
  return intent.entries;
};

const textOf = (value: ReturnType<typeof intentOf>, key: string): string | undefined => {
  const entry = value.get(pdfName(key).bytes);
  return entry?.kind === 'string' ? readTextString(entry.bytes).text : undefined;
};

const profileStream = (document: LoadedDocument) => {
  const reference = intentOf(document).get(pdfName('DestOutputProfile').bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('missing profile');
  }
  const stream = document.get(reference);
  if (stream.kind !== 'stream') {
    throw new Error('profile is not a stream');
  }
  return stream;
};

const outputIntent = (document: LoadedDocument, subtype: string, bytes: Uint8Array) => {
  const profileReference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: bytes });
  const entries = new PdfDictionaryEntries([
    [pdfName('S').bytes, pdfName(subtype)],
    [pdfName('DestOutputProfile').bytes, profileReference],
  ]);
  return { intentReference: document.object(pdfDictionary(entries)), profileReference };
};

const withIntent = (bytes: Uint8Array) => {
  const document = loadDocument(base().bytes);
  const { intentReference, profileReference } = outputIntent(document, 'GTS_PDFA1', bytes);
  setCatalogEntry(document, 'OutputIntents', pdfArray([intentReference]));
  return { document, intentReference, profileReference };
};

const subtypesOf = (document: LoadedDocument): Array<string | undefined> => {
  const intents = document.catalog().get(pdfName('OutputIntents').bytes);
  if (intents?.kind !== 'array') {
    throw new Error('missing output intents');
  }
  return intents.items.map(item => {
    const intent = item.kind === 'reference' ? document.get(item) : item;
    const subtype = intent.kind === 'dictionary' ? intent.entries.get(pdfName('S').bytes) : undefined;
    return subtype?.kind === 'name' ? new TextDecoder().decode(subtype.bytes) : undefined;
  });
};

const versionLowered = (document: LoadedDocument): boolean => document.save().warnings.some(warning => warning.code === 'version-lowered');

describe('gts pdfx output intent', () => {
  it('writes registry defaults', () => {
    const document = loadDocument(base().bytes);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(result.action).toBe('added');
    expect(textOf(intentOf(document), 'RegistryName')).toBe('http://www.color.org');
    expect(textOf(intentOf(document), 'Info')).toBe('FOGRA39');
    expect(textOf(intentOf(document), 'OutputCondition')).toContain('Gloss or matt coated, 115 g/m2');
  });

  it('writes explicit descriptions in place of the registry defaults', () => {
    // ISO 32000-1:2008, 14.11.5, Table 365: Info, OutputCondition and RegistryName describe the condition, and the caller's values win.
    const document = loadDocument(base().bytes);
    writeGtsPdfxOutputIntent(document, {
      outputProfile: profile,
      outputConditionIdentifier: 'FOGRA39',
      info: 'Coated press',
      outputCondition: 'Sheet-fed',
      registryName: 'urn:x',
    });
    const intent = intentOf(document);
    expect(['Info', 'OutputCondition', 'RegistryName'].map(name => textOf(intent, name))).toStrictEqual(['Coated press', 'Sheet-fed', 'urn:x']);
  });

  it('describes a changed identifier with its own registry defaults', () => {
    const document = loadDocument(base().bytes);
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA28' });
    expect(result.action).toBe('updated');
    const intent = intentOf(document);
    expect(['OutputConditionIdentifier', 'Info', 'OutputCondition', 'RegistryName'].map(name => textOf(intent, name))).toStrictEqual([
      'FOGRA28',
      'FOGRA28',
      'OFCOM 3 Altona — Gloss coated web, (LWC) 60 g/m2',
      'http://www.color.org',
    ]);
  });

  it('drops registry entries when the identifier changes to an unregistered condition', () => {
    const document = loadDocument(base().bytes);
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'Custom', info: 'Custom press' });
    const intent = intentOf(document);
    expect(['OutputConditionIdentifier', 'Info', 'OutputCondition', 'RegistryName'].map(name => textOf(intent, name))).toStrictEqual([
      'Custom',
      'Custom press',
      undefined,
      undefined,
    ]);
  });

  it('keeps entries written for the same identifier', () => {
    const document = loadDocument(base().bytes);
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', outputCondition: 'Sheet-fed coated' });
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(textOf(intentOf(document), 'OutputCondition')).toBe('Sheet-fed coated');
  });

  it('embeds unchanged profile bytes and lowers a 1.7 header', () => {
    const document = loadDocument(base().bytes);
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    const stream = profileStream(document);
    expect(stream.dictionary.get(pdfName('N').bytes)).toStrictEqual({ kind: 'integer', value: 4 });
    expect(inflateZlib(stream.data).data).toStrictEqual(profile);
    const saved = document.save();
    expect(saved.mode).toBe('full');
    expect(saved.warnings).toStrictEqual(expect.arrayContaining([expect.objectContaining({ code: 'version-lowered' })]));
    expect(new TextDecoder().decode(saved.toBytes().subarray(0, 8))).toBe('%PDF-1.6');
  });

  it.each<[string, string, Pick<OutputIntentOptions, 'pdfx'>, string, string, boolean]>([
    ['lowers a 1.7 header and catalog Version', '1.7', {}, '%PDF-1.6', '1.6', true],
    ['keeps a 1.7 header and catalog Version with pdfx false', '1.7', { pdfx: false }, '%PDF-1.7', '1.7', false],
    ['keeps a 1.6 header and catalog Version', '1.6', {}, '%PDF-1.6', '1.6', false],
  ])('%s', (_, version, options, header, catalogVersion, lowered) => {
    // ISO 15930-7:2010, 6.1: PDF/X-4 files are PDF 1.6, so only a later version is lowered.
    const document = loadDocument(base(version).bytes);
    setCatalogEntry(document, 'Version', pdfName(version));
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', ...options });
    expect(document.catalog().get(pdfName('Version').bytes)).toStrictEqual(pdfName(catalogVersion));
    expect([new TextDecoder().decode(document.save().toBytes().subarray(0, 8)), versionLowered(document)]).toStrictEqual([header, lowered]);
  });

  it('requires Info for an unregistered identifier', () => {
    const document = loadDocument(base().bytes);
    expect(() => writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'Custom' })).toThrow(
      expect.objectContaining({ constructor: ValidationError }),
    );
    expect(document.save().mode).toBe('incremental');
  });

  it('refuses an empty identifier even with Info', () => {
    const document = loadDocument(base().bytes);
    const write = () => writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: '', info: 'x' });
    expect(write).toThrow(ValidationError);
    expect(write).toThrow(expect.objectContaining({ reason: 'output-intent-conflict' }));
  });

  it.each<[string, Uint8Array]>([
    ['a display RGB profile', srgb],
    ['an output-class RGB profile', iccProfileBytes({ profileClass: 'prtr', colorSpace: 'RGB ', pcs: 'Lab ', tags: [] })],
    ['a display-class CMYK profile', iccProfileBytes({ profileClass: 'mntr', colorSpace: 'CMYK', pcs: 'Lab ', tags: [] })],
  ])('refuses %s before editing', (_, bytes) => {
    // ISO 15930-7:2010, 6.4 and ICC.1:2022, 7.2.5: the PDF/X output intent carries an output-class CMYK profile.
    const document = loadDocument(base().bytes);
    const write = () => writeGtsPdfxOutputIntent(document, { outputProfile: bytes, outputConditionIdentifier: 'FOGRA39' });
    expect(write).toThrow(ValidationError);
    expect(write).toThrow(expect.objectContaining({ reason: 'color-space' }));
    expect(document.save().mode).toBe('incremental');
  });

  it.each<[string, (document: LoadedDocument) => PdfDirectObject]>([
    ['a dictionary', () => pdfDictionary()],
    ['an array holding an integer', () => pdfArray([pdfInteger(1)])],
  ])('refuses OutputIntents written as %s', (_, value) => {
    // ISO 32000-1:2008, Table 28: OutputIntents is an array of output intent dictionaries.
    const document = loadDocument(base().bytes);
    setCatalogEntry(document, 'OutputIntents', value(document));
    const write = () => writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(write).toThrow(ValidationError);
    expect(write).toThrow(expect.objectContaining({ reason: 'output-intent-conflict' }));
  });

  it('refuses an existing intent whose profile does not decode', () => {
    const document = loadDocument(base().bytes);
    const garbage = document.object({
      kind: 'stream',
      dictionary: new PdfDictionaryEntries([[pdfName('Filter').bytes, pdfName('FlateDecode')]]),
      data: new TextEncoder().encode('garbage'),
    });
    const intent = document.object(
      pdfDictionary(
        new PdfDictionaryEntries([
          [pdfName('S').bytes, pdfName('GTS_PDFX')],
          [pdfName('DestOutputProfile').bytes, garbage],
        ]),
      ),
    );
    setCatalogEntry(document, 'OutputIntents', pdfArray([intent]));
    const write = () => writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(write).toThrow(ValidationError);
    expect(write).toThrow(expect.objectContaining({ reason: 'unreadable-resource' }));
  });

  it('reuses an identical indirect profile and refuses a conflicting one by default', () => {
    const { document, profileReference } = withIntent(profile);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(result.action).toBe('added');
    expect(intentOf(document).get(pdfName('DestOutputProfile').bytes)).toStrictEqual(profileReference);
    expect(() => writeGtsPdfxOutputIntent(document, { outputProfile: other, outputConditionIdentifier: 'FOGRA28' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'output-intent-conflict' }),
    );
  });

  it('writes N 4 on a reused profile that lacks it', () => {
    // ISO 32000-1:2008, 8.6.5.5, Table 66: N is required in an ICC profile stream.
    const { document, profileReference } = withIntent(profile);
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    const stream = document.get(profileReference);
    expect(stream.kind === 'stream' ? stream.dictionary.get(pdfName('N').bytes) : stream).toStrictEqual(pdfInteger(4));
  });

  it('keeps a direct output intent of another subtype that shares the profile', () => {
    const document = loadDocument(base().bytes);
    const profileReference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: profile });
    const direct = new PdfDictionaryEntries([
      [pdfName('Type').bytes, pdfName('OutputIntent')],
      [pdfName('S').bytes, pdfName('GTS_PDFA1')],
      [pdfName('OutputConditionIdentifier').bytes, pdfTextString('FOGRA28')],
      [pdfName('DestOutputProfile').bytes, profileReference],
    ]);
    setCatalogEntry(document, 'OutputIntents', pdfArray([pdfDictionary(direct)]));
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA28' });
    expect([result.action, result.removedSubtypes]).toStrictEqual(['added', []]);
    const reloaded = loadDocument(document.save().toBytes());
    expect(subtypesOf(reloaded)).toStrictEqual(['GTS_PDFX', 'GTS_PDFA1']);
  });

  it('replaces conflicting intents of every subtype when asked', () => {
    const document = loadDocument(base().bytes);
    const archive = outputIntent(document, 'GTS_PDFA1', other);
    const print = outputIntent(document, 'GTS_PDFX', other);
    setCatalogEntry(document, 'OutputIntents', pdfArray([archive.intentReference, print.intentReference]));
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes]).toStrictEqual(['replaced', ['GTS_PDFA1', 'GTS_PDFX']]);
    expect(
      [archive.intentReference, archive.profileReference, print.intentReference, print.profileReference].map(reference => document.get(reference)),
    ).toStrictEqual([{ kind: 'null' }, { kind: 'null' }, { kind: 'null' }, { kind: 'null' }]);
    expect(subtypesOf(document)).toStrictEqual(['GTS_PDFX']);
  });

  it('keeps a replaced intent profile that a page colour space still uses', () => {
    // ISO 32000-1:2008, 8.6.5.5: an ICCBased colour space refers to the same kind of profile stream as DestOutputProfile.
    const { document, intentReference, profileReference } = withIntent(other);
    const colorSpaces = new PdfDictionaryEntries([[pdfName('CS0').bytes, pdfArray([pdfName('ICCBased'), profileReference])]]);
    setPageEntry(document, 0, 'Resources', pdfDictionary(new PdfDictionaryEntries([[pdfName('ColorSpace').bytes, pdfDictionary(colorSpaces)]])));
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([document.get(intentReference).kind, document.get(profileReference).kind]).toStrictEqual(['null', 'stream']);
  });

  it('lowers a later catalog Version under an earlier header', () => {
    const document = loadDocument(base('1.4').bytes);
    setCatalogEntry(document, 'Version', pdfName('1.7'));
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(document.catalog().get(pdfName('Version').bytes)).toStrictEqual(pdfName('1.6'));
    const saved = document.save();
    expect(new TextDecoder().decode(saved.toBytes().subarray(0, 8))).toBe('%PDF-1.4');
    expect(saved.warnings).toStrictEqual(expect.arrayContaining([expect.objectContaining({ code: 'version-lowered' })]));
  });

  it('refuses Extensions before editing the catalog', () => {
    const extended = loadDocument(base().bytes);
    setCatalogEntry(extended, 'Extensions', pdfDictionary());
    const write = () => writeGtsPdfxOutputIntent(extended, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(write).toThrow(ValidationError);
    expect(write).toThrow(expect.objectContaining({ reason: 'pdf-extensions' }));
    expect([extended.catalog().has(pdfName('OutputIntents').bytes), extended.save().mode]).toStrictEqual([false, 'incremental']);
  });

  it.each(registeredPrintingConditions.map(condition => condition.identifier))(
    'writes an intent for %s that the checker passes and a repeat leaves alone',
    identifier => {
      const document = loadDocument(base().bytes);
      writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: identifier });
      const intents = document.catalog().get(pdfName('OutputIntents').bytes);
      const intent = intentOf(document);
      const statuses = checkPdfX4(document).findings.filter(finding => finding.rule.startsWith('X4-OI-') && finding.rule !== 'X4-OI-PROFILE-VERSION');
      expect(statuses.map(finding => [finding.rule, finding.status])).toStrictEqual([
        ['X4-OI-PRESENT', 'passed'],
        ['X4-OI-ENTRIES', 'passed'],
        ['X4-OI-PROFILE', 'passed'],
      ]);
      expect(writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: identifier }).action).toBe('updated');
      expect([document.catalog().get(pdfName('OutputIntents').bytes), intentOf(document)]).toStrictEqual([intents, intent]);
    },
  );
});

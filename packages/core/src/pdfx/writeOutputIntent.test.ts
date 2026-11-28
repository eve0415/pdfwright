import type { LoadedDocument, LoadOptions } from '../document/loadDocument.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { OutputIntentOptions } from './writeOutputIntent.ts';

import { describe, expect, it } from 'vitest';

import profile from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgb from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import other from '../../../../tests/fixtures/icc/synthetic-cmyk.icc?icc-bytes';
import { loadDocument } from '../document/loadDocument.ts';
import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pdfTextString, readTextString } from '../metadata/documentInfo.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { iccProfileBytes } from '../testing/iccProfileBytes.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

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
    const stored = intent.kind === 'dictionary' ? intent.entries.get(pdfName('S').bytes) : undefined;
    const subtype = stored?.kind === 'reference' ? document.get(stored) : stored;
    return subtype?.kind === 'name' ? new TextDecoder().decode(subtype.bytes) : undefined;
  });
};

const versionLowered = (document: LoadedDocument): boolean => document.save().warnings.some(warning => warning.code === 'version-lowered');

const compressedIntent = (maxDecodedBytes: number) => {
  const document = loadDocument(base().bytes, { maxDecodedBytes });
  const profileReference = document.object({
    kind: 'stream',
    dictionary: new PdfDictionaryEntries([[pdfName('Filter').bytes, pdfName('FlateDecode')]]),
    data: deflateZlib(profile),
  });
  const intentReference = document.object(
    pdfDictionary(
      new PdfDictionaryEntries([
        [pdfName('S').bytes, pdfName('GTS_PDFA1')],
        [pdfName('DestOutputProfile').bytes, profileReference],
      ]),
    ),
  );
  setCatalogEntry(document, 'OutputIntents', pdfArray([intentReference]));
  return { document, intentReference, profileReference };
};

const withIntents = (intents: string, objects: ReadonlyArray<TestObject>) =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: `<</Type/Catalog/Pages 2 0 R/OutputIntents${intents}>>` },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

const unreadable = { number: 5, body: streamBody('', 'x'.repeat(200)) };

const objectStreamProfile = () =>
  loadDocument(
    buildPdf([
      {
        xref: 'stream',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R/OutputIntents[4 0 R]>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources 21 0 R>>' },
          { number: 4, body: '<</S/GTS_PDFA1/DestOutputProfile 20 0 R>>' },
        ],
        objectStreams: [{ number: 20, members: [{ number: 21, body: '<</ProcSet[/PDF]>>' }] }],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

/** An intent, object 4, whose S is object 21, the name GTS_PDFA1 in object stream 20 beside a 300 000-byte string, and whose profile holds the given bytes. */
const objectStreamSubtype = (bytes: Uint8Array, options: LoadOptions) => {
  const document = loadDocument(
    buildPdf([
      {
        xref: 'stream',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R/OutputIntents[4 0 R]>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
          { number: 4, body: '<</S 21 0 R>>' },
        ],
        objectStreams: [
          {
            number: 20,
            members: [
              { number: 21, body: '/GTS_PDFA1' },
              { number: 22, body: `(${'x'.repeat(300_000)})` },
            ],
          },
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
    options,
  );
  const profileReference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: bytes });
  const entries = new PdfDictionaryEntries([
    [pdfName('S').bytes, pdfReference(21, 0)],
    [pdfName('DestOutputProfile').bytes, profileReference],
  ]);
  document.set(pdfReference(4, 0), pdfDictionary(entries));
  return document;
};

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
    // ISO 32000-1:2008, 14.11.5, Table 365 defines Info, OutputCondition and RegistryName; the registry defaults apply only where the caller gives none.
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
    // ISO 15930-7:2010 preview, Introduction, Table 1: PDF/X-4 is based on PDF 1.6, so only a later version is lowered.
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
    // ICC.1:2022, 7.2.5 and 7.2.6 define the profile class and colour space fields; OutputIntentOptions takes only an output-class CMYK profile.
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

  it.each<[string, Array<[string, PdfDirectObject]>, string]>([
    ['is not an ICC profile', [], 'x'.repeat(200)],
    ['does not decode', [['Filter', pdfName('FlateDecode')]], 'garbage'],
  ])('replaces an existing intent whose profile %s when asked', (_, fields, data) => {
    const document = loadDocument(base().bytes);
    const profileReference = document.object({
      kind: 'stream',
      dictionary: new PdfDictionaryEntries(fields.map(([name, value]) => [pdfName(name).bytes, value])),
      data: new TextEncoder().encode(data),
    });
    const intentReference = document.object(
      pdfDictionary(
        new PdfDictionaryEntries([
          [pdfName('S').bytes, pdfName('GTS_PDFA1')],
          [pdfName('DestOutputProfile').bytes, profileReference],
        ]),
      ),
    );
    setCatalogEntry(document, 'OutputIntents', pdfArray([intentReference]));
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes]).toStrictEqual(['replaced', ['GTS_PDFA1']]);
    expect([document.get(intentReference), document.get(profileReference)]).toStrictEqual([{ kind: 'null' }, { kind: 'null' }]);
    expect(subtypesOf(document)).toStrictEqual(['GTS_PDFX']);
  });

  it('keeps an intent with the same profile while replacing one whose profile is not an ICC profile', () => {
    const document = loadDocument(base().bytes);
    const kept = outputIntent(document, 'GTS_PDFA1', profile);
    const corrupt = outputIntent(document, 'ISO_PDFE1', new TextEncoder().encode('x'.repeat(200)));
    setCatalogEntry(document, 'OutputIntents', pdfArray([kept.intentReference, corrupt.intentReference]));
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes, result.profile]).toStrictEqual(['replaced', ['ISO_PDFE1'], kept.profileReference]);
    expect([document.get(corrupt.intentReference), document.get(corrupt.profileReference)]).toStrictEqual([{ kind: 'null' }, { kind: 'null' }]);
    expect(subtypesOf(document)).toStrictEqual(['GTS_PDFX', 'GTS_PDFA1']);
  });

  it.each<[string, number, string, Array<string>, Array<string>]>([
    ['at the decode limit', 0, 'added', [], ['GTS_PDFX', 'GTS_PDFA1']],
    ['one byte past the decode limit', 1, 'replaced', ['GTS_PDFA1'], ['GTS_PDFX']],
  ])('replaces an existing intent whose profile decodes %s only when it cannot be read', (_, over, action, removed, subtypes) => {
    const { document } = compressedIntent(profile.length - over);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes, subtypesOf(document)]).toStrictEqual([action, removed, subtypes]);
  });

  it.each<[string, string, ReadonlyArray<TestObject>, Array<string>, Array<number>]>([
    [
      'two intents that share one unreadable profile',
      '[4 0 R 6 0 R]',
      [{ number: 4, body: '<</S/GTS_PDFA1/DestOutputProfile 5 0 R>>' }, unreadable, { number: 6, body: '<</S/ISO_PDFE1/DestOutputProfile 5 0 R>>' }],
      ['GTS_PDFA1', 'ISO_PDFE1'],
      [4, 5, 6],
    ],
    [
      'one intent listed twice',
      '[4 0 R 4 0 R]',
      [{ number: 4, body: '<</S/GTS_PDFA1/DestOutputProfile 5 0 R>>' }, unreadable],
      ['GTS_PDFA1', 'GTS_PDFA1'],
      [4, 5],
    ],
    ['an intent whose profile reference names no object', '[4 0 R]', [{ number: 4, body: '<</S/GTS_PDFA1/DestOutputProfile 9 0 R>>' }], ['GTS_PDFA1'], [4]],
  ])('replaces %s, removing each object once', (_, intents, objects, removed, deleted) => {
    const document = withIntents(intents, objects);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes, subtypesOf(document)]).toStrictEqual(['replaced', removed, ['GTS_PDFX']]);
    expect(deleted.map(number => document.get(pdfReference(number, 0)))).toStrictEqual(deleted.map(() => ({ kind: 'null' })));
    expect(loadDocument(document.save().toBytes()).catalog().has(pdfName('OutputIntents').bytes)).toBe(true);
  });

  it.each<[string, string, string, string]>([
    ['an object that cannot be parsed', '5 0 R', '<</Broken (unterminated', 'null'],
    // ISO 32000-1:2008, 7.3.10: a reference to another generation names no object, so object 5 0 is kept.
    ['another generation of the profile object', '5 1 R', streamBody('', 'x'), 'stream'],
  ])('replaces an intent whose profile reference names %s and refuses it by default', (_, reference, body, kept) => {
    const objects = [
      { number: 4, body: `<</S/GTS_PDFA1/DestOutputProfile ${reference}>>` },
      { number: 5, body },
    ];
    const refused = withIntents('[4 0 R]', objects);
    expect(() => writeGtsPdfxOutputIntent(refused, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' })).toThrow(ParseError);
    const document = withIntents('[4 0 R]', objects);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes, subtypesOf(document)]).toStrictEqual(['replaced', ['GTS_PDFA1'], ['GTS_PDFX']]);
    expect([document.get(pdfReference(4, 0)).kind, document.get(pdfReference(5, 0)).kind]).toStrictEqual(['null', kept]);
    expect(loadDocument(document.save().toBytes()).catalog().has(pdfName('OutputIntents').bytes)).toBe(true);
  });

  it('replaces an intent whose profile reference names an object stream, keeping the stream its objects need', () => {
    const refused = objectStreamProfile();
    const refuse = () => writeGtsPdfxOutputIntent(refused, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(refuse).toThrow(InvalidProfileError);
    expect(refuse).toThrow(expect.objectContaining({ reason: 'truncated' }));
    expect([subtypesOf(refused), refused.get(pdfReference(4, 0)).kind]).toStrictEqual([['GTS_PDFA1'], 'dictionary']);
    const document = objectStreamProfile();
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes, subtypesOf(document)]).toStrictEqual(['replaced', ['GTS_PDFA1'], ['GTS_PDFX']]);
    expect([document.get(pdfReference(4, 0)).kind, document.get(pdfReference(20, 0)).kind]).toStrictEqual(['null', 'stream']);
    expect(loadDocument(document.save().toBytes()).page(0).resources().get(pdfName('ProcSet').bytes)).toStrictEqual(pdfArray([pdfName('PDF')]));
  });

  it('refuses an existing intent whose profile decodes past the limit by default', () => {
    const { document } = compressedIntent(profile.length - 1);
    expect(() => writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' })).toThrow(ResourceLimitError);
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

  it.each<[string, Array<string>]>([
    ['GTS_PDFX', ['GTS_PDFX']],
    ['GTS_PDFA1', ['GTS_PDFX', 'GTS_PDFA1']],
  ])('reads an existing intent whose S is an indirect %s', (subtype, subtypes) => {
    // ISO 32000-1:2008, 7.3.10: S may be an indirect reference to the name.
    const document = loadDocument(base().bytes);
    const profileReference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: profile });
    const entries = new PdfDictionaryEntries([
      [pdfName('S').bytes, document.object(pdfName(subtype))],
      [pdfName('DestOutputProfile').bytes, profileReference],
    ]);
    setCatalogEntry(document, 'OutputIntents', pdfArray([document.object(pdfDictionary(entries))]));
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect([result.action, subtypesOf(document)]).toStrictEqual([subtype === 'GTS_PDFX' ? 'updated' : 'added', subtypes]);
  });

  it.each<[string, number, string]>([
    ['another generation of an object', 1, '/GTS_PDFA1'],
    ['an object that cannot be parsed', 0, '<</Broken (unterminated'],
  ])('reads an existing intent whose S names %s as another subtype', (_, generation, body) => {
    // ISO 32000-1:2008, 7.3.10: a reference that names no object is the null object, so S gives no name.
    const objects = [
      { number: 4, body: `<</S 9 ${String(generation)} R>>` },
      { number: 9, body },
    ];
    const kept = withIntents('[4 0 R]', objects);
    const profileReference = kept.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: profile });
    const sameProfile = new PdfDictionaryEntries([
      [pdfName('S').bytes, pdfReference(9, generation)],
      [pdfName('DestOutputProfile').bytes, profileReference],
    ]);
    kept.set(pdfReference(4, 0), pdfDictionary(sameProfile));
    const added = writeGtsPdfxOutputIntent(kept, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect([added.action, added.removedSubtypes, kept.catalog().get(pdfName('OutputIntents').bytes)]).toStrictEqual([
      'added',
      [],
      { kind: 'array', items: [expect.objectContaining({ kind: 'reference' }), pdfReference(4, 0)] },
    ]);
    const document = withIntents('[4 0 R]', objects);
    const replaced = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([replaced.action, replaced.removedSubtypes, subtypesOf(document)]).toStrictEqual(['replaced', ['other'], ['GTS_PDFX']]);
  });

  it.each<[string, LoadOptions, string]>([
    ['as many members as maxObjectStreamMembers', { maxObjectStreamMembers: 2 }, 'GTS_PDFA1'],
    ['more members than maxObjectStreamMembers', { maxObjectStreamMembers: 1 }, 'other'],
    ['a decoded length within maxDecodedBytes', { maxDecodedBytes: 400_000 }, 'GTS_PDFA1'],
    ['a decoded length past maxDecodedBytes', { maxDecodedBytes: 250_000 }, 'other'],
  ])('replaces an intent whose S is in an object stream of %s', (_, options, subtype) => {
    const document = objectStreamSubtype(other, options);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect([result.action, result.removedSubtypes, subtypesOf(document)]).toStrictEqual(['replaced', [subtype], ['GTS_PDFX']]);
  });

  it('refuses an intent it keeps whose S is in an object stream past the limits', () => {
    // A kept intent's subtype decides whether it is updated or a GTS_PDFX intent is added beside it, so its S is not guessed.
    const write = () =>
      writeGtsPdfxOutputIntent(objectStreamSubtype(profile, { maxObjectStreamMembers: 1 }), {
        outputProfile: profile,
        outputConditionIdentifier: 'FOGRA39',
        existing: 'replace',
      });
    expect(write).toThrow(ResourceLimitError);
    expect(write).toThrow(/maxObjectStreamMembers/u);
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

  it('writes an intent beside Extensions with pdfx false, leaving the version alone', () => {
    const extended = loadDocument(base().bytes);
    setCatalogEntry(extended, 'Extensions', pdfDictionary());
    setCatalogEntry(extended, 'Version', pdfName('1.7'));
    const result = writeGtsPdfxOutputIntent(extended, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', pdfx: false });
    expect([result.action, extended.catalog().get(pdfName('Version').bytes), subtypesOf(extended)]).toStrictEqual(['added', pdfName('1.7'), ['GTS_PDFX']]);
    expect([new TextDecoder().decode(extended.save().toBytes().subarray(0, 8)), versionLowered(extended)]).toStrictEqual(['%PDF-1.7', false]);
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

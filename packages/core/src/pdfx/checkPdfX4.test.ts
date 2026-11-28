import type { LoadOptions, LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PdfX4RuleId } from './checkPdfX4.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import profile from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { pt } from '../length/length.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfInteger, pdfLiteralString, pdfName } from '../object/pdfObject.ts';
import { iccProfileBytes, matrixLutTag } from '../testing/iccProfileBytes.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { checkPdfX4, pdfX4Rules } from './checkPdfX4.ts';
import { preparePdfX4Pages } from './preparePages.ts';
import { setCatalogEntry, setPageEntry } from './testing/pdfxDocument.ts';
import { writePdfX4Metadata } from './writeMetadata.ts';
import { writeGtsPdfxOutputIntent } from './writeOutputIntent.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });

interface SourceParts {
  readonly page?: string;
  readonly extra?: ReadonlyArray<TestObject>;
  readonly catalog?: string;
  readonly trailer?: string;
}

const source = ({ page = '/Resources<<>>', extra = [], catalog = '', trailer = '' }: SourceParts = {}) =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]${page}>>` },
        ...extra,
      ],
      trailer: `/Root 1 0 R/ID[<${'01'.repeat(16)}><${'02'.repeat(16)}>]${trailer}`,
    },
  ]);

const raw = (parts?: SourceParts, options?: LoadOptions): LoadedDocument => loadDocument(source(parts).bytes, options);

const prepared = (parts?: SourceParts) => {
  const document = raw(parts);
  writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
  writePdfX4Metadata(document, { metadataDate: date, trapped: 'False' });
  preparePdfX4Pages(document);
  return document;
};

const finding = (document: LoadedDocument, rule: PdfX4RuleId) => checkPdfX4(document).findings.find(item => item.rule === rule);
const statusOf = (document: LoadedDocument, rule: PdfX4RuleId) => finding(document, rule)?.status;
const statuses = (document: LoadedDocument) => Object.fromEntries(checkPdfX4(document).findings.map(item => [item.rule, item.status]));

type Fields = ReadonlyArray<readonly [string, PdfDirectObject | undefined]>;

const entries = (fields: Fields): PdfDictionaryEntries => {
  const result = new PdfDictionaryEntries();
  for (const [name, value] of fields) {
    if (value !== undefined) {
      result.set(pdfName(name).bytes, value);
    }
  }
  return result;
};

const stream = (document: LoadedDocument, data: Uint8Array, fields: Fields = []) => document.object({ kind: 'stream', dictionary: entries(fields), data });

/** A GTS_PDFX intent for FOGRA39 with the fogra28l profile, with `overrides` replacing or, when undefined, removing entries. */
const pdfxIntent = (document: LoadedDocument, overrides: Fields = [], bytes: Uint8Array = profile): Fields => {
  const fields = new Map<string, PdfDirectObject | undefined>([
    ['Type', pdfName('OutputIntent')],
    ['S', pdfName('GTS_PDFX')],
    ['OutputConditionIdentifier', pdfLiteralString('FOGRA39')],
    ['DestOutputProfile', stream(document, bytes, [['N', pdfInteger(4)]])],
  ]);
  for (const [name, value] of overrides) {
    fields.set(name, value);
  }
  return [...fields];
};

const withIntents = (build: (document: LoadedDocument) => ReadonlyArray<Fields>, options?: LoadOptions): LoadedDocument => {
  const document = raw({}, options);
  setCatalogEntry(document, 'OutputIntents', pdfArray(build(document).map(fields => document.object(pdfDictionary(entries(fields))))));
  return document;
};

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
// ICC.1:2022, 7.2.5: 'prtr' is the output device class and 'mntr' the display device class; 9.2 defines the AToB1 and BToA0 tags.
const rgbProfile = (profileClass: string, tags: ReadonlyArray<string>) =>
  iccProfileBytes({
    profileClass,
    colorSpace: 'RGB ',
    pcs: 'XYZ ',
    tags: tags.map(signature => [signature, matrixLutTag(signature.startsWith('B') ? 'mBA ' : 'mAB ', identity)] as const),
  });

const xmp = (properties: ReadonlyArray<string>) =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${properties
    .map(
      property =>
        `<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">${property}</rdf:Description>`,
    )
    .join('')}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const withMetadata = (info: string | undefined, packet: ReadonlyArray<string> | undefined): LoadedDocument =>
  raw({
    catalog: packet === undefined ? '' : '/Metadata 9 0 R',
    trailer: info === undefined ? '' : '/Info 8 0 R',
    extra: [
      ...(info === undefined ? [] : [{ number: 8, body: `<<${info}>>` }]),
      ...(packet === undefined ? [] : [{ number: 9, body: streamBody('/Type/Metadata/Subtype/XML', xmp(packet)) }]),
    ],
  });

const version = (value: string) => `<pdfxid:GTS_PDFXVersion>${value}</pdfxid:GTS_PDFXVersion>`;
const trappedXmp = (value: string) => `<pdf:Trapped>${value}</pdf:Trapped>`;

// ISO 32000-1:2008, 12.6.4.16 and 12.6.4.7: a JavaScript action carries JS, and a URI action carries URI.
// 7.3.10: S may be an indirect reference to the name.
const action = (document: LoadedDocument, subtype: 'JavaScript' | 'URI', indirect = false) =>
  document.object(
    pdfDictionary(
      entries([
        ['S', indirect ? document.object(pdfName(subtype)) : pdfName(subtype)],
        [subtype === 'JavaScript' ? 'JS' : 'URI', pdfLiteralString('x')],
      ]),
    ),
  );

const annotation = (document: LoadedDocument, subtype: PdfDirectObject) =>
  document.object(
    pdfDictionary(
      entries([
        ['Type', pdfName('Annot')],
        ['Subtype', subtype],
      ]),
    ),
  );

const info = ['Info', pdfLiteralString('x')] as const;

const lzwImage = 'BI /W 1 /H 1 /BPC 8 /CS /G /F /LZW ID\nX\nEI';

describe('pdfx structural checker', () => {
  it('reports every rule of pdfX4Rules once, in order, with its source and authority', () => {
    const report = checkPdfX4(prepared());
    expect(report.findings.map(({ rule, source: from, authority }) => ({ id: rule, source: from, authority }))).toStrictEqual(pdfX4Rules);
    expect(report.summary).toBe('no-violation-found-by-these-rules');
  });

  it('passes the structures the writers added and leaves every other rule not checked', () => {
    // ISO 15930-7:2010, clause 6 sets the requirements the not-checked rules leave open, so passing these checks is not a claim of conformance.
    expect(statuses(prepared())).toStrictEqual({
      'X4-VERSION': 'not-checked',
      'X4-PDF17-KEYS': 'not-checked',
      'X4-ENCRYPT': 'passed',
      'X4-OI-PRESENT': 'passed',
      'X4-OI-ENTRIES': 'passed',
      'X4-OI-PROFILE': 'passed',
      'X4-OI-PROFILE-VERSION': 'not-checked',
      'X4-XMP-VERSION': 'passed',
      'X4-XMP-MM': 'not-checked',
      'X4-TRAPPED': 'passed',
      'X4-TRAPPED-XMP': 'passed',
      'X4-BOXES': 'passed',
      'X4-JS': 'passed',
      'X4-FORMS': 'passed',
      'X4-ANNOTS': 'not-checked',
      'X4-TRANSFER': 'not-checked',
      'X4-LZW': 'passed',
      'X4-EMBEDDED': 'passed',
      'X4-EXTERNAL': 'passed',
      'X4-FONTS': 'not-checked',
      'X4-SPOT-ALTERNATE': 'not-checked',
      'X4-PS': 'not-checked',
      'X4-BXEX': 'not-checked',
      'X4-INTENTS': 'not-checked',
      'X4-LIMITS': 'not-checked',
      'X4-TRANSPARENCY': 'not-checked',
      'X4-OC': 'not-checked',
    });
  });

  it('leaves the rules it never checks not checked on an unprepared document too', () => {
    const report = statuses(raw());
    const unchecked = [
      'X4-VERSION',
      'X4-PDF17-KEYS',
      'X4-OI-PROFILE-VERSION',
      'X4-XMP-MM',
      'X4-ANNOTS',
      'X4-TRANSFER',
      'X4-FONTS',
      'X4-SPOT-ALTERNATE',
      'X4-PS',
      'X4-BXEX',
      'X4-INTENTS',
      'X4-LIMITS',
      'X4-TRANSPARENCY',
      'X4-OC',
    ];
    expect(unchecked.map(rule => [rule, report[rule]])).toStrictEqual(unchecked.map(rule => [rule, 'not-checked']));
  });

  it('reports missing structures as violations and keeps uncertain rules unverified', () => {
    const report = checkPdfX4(raw());
    const status = (rule: string) => report.findings.find(item => item.rule === rule)?.status;
    expect(report.summary).toBe('violations-found');
    expect(status('X4-OI-PRESENT')).toBe('violation');
    expect(status('X4-XMP-VERSION')).toBe('violation');
    expect(status('X4-BOXES')).toBe('violation');
    expect(status('X4-PDF17-KEYS')).toBe('not-checked');
  });

  it('refuses a document that loadDocument did not create', () => {
    const document = raw();
    expect(() => checkPdfX4({ ...document })).toThrow(TypeError);
  });

  it('names the media-management fields that are present or absent without checking them', () => {
    const present = finding(prepared(), 'X4-XMP-MM');
    const absent = finding(raw(), 'X4-XMP-MM');
    expect([present?.status, absent?.status]).toStrictEqual(['not-checked', 'not-checked']);
    expect(present?.detail).not.toMatch(/absent/);
    expect(absent?.detail).toMatch(/xmpMM:DocumentID, xmpMM:VersionID, xmpMM:RenditionClass absent/);
  });

  describe('output intent', () => {
    it.each<[string, Fields, 'violation' | 'passed', boolean]>([
      // Each identifier case carries Info, so that only the identifier check can report the violation.
      ['without OutputConditionIdentifier', [['OutputConditionIdentifier', undefined], info], 'violation', false],
      ['with an empty OutputConditionIdentifier', [['OutputConditionIdentifier', pdfLiteralString('')], info], 'violation', false],
      ['with OutputConditionIdentifier written as a name', [['OutputConditionIdentifier', pdfName('FOGRA39')], info], 'violation', false],
      ['for an unregistered condition without Info', [['OutputConditionIdentifier', pdfLiteralString('Custom')]], 'violation', false],
      [
        'for an unregistered condition with Info',
        [
          ['OutputConditionIdentifier', pdfLiteralString('Custom')],
          ['Info', pdfLiteralString('x')],
        ],
        'passed',
        false,
      ],
      ['for a registered condition without RegistryName', [], 'passed', true],
      ['for a registered condition with RegistryName', [['RegistryName', pdfLiteralString('http://www.color.org')]], 'passed', false],
    ])('checks the entries of an intent %s', (_, overrides, status, recommendsRegistry) => {
      // ISO 32000-1:2008, 14.11.5, Table 365: OutputConditionIdentifier is required, and Info is required when it names no registered condition.
      const entry = finding(
        withIntents(document => [pdfxIntent(document, overrides)]),
        'X4-OI-ENTRIES',
      );
      expect([entry?.status, /RegistryName/.test(entry?.detail ?? '')]).toStrictEqual([status, recommendsRegistry]);
    });

    it('finds the GTS_PDFX intent after an intent of another subtype', () => {
      const document = withIntents(document => [[['S', pdfName('GTS_PDFA1')]], pdfxIntent(document)]);
      expect([statusOf(document, 'X4-OI-PRESENT'), statusOf(document, 'X4-OI-ENTRIES'), statusOf(document, 'X4-OI-PROFILE')]).toStrictEqual([
        'passed',
        'passed',
        'passed',
      ]);
    });

    it('reports no GTS_PDFX intent when only another subtype is present', () => {
      const document = withIntents(document => [pdfxIntent(document, [['S', pdfName('GTS_PDFA1')]])]);
      expect(statusOf(document, 'X4-OI-PRESENT')).toBe('violation');
    });

    it('reports no GTS_PDFX intent when OutputIntents is a dictionary rather than an array', () => {
      const document = raw();
      setCatalogEntry(document, 'OutputIntents', pdfDictionary(entries(pdfxIntent(document))));
      expect([statusOf(document, 'X4-OI-PRESENT'), statusOf(document, 'X4-OI-ENTRIES'), statusOf(document, 'X4-OI-PROFILE')]).toStrictEqual([
        'violation',
        'not-checked',
        'not-checked',
      ]);
    });

    const profileCases: ReadonlyArray<[string, (document: LoadedDocument) => Fields, 'violation' | 'passed' | 'not-checked', RegExp]> = [
      ['an absent DestOutputProfile', document => pdfxIntent(document, [['DestOutputProfile', undefined]]), 'violation', /not an embedded ICC stream/],
      ['a DestOutputProfile dictionary', document => pdfxIntent(document, [['DestOutputProfile', pdfDictionary()]]), 'violation', /not an embedded ICC stream/],
      [
        'a profile stream that does not decode',
        document => pdfxIntent(document, [['DestOutputProfile', stream(document, new TextEncoder().encode('garbage'), [['Filter', pdfName('FlateDecode')]])]]),
        'violation',
        /could not be decoded/,
      ],
      ['200 bytes that are not an ICC profile', document => pdfxIntent(document, [], new Uint8Array(200).fill(7)), 'violation', /invalid or unsupported/],
      [
        'a five-colorant profile',
        document => pdfxIntent(document, [], iccProfileBytes({ profileClass: 'prtr', colorSpace: '5CLR', pcs: 'Lab ', tags: [] })),
        'violation',
        /colour space/,
      ],
      [
        'a CMYK profile without BToA tags',
        document => pdfxIntent(document, [], iccProfileBytes({ profileClass: 'prtr', colorSpace: 'CMYK', pcs: 'Lab ', tags: [] })),
        'violation',
        /BToA/,
      ],
      [
        'an output profile with BToA0 for a registered condition',
        document => pdfxIntent(document, [], rgbProfile('prtr', ['B2A0'])),
        'passed',
        /output transform/,
      ],
      [
        'an output profile without AToB1 for an unregistered condition',
        document =>
          pdfxIntent(
            document,
            [
              ['OutputConditionIdentifier', pdfLiteralString('Custom')],
              ['Info', pdfLiteralString('x')],
            ],
            rgbProfile('prtr', ['B2A0']),
          ),
        'not-checked',
        /AtoB1/,
      ],
      [
        'an output profile with AToB1 for an unregistered condition',
        document =>
          pdfxIntent(
            document,
            [
              ['OutputConditionIdentifier', pdfLiteralString('Custom')],
              ['Info', pdfLiteralString('x')],
            ],
            rgbProfile('prtr', ['B2A0', 'A2B1']),
          ),
        'passed',
        /output transform/,
      ],
      ['a display profile with BToA0', document => pdfxIntent(document, [], rgbProfile('mntr', ['B2A0'])), 'not-checked', /not output class/],
    ];

    it.each(profileCases)('checks %s', (_, intent, status, detail) => {
      const entry = finding(
        withIntents(document => [intent(document)]),
        'X4-OI-PROFILE',
      );
      expect(entry?.status).toBe(status);
      expect(entry?.detail).toMatch(detail);
    });

    it.each<[number, 'violation' | 'not-checked', RegExp]>([
      [24 * 1024 * 1024, 'violation', /invalid or unsupported/],
      [24 * 1024 * 1024 + 1, 'not-checked', /24 MiB/],
    ])('parses a %i-byte profile only up to the 24 MiB limit', (size, status, detail) => {
      const document = withIntents(document => [pdfxIntent(document, [], new Uint8Array(size))], { maxDecodedBytes: 32 * 1024 * 1024 });
      const entry = finding(document, 'X4-OI-PROFILE');
      expect(entry?.status).toBe(status);
      expect(entry?.detail).toMatch(detail);
    });
  });

  describe('metadata', () => {
    it.each<[string, ReadonlyArray<string>, 'violation' | 'passed']>([
      ['one PDF/X-4 value', [version('PDF/X-4')], 'passed'],
      ['two PDF/X-4 values', [version('PDF/X-4'), version('PDF/X-4')], 'violation'],
      ['the value PDF/X-4p', [version('PDF/X-4p')], 'violation'],
    ])('checks an XMP packet with %s', (_, packet, status) => {
      expect(statusOf(withMetadata(undefined, packet), 'X4-XMP-VERSION')).toBe(status);
    });

    it.each<[string, 'violation' | 'passed']>([
      ['/Trapped/True', 'passed'],
      ['/Trapped/False', 'passed'],
      ['/Trapped/Unknown', 'violation'],
      ['/Trapped(True)', 'violation'],
    ])('checks Info %s', (info, status) => {
      // ISO 32000-1:2008, Table 317 makes Trapped a name; CGATS Application Notes (2006), 2.17 asks for True or False.
      expect(statusOf(withMetadata(info, undefined), 'X4-TRAPPED')).toBe(status);
    });

    it.each<[string, string, ReadonlyArray<string> | undefined, 'violation' | 'passed']>([
      ['agrees with XMP True', '/Trapped/True', [trappedXmp('True')], 'passed'],
      ['disagrees with XMP False', '/Trapped/True', [trappedXmp('False')], 'violation'],
      ['has no XMP packet', '/Trapped/True', undefined, 'violation'],
    ])('checks Info Trapped that %s', (_, info, packet, status) => {
      // XMP Specification Part 3, Table 20 maps Info Trapped to pdf:Trapped.
      expect(statusOf(withMetadata(info, packet), 'X4-TRAPPED-XMP')).toBe(status);
    });
  });

  describe('page boxes', () => {
    it('flags both print-area boxes on one page', () => {
      const document = prepared();
      document.page(0).setBox('ArtBox', [pt(0), pt(0), pt(100), pt(100)]);
      const entry = finding(document, 'X4-BOXES');
      expect(entry?.status).toBe('violation');
      expect(entry?.location).toBe('page 0');
    });

    it.each<[string, 'violation' | 'passed', RegExp]>([
      ['/TrimBox[0 0 100 100]', 'passed', /inside/],
      ['/ArtBox[10 10 90 90]', 'passed', /inside/],
      ['/TrimBox[-1 0 100 100]', 'violation', /MediaBox/],
      ['/TrimBox[0 0 101 100]', 'violation', /MediaBox/],
      ['/BleedBox[10 10 90 90]/TrimBox[10 10 90 90]', 'passed', /inside/],
      ['/BleedBox[10 10 90 90]/TrimBox[10 10 90 91]', 'violation', /BleedBox/],
      ['/CropBox[10 10 90 90]/TrimBox[10 10 90 90]', 'passed', /inside/],
      ['/CropBox[10 10 90 90]/TrimBox[10 9 90 90]', 'violation', /CropBox/],
    ])('checks a page with %s inside MediaBox [0 0 100 100]', (boxes, status, detail) => {
      // CGATS Application Notes (2006), 2.10 and ISO 32000-1:2008, 14.11.2: the trim or art box lies within the media, bleed and crop boxes.
      const entry = finding(raw({ page: `${boxes}/Resources<<>>` }), 'X4-BOXES');
      expect(entry?.status).toBe(status);
      expect(entry?.detail).toMatch(detail);
    });

    it('names the first page whose box is wrong', () => {
      const document = loadDocument(
        buildPdf([
          {
            xref: 'classic',
            objects: [
              { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
              { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>' },
              { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/TrimBox[0 0 100 100]/Resources<<>>>>' },
              { number: 4, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/TrimBox[0 0 100 101]/Resources<<>>>>' },
            ],
            trailer: '/Root 1 0 R',
          },
        ]).bytes,
      );
      expect(finding(document, 'X4-BOXES')?.location).toBe('page 1');
    });
  });

  describe('actions and forms', () => {
    it.each<[string, string, (document: LoadedDocument) => PdfDirectObject, 'violation' | 'passed' | 'not-checked']>([
      ['a JavaScript name tree', 'Names', document => pdfDictionary(entries([['JavaScript', document.object(pdfDictionary())]])), 'violation'],
      ['a reachable JavaScript action', 'OpenAction', document => action(document, 'JavaScript'), 'violation'],
      ['a reachable URI action', 'OpenAction', document => action(document, 'URI'), 'passed'],
      ['a JavaScript action whose S is indirect', 'OpenAction', document => action(document, 'JavaScript', true), 'violation'],
      ['a URI action whose S is indirect', 'OpenAction', document => action(document, 'URI', true), 'passed'],
      ['an additional action that runs JavaScript', 'AA', document => pdfDictionary(entries([['O', action(document, 'JavaScript')]])), 'violation'],
      ['an additional action that opens a URI', 'AA', document => pdfDictionary(entries([['O', action(document, 'URI')]])), 'not-checked'],
    ])('checks a document with %s', (_, name, value, status) => {
      const document = prepared();
      setCatalogEntry(document, name, value(document));
      expect(statusOf(document, 'X4-JS')).toBe(status);
    });

    const stale = { number: 9, body: '/JavaScript' };
    it.each<[string, ReadonlyArray<TestObject>, LoadOptions, 'violation' | 'passed' | 'not-checked']>([
      ['alone', [{ number: 4, body: '<</S 9 1 R/JS(x)>>' }, stale], {}, 'not-checked'],
      [
        'followed by a JavaScript action',
        [{ number: 4, body: '<</S 9 1 R/JS(x)/Next 5 0 R>>' }, { number: 5, body: '<</S/JavaScript/JS(x)>>' }, stale],
        {},
        'violation',
      ],
      [
        'after a JavaScript action',
        [{ number: 4, body: '<</S/JavaScript/JS(x)/Next 5 0 R>>' }, { number: 5, body: '<</S 9 1 R/JS(x)>>' }, stale],
        {},
        'violation',
      ],
      ['alone, loaded to read it as null', [{ number: 4, body: '<</S 9 1 R/JS(x)>>' }, stale], { generationMismatch: 'null' }, 'passed'],
    ])('checks an action whose S names another generation of an object, %s', (_, extra, options, status) => {
      const report = checkPdfX4(raw({ catalog: '/OpenAction 4 0 R', extra }, options));
      expect(report.findings.map(item => item.rule)).toStrictEqual(pdfX4Rules.map(rule => rule.id));
      expect(report.findings.find(item => item.rule === 'X4-JS')?.status).toBe(status);
    });

    it.each<[string, (document: LoadedDocument) => Fields, 'violation' | 'passed' | 'not-checked']>([
      [
        'an XFA entry',
        document => [
          ['Fields', pdfArray([])],
          ['XFA', document.object(pdfDictionary())],
        ],
        'violation',
      ],
      ['an empty Fields array', () => [['Fields', pdfArray([])]], 'passed'],
      ['one field', document => [['Fields', pdfArray([document.object(pdfDictionary(entries([['FT', pdfName('Tx')]])))])]], 'violation'],
      ['no Fields entry', () => [], 'not-checked'],
    ])('checks an AcroForm with %s', (_, fields, status) => {
      const document = prepared();
      setCatalogEntry(document, 'AcroForm', pdfDictionary(entries(fields(document))));
      expect(statusOf(document, 'X4-FORMS')).toBe(status);
    });
  });

  describe('LZW', () => {
    it('finds an LZW filter in reachable objects', () => {
      const document = prepared();
      setCatalogEntry(document, 'Extra', stream(document, Uint8Array.of(0), [['Filter', pdfName('LZWDecode')]]));
      expect(statusOf(document, 'X4-LZW')).toBe('violation');
    });

    it('ignores an LZW stream that nothing references', () => {
      const document = prepared();
      stream(document, Uint8Array.of(0), [['Filter', pdfName('LZWDecode')]]);
      expect(statusOf(document, 'X4-LZW')).toBe('passed');
    });

    it('finds an indirect LZW filter inside an indirect filter array', () => {
      const document = prepared();
      const filter = document.object(pdfName('LZWDecode'));
      const filters = document.object(pdfArray([pdfName('ASCII85Decode'), filter]));
      setCatalogEntry(document, 'Extra', stream(document, Uint8Array.of(0), [['Filter', filters]]));
      expect(statusOf(document, 'X4-LZW')).toBe('violation');
    });

    it.each<[string, string]>([
      ['after', '[9 1 R/LZWDecode]'],
      ['before', '[/LZWDecode 9 1 R]'],
    ])('finds an LZW filter %s a filter that names another generation of an object', (_, filters) => {
      const report = checkPdfX4(
        raw({
          catalog: '/X 5 0 R',
          extra: [
            { number: 5, body: streamBody(`/Filter${filters}`, 'x') },
            { number: 9, body: '/x' },
          ],
        }),
      );
      expect(report.findings.map(item => item.rule)).toStrictEqual(pdfX4Rules.map(rule => rule.id));
      expect(report.findings.find(item => item.rule === 'X4-LZW')?.status).toBe('violation');
    });

    it.each<[string, string, 'violation' | 'not-checked']>([
      ['alone', '', 'not-checked'],
      ['beside another stream with an LZW filter', '/Y 6 0 R', 'violation'],
    ])('checks a stream whose Filter names another generation of an object, %s', (_, other, status) => {
      const report = checkPdfX4(
        raw({
          catalog: `/X 5 0 R${other}`,
          extra: [
            { number: 5, body: streamBody('/Filter 9 1 R', 'x') },
            { number: 6, body: streamBody('/Filter/LZWDecode', 'x') },
            { number: 9, body: '/LZWDecode' },
          ],
        }),
      );
      expect(report.findings.map(item => item.rule)).toStrictEqual(pdfX4Rules.map(rule => rule.id));
      expect(report.findings.find(item => item.rule === 'X4-LZW')?.status).toBe(status);
    });

    it.each<[string, 'violation' | 'passed']>([
      ['BI /W 1 /H 1 /BPC 8 /CS /G /F /AHx ID\n00>\nEI', 'passed'],
      [lzwImage, 'violation'],
      ['BI /W 1 /H 1 /BPC 8 /CS /G /Filter /LZWDecode ID\nX\nEI', 'violation'],
      ['BI /W 1 /H 1 /BPC 8 /CS /G /F [/AHx /LZW] ID\nX\nEI', 'violation'],
    ])('checks the inline image %j in page content', (content, status) => {
      const document = prepared();
      setPageEntry(document, 0, 'Contents', stream(document, new TextEncoder().encode(content)));
      expect(statusOf(document, 'X4-LZW')).toBe(status);
    });

    it.each<[string, string, ReadonlyArray<TestObject>]>([
      [
        'a Type 3 glyph description',
        '/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R',
        [
          { number: 4, body: streamBody('', 'BT /F1 12 Tf (a) Tj ET') },
          {
            number: 5,
            body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<</a 6 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1]>>',
          },
          { number: 6, body: streamBody('', `0 0 d0 ${lzwImage}`) },
        ],
      ],
      [
        'an appearance state stream that omits its Subtype',
        '/Resources<<>>/Annots[4 0 R]',
        [
          { number: 4, body: '<</Type/Annot/Subtype/Square/Rect[0 0 1 1]/AS/On/AP<</N<</On 5 0 R>>>>>>' },
          { number: 5, body: streamBody('/BBox[0 0 1 1]', lzwImage) },
        ],
      ],
      [
        'a direct normal appearance stream',
        '/Resources<<>>/Annots[4 0 R]',
        [
          { number: 4, body: '<</Type/Annot/Subtype/Square/Rect[0 0 1 1]/AP<</N 5 0 R>>>>' },
          { number: 5, body: streamBody('/BBox[0 0 1 1]', lzwImage) },
        ],
      ],
      [
        'a down appearance stream',
        '/Resources<<>>/Annots[4 0 R]',
        [
          { number: 4, body: '<</Type/Annot/Subtype/Square/Rect[0 0 1 1]/AP<</N 6 0 R/D 5 0 R>>>>' },
          { number: 5, body: streamBody('/BBox[0 0 1 1]', lzwImage) },
          { number: 6, body: streamBody('/BBox[0 0 1 1]', '') },
        ],
      ],
      [
        'a form XObject the page draws',
        '/Resources<</XObject<</X1 5 0 R>>>>/Contents 4 0 R',
        [
          { number: 4, body: streamBody('', '/X1 Do') },
          { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]', lzwImage) },
        ],
      ],
      [
        'a tiling pattern',
        '/Resources<</Pattern<</P1 5 0 R>>>>/Contents 4 0 R',
        [
          { number: 4, body: streamBody('', '/Pattern cs /P1 scn 0 0 1 1 re f') },
          { number: 5, body: streamBody('/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1/Resources<<>>', lzwImage) },
        ],
      ],
    ])('finds LZW in an inline image inside %s', (_, page, extra) => {
      // ISO 32000-1:2008, 8.9.7: inline images occur in any content stream, including forms, patterns, appearances and glyph descriptions.
      expect(statusOf(prepared({ page, extra }), 'X4-LZW')).toBe('violation');
    });

    it.each<[string, string, 'not-checked' | 'passed']>([
      ['page content that decodes', streamBody('', '0 0 1 1 re f'), 'passed'],
      ['page content that does not decode', streamBody('/Filter/FlateDecode', 'garbage'), 'not-checked'],
    ])('checks inline images only when it can read %s', (_, content, status) => {
      const document = raw({ page: '/Resources<<>>/Contents 4 0 R', extra: [{ number: 4, body: content }] });
      expect([statusOf(document, 'X4-LZW'), statusOf(document, 'X4-EMBEDDED')]).toStrictEqual([status, 'passed']);
    });

    it.each<[string, string, 'not-checked' | 'passed']>([
      ['decodes', streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]', '0 0 1 1 re f'), 'passed'],
      ['does not decode', streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Filter/FlateDecode', 'garbage'), 'not-checked'],
    ])('checks inline images only when a form XObject %s', (_, form, status) => {
      const document = raw({ page: '/Resources<</XObject<</X1 5 0 R>>>>', extra: [{ number: 5, body: form }] });
      expect(statusOf(document, 'X4-LZW')).toBe(status);
    });
  });

  it.each<PdfX4RuleId>(['X4-LZW', 'X4-EMBEDDED', 'X4-EXTERNAL', 'X4-JS'])('leaves %s not checked while a reachable object cannot be parsed', rule => {
    const readable = raw({ page: '/Resources<<>>/Extra 9 0 R', extra: [{ number: 9, body: '<</A 1>>' }] });
    const unreadable = raw({ page: '/Resources<<>>/Extra 9 0 R', extra: [{ number: 9, body: '<</A 1' }] });
    expect([statusOf(readable, rule), statusOf(unreadable, rule)]).toStrictEqual(['passed', 'not-checked']);
  });

  describe('embedded and external content', () => {
    it.each<[string, (document: LoadedDocument) => PdfDirectObject, 'violation' | 'passed']>([
      ['a plain stream', document => stream(document, Uint8Array.of(1), [['Type', pdfName('XObject')]]), 'passed'],
      ['an EmbeddedFile stream without a file specification', document => stream(document, Uint8Array.of(1), [['Type', pdfName('EmbeddedFile')]]), 'violation'],
      ['a file specification with EF', document => document.object(pdfDictionary(entries([['EF', pdfName('SomeData')]]))), 'violation'],
      [
        'an EmbeddedFiles name tree',
        document => pdfDictionary(entries([['EmbeddedFiles', document.object(pdfDictionary(entries([['Names', pdfArray([])]])))]])),
        'violation',
      ],
      [
        'a FileAttachment annotation',
        document =>
          document.object(
            pdfDictionary(
              entries([
                ['Type', pdfName('Annot')],
                ['Subtype', pdfName('FileAttachment')],
              ]),
            ),
          ),
        'violation',
      ],
      // ISO 32000-1:2008, 7.3.10: Subtype and Type may be indirect references to the name.
      ['a FileAttachment annotation whose Subtype is indirect', document => annotation(document, document.object(pdfName('FileAttachment'))), 'violation'],
      ['a Text annotation whose Subtype is indirect', document => annotation(document, document.object(pdfName('Text'))), 'passed'],
      [
        'a stream whose Type EmbeddedFile is indirect',
        document => stream(document, Uint8Array.of(1), [['Type', document.object(pdfName('EmbeddedFile'))]]),
        'violation',
      ],
      ['a stream whose Type XObject is indirect', document => stream(document, Uint8Array.of(1), [['Type', document.object(pdfName('XObject'))]]), 'passed'],
    ])('checks a catalog that references %s', (_, value, status) => {
      const document = raw();
      setCatalogEntry(document, 'Extra', value(document));
      expect(statusOf(document, 'X4-EMBEDDED')).toBe(status);
    });

    it.each<[string, TestObject, LoadOptions, 'passed' | 'not-checked']>([
      ['an annotation whose Subtype', { number: 4, body: '<</Type/Annot/Subtype 9 1 R>>' }, {}, 'not-checked'],
      ['a stream whose Type', { number: 4, body: streamBody('/Type 9 1 R', 'x') }, {}, 'not-checked'],
      [
        'an annotation whose Subtype, loaded to read it as null,',
        { number: 4, body: '<</Type/Annot/Subtype 9 1 R>>' },
        { generationMismatch: 'null' },
        'passed',
      ],
    ])('checks a catalog that references %s names another generation of an object', (_, object, options, status) => {
      const report = checkPdfX4(raw({ catalog: '/Extra 4 0 R', extra: [object, { number: 9, body: '/FileAttachment' }] }, options));
      expect(report.findings.map(item => item.rule)).toStrictEqual(pdfX4Rules.map(rule => rule.id));
      expect(report.findings.find(item => item.rule === 'X4-EMBEDDED')?.status).toBe(status);
    });

    it.each<[string, ReadonlyArray<TestObject>]>([
      ['a direct Type EmbeddedFile', [{ number: 5, body: '<</Type/EmbeddedFile/Subtype 9 1 R>>' }]],
      [
        'an indirect Type EmbeddedFile',
        [
          { number: 5, body: '<</Type 7 0 R/Subtype 9 1 R>>' },
          { number: 7, body: '/EmbeddedFile' },
        ],
      ],
      ['a direct Subtype FileAttachment', [{ number: 5, body: '<</Type 9 1 R/Subtype/FileAttachment>>' }]],
    ])('finds %s beside an entry that names another generation of an object', (_, objects) => {
      const report = checkPdfX4(raw({ catalog: '/X 5 0 R', extra: [...objects, { number: 9, body: '/x' }] }));
      expect(report.findings.map(item => item.rule)).toStrictEqual(pdfX4Rules.map(rule => rule.id));
      expect(report.findings.find(item => item.rule === 'X4-EMBEDDED')?.status).toBe('violation');
    });

    it.each<[string, (document: LoadedDocument) => PdfDirectObject, 'violation' | 'passed']>([
      ['a stream with Ref', document => stream(document, Uint8Array.of(1), [['Ref', pdfDictionary()]]), 'violation'],
      ['a stream with Alternates', document => stream(document, Uint8Array.of(1), [['Alternates', pdfArray([])]]), 'violation'],
      ['a stream with OPI', document => stream(document, Uint8Array.of(1), [['OPI', pdfDictionary()]]), 'violation'],
      ['a dictionary with OPI', document => document.object(pdfDictionary(entries([['OPI', pdfDictionary()]]))), 'passed'],
    ])('checks a catalog that references %s', (_, value, status) => {
      // ISO 32000-1:2008, 8.10.4, 8.9.5.4 and 14.11.7: reference XObjects, alternate images and OPI entries belong to XObject streams.
      const document = raw();
      setCatalogEntry(document, 'Extra', value(document));
      expect(statusOf(document, 'X4-EXTERNAL')).toBe(status);
    });
  });

  describe('properties', () => {
    it('reports the same statuses after a save and reload', () => {
      fc.assert(
        fc.property(
          fc.record({
            trapped: fc.constantFrom('', '/Trapped/True', '/Trapped/False', '/Trapped(True)'),
            boxes: fc.constantFrom('', '/TrimBox[0 0 100 100]', '/ArtBox[10 10 90 90]', '/TrimBox[0 0 100 101]', '/TrimBox[0 0 100 100]/ArtBox[0 0 100 100]'),
            lzw: fc.boolean(),
            fields: fc.constantFrom('', '/AcroForm<<>>', '/AcroForm<</Fields[]>>', '/AcroForm<</Fields[5 0 R]>>'),
            prepare: fc.boolean(),
          }),
          ({ trapped, boxes, lzw, fields, prepare }) => {
            const document = raw({
              page: `${boxes}/Resources<<>>${lzw ? '/Extra 6 0 R' : ''}`,
              catalog: fields,
              trailer: '/Info 4 0 R',
              extra: [
                { number: 4, body: `<<${trapped}>>` },
                { number: 5, body: '<</FT/Tx/T(a)>>' },
                { number: 6, body: streamBody('/Filter/LZWDecode', 'x') },
              ],
            });
            if (prepare) {
              writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
              writePdfX4Metadata(document, { metadataDate: date, trapped: 'True' });
            }
            expect(statuses(loadDocument(document.save().toBytes()))).toStrictEqual(statuses(document));
          },
        ),
      );
    });
  });
});

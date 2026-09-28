import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { MetadataInput } from './resolveMetadata.ts';
import type { XmpValue } from './xmp/readXmp.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ValidationError } from '../error/validationError.ts';
import { pdfInteger, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { formatUuid } from './identifiers.ts';
import { readMetadata } from './readMetadata.ts';
import { setMetadata } from './setMetadata.ts';

const NAMESPACES =
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"';

const packet = (body: string): string =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ${NAMESPACES}><rdf:Description rdf:about="">${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const ID = `/ID[<${'0123456789abcdef'.repeat(2)}><${'ff'.repeat(16)}>]`;
const FIRST_ID = Uint8Array.of(0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef);
const MODIFIED = pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: { sign: '+', hours: 9, minutes: 0 } });
const INPUT: MetadataInput = { title: 'Proof', author: '山田 太郎', producer: 'pdfwright', modificationDate: MODIFIED };

const source = (catalog: string, objects: readonly TestObject[], trailer: string): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<<>>>>' },
        ...objects,
      ],
      trailer: `/Root 1 0 R${trailer}`,
    },
  ]).bytes;

const load = (catalog: string, objects: readonly TestObject[] = [], trailer = ID): LoadedDocument => loadDocument(source(catalog, objects, trailer));

const saved = (document: LoadedDocument): LoadedDocument => loadDocument(document.save().chunks);

const agreements = (document: LoadedDocument): Record<string, string> =>
  Object.fromEntries(readMetadata(document).properties.map(property => [property.key, property.agreement]));

const codes = (document: LoadedDocument): readonly string[] => readMetadata(document).findings.map(finding => finding.code);

const infoText = (document: LoadedDocument, key: string): string | undefined => {
  const value = readMetadata(document).info?.values.get(key);
  return value?.kind === 'text' ? value.text : undefined;
};

const packetProperties = (document: LoadedDocument): readonly string[] => {
  const { xmp } = readMetadata(document);
  return xmp !== undefined && 'packet' in xmp ? xmp.packet.properties.map(property => property.localName) : [];
};

const instanceIdOf = (document: LoadedDocument): string => {
  const { xmp } = readMetadata(document);
  const value = xmp !== undefined && 'packet' in xmp ? xmp.packet.properties.find(property => property.localName === 'InstanceID')?.value : undefined;
  return value?.kind === 'text' ? value.text : '';
};

const unreadable = (): LoadedDocument => load('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', '<!DOCTYPE x><x/>') }]);

const signed = (): LoadedDocument =>
  load('/AcroForm<</Fields[]/SigFlags 3>>/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) }]);

// The InstanceID setMetadata reports and the one the save writes, for the default edit with or without one more object added after it.
const instanceIds = (extra: readonly PdfDirectObject[]): readonly [string, string] => {
  const document = load('');
  const change = setMetadata(document, INPUT);
  for (const value of extra) document.object(value);
  return [change.instanceId, instanceIdOf(saved(document))];
};

const editedBytes = (): string => {
  const document = load('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('<xmp:Rating>1</xmp:Rating>')) }]);
  setMetadata(document, INPUT);
  return latin1Text(document.save().toBytes());
};

// The object numbers changed, the trailer changes, the full-rewrite reason and whether a save hook is set.
const editState = (document: LoadedDocument): readonly unknown[] => {
  const objects = internalsOf(document)?.objects;
  return [[...(objects?.changes.keys() ?? [])], objects?.trailerChanges, objects?.fullRewriteReason, objects?.saveHook !== undefined];
};

// The InstanceID a save writes after one edit of a document with a packet and an Info dictionary.
const editedInstanceId = (input: MetadataInput): string => {
  const document = load(
    '/Metadata 4 0 R',
    [
      { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) },
      { number: 5, body: '<<>>' },
    ],
    `${ID}/Info 5 0 R`,
  );
  setMetadata(document, input);
  return instanceIdOf(saved(document));
};

const CREATORS = '<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li><rdf:li>C</rdf:li></rdf:Seq></dc:creator>';
const TITLES = '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">T</rdf:li><rdf:li xml:lang="ja">題</rdf:li></rdf:Alt></dc:title>';

// UTF-8 packet text as the latin1 string the builder writes byte for byte.
const utf8 = (text: string): string => latin1Text(new TextEncoder().encode(text));

const ARRAYS_PACKET = streamBody('/Type/Metadata/Subtype/XML', utf8(packet(`${CREATORS}${TITLES}`)));

const withArrays = (info = '<<>>'): LoadedDocument =>
  load(
    '/Metadata 4 0 R',
    [
      { number: 4, body: ARRAYS_PACKET },
      { number: 5, body: info },
    ],
    `${ID}/Info 5 0 R`,
  );

// The Info CreationDate and the xmp:CreateDate a save writes after an edit that leaves the creation date out.
const creationDates = (info: string, xmp: string): readonly unknown[] => {
  const document = load(
    '/Metadata 4 0 R',
    [
      { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet(xmp)) },
      { number: 5, body: info },
    ],
    `${ID}/Info 5 0 R`,
  );
  setMetadata(document, { modificationDate: MODIFIED, producer: 'P' });
  const reloaded = readMetadata(saved(document));
  const row = reloaded.properties.find(property => property.key === 'CreationDate');
  return [row?.info, row?.xmp, row?.agreement];
};

const xmpText = (value: string): XmpValue => ({ kind: 'text', text: value, language: undefined });

const UNREAD_INFO = '<</Title/Foo/Subject/Bar/CreationDate(Tue May 06 2020)/Trapped(True)/ModDate 12>>';

const withUnreadInfo = (): LoadedDocument =>
  load(
    '/Metadata 4 0 R',
    [
      {
        number: 4,
        body: streamBody('/Type/Metadata/Subtype/XML', packet('<dc:description><rdf:Alt><rdf:li xml:lang="x-default">S</rdf:li></rdf:Alt></dc:description>')),
      },
      { number: 5, body: UNREAD_INFO },
    ],
    `${ID}/Info 5 0 R`,
  );

const UNPARSED_XMP = '<xmp:CreateDate>not a date</xmp:CreateDate><pdf:Trapped>maybe</pdf:Trapped>';

const withUnparsedXmp = (info: string): LoadedDocument =>
  load(
    '/Metadata 4 0 R',
    [
      { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet(UNPARSED_XMP)) },
      { number: 5, body: info },
    ],
    `${ID}/Info 5 0 R`,
  );

const hexOf = (text: string): string => [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, '0')).join('');

const packetCount = (document: LoadedDocument): number => latin1Text(document.save().toBytes()).split('<?xpacket begin=').length - 1;

describe('setting document metadata', () => {
  it('keeps one packet after editing a metadata stream with two concatenated packets', () => {
    const document = load('/Metadata 4 0 R', [
      {
        number: 4,
        body: streamBody('/Type/Metadata/Subtype/XML', `${packet('<pdf:Producer>old</pdf:Producer>')}${packet('<pdf:Producer>stale</pdf:Producer>')}`),
      },
    ]);
    expect(codes(document)).toContain('extra-xmp-packet');
    setMetadata(document, INPUT);
    const reloaded = saved(document);
    expect([packetCount(document), codes(reloaded), agreements(reloaded)['Producer']]).toStrictEqual([1, [], 'agree']);
  });

  it('reports the rewrite requirement retained from an earlier metadata edit', () => {
    const document = load('');
    setMetadata(document, INPUT);
    const change = setMetadata(document, INPUT, { revisions: 'keep' });
    expect(change.saveMode).toBe('full-required');
    expect(() => document.save({ mode: 'incremental' })).toThrow(expect.objectContaining({ reason: 'metadata-history' }));
  });

  it('writes Info and a new packet that agree into a document that has neither', () => {
    const document = load('');
    const change = setMetadata(document, INPUT);
    const reloaded = saved(document);
    expect([change.documentId, change.saveMode, document.save().mode, codes(reloaded), readMetadata(reloaded).authority]).toStrictEqual([
      formatUuid(FIRST_ID),
      'full-required',
      'full',
      [],
      'xmp',
    ]);
    expect(agreements(reloaded)).toStrictEqual({
      Title: 'agree',
      Author: 'agree',
      Subject: 'absent',
      Keywords: 'absent',
      Creator: 'absent',
      Producer: 'agree',
      CreationDate: 'absent',
      ModDate: 'agree',
      Trapped: 'absent',
    });
  });

  it('keeps unmanaged Info keys, replaces a direct Info with an indirect one and removes values set to null', () => {
    const document = load('', [], `${ID}/Info<</Custom(kept)/Subject(gone)/Keywords(kept too)>>`);
    setMetadata(document, { ...INPUT, subject: null });
    const reloaded = saved(document);
    expect([
      infoText(reloaded, 'Custom'),
      infoText(reloaded, 'Subject'),
      infoText(reloaded, 'Keywords'),
      readMetadata(reloaded).info?.reference !== undefined,
    ]).toStrictEqual(['kept', undefined, 'kept too', true]);
  });

  it('reports replacing a direct Info dictionary with an indirect one', () => {
    const change = setMetadata(load('', [], `${ID}/Info<</Custom(kept)>>`), INPUT);
    expect(change.findings.map(finding => finding.code)).toStrictEqual(['info-not-indirect']);
    expect(setMetadata(load(''), INPUT).findings).toStrictEqual([]);
  });

  it('reports re-encoding a packet as UTF-8', () => {
    const utf16 = Uint8Array.from([0xfe, 0xff, ...[...new TextEncoder().encode(packet(''))].flatMap(byte => [0, byte])]);
    const document = load('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', latin1Text(utf16)) }]);
    expect(setMetadata(document, INPUT).findings.map(finding => finding.code)).toStrictEqual(['xmp-transcoded']);
  });

  it('writes no empty value on either side', () => {
    const document = load(
      '/Metadata 4 0 R',
      [
        {
          number: 4,
          body: streamBody('/Type/Metadata/Subtype/XML', packet('<dc:description><rdf:Alt><rdf:li xml:lang="x-default"/></rdf:Alt></dc:description>')),
        },
        { number: 5, body: '<</Keywords()>>' },
      ],
      `${ID}/Info 5 0 R`,
    );
    setMetadata(document, { ...INPUT, title: '' });
    const reloaded = saved(document);
    const rows = agreements(reloaded);
    expect([rows['Title'], rows['Subject'], rows['Keywords'], codes(reloaded)]).toStrictEqual(['absent', 'absent', 'absent', []]);
  });

  it('leaves packet properties that agree with the resolved value as they are, and fills Info from them', () => {
    const document = withArrays();
    const change = setMetadata(document, { modificationDate: MODIFIED, keywords: 'k' });
    const bytes = latin1Text(document.save().toBytes());
    const reloaded = saved(document);
    const rows = agreements(reloaded);
    const kept = [bytes.includes(CREATORS), bytes.includes(utf8(TITLES))];
    expect([change.reconciled, ...kept, infoText(reloaded, 'Author'), infoText(reloaded, 'Title'), rows['Author'], rows['Title']]).toStrictEqual([
      [],
      true,
      true,
      'A',
      'T',
      'agree',
      'agree',
    ]);
  });

  it('lists every item it discards when it writes one', () => {
    const set = setMetadata(withArrays(), { modificationDate: MODIFIED, title: 'T', author: 'Z' });
    const fromInfo = setMetadata(withArrays('<</Author(Info author)/ModDate(D:20300101000000Z)>>'), { modificationDate: MODIFIED });
    expect([set.reconciled, fromInfo.reconciled]).toStrictEqual([
      [
        { key: 'Title', from: 'input', discarded: '題' },
        { key: 'Author', from: 'input', discarded: 'A' },
        { key: 'Author', from: 'input', discarded: 'B' },
        { key: 'Author', from: 'input', discarded: 'C' },
      ],
      [
        { key: 'Author', from: 'info', discarded: 'A' },
        { key: 'Author', from: 'info', discarded: 'B' },
        { key: 'Author', from: 'info', discarded: 'C' },
      ],
    ]);
  });

  it('leaves a managed property in a form it does not read as it is, unless the input sets it', () => {
    const opaque = '<dc:title rdf:parseType="Resource"><rdf:value>T</rdf:value></dc:title>';
    const document = (): LoadedDocument =>
      load(
        '/Metadata 4 0 R',
        [
          { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet(opaque)) },
          { number: 5, body: '<</Title(Info title)>>' },
        ],
        `${ID}/Info 5 0 R`,
      );
    const kept = document();
    const change = setMetadata(kept, { modificationDate: MODIFIED, producer: 'P' });
    const bytes = latin1Text(kept.save().toBytes());
    const replaced = setMetadata(document(), { modificationDate: MODIFIED, title: 'New' });
    expect([bytes.includes(opaque), infoText(saved(kept), 'Title'), change.findings.map(finding => finding.code), replaced.reconciled]).toStrictEqual([
      true,
      'Info title',
      ['opaque-property-kept'],
      [{ key: 'Title', from: 'input', discarded: opaque }],
    ]);
  });

  it('keeps the more precise of two agreeing dates on both sides, without adding precision or a time zone', () => {
    expect([
      creationDates('<</CreationDate(D:20200506)>>', '<xmp:CreateDate>2020-05-06T10:11:12+09:00</xmp:CreateDate>'),
      creationDates("<</CreationDate(D:20200506101112+09'00')>>", '<xmp:CreateDate>2020-05</xmp:CreateDate>'),
      creationDates('<</CreationDate(D:2020)>>', ''),
      creationDates('<</CreationDate(D:20200506101112)>>', ''),
      creationDates('<<>>', '<xmp:CreateDate>2020-05-06T10:11:12</xmp:CreateDate>'),
      creationDates('<<>>', '<xmp:CreateDate>2020-05-06T10:11+09:00</xmp:CreateDate>'),
    ]).toStrictEqual([
      ["D:20200506101112+09'00", xmpText('2020-05-06T10:11:12+09:00'), 'agree'],
      ["D:20200506101112+09'00'", xmpText('2020-05-06T10:11:12+09:00'), 'agree'],
      ['D:2020', xmpText('2020'), 'agree'],
      ['D:20200506101112', xmpText('2020-05-06T10:11:12Z'), 'agree'],
      ['D:20200506', xmpText('2020-05-06T10:11:12'), 'agree'],
      ["D:20200506101100+09'00", xmpText('2020-05-06T10:11+09:00'), 'agree'],
    ]);
  });

  it('keeps Info values it cannot read when nothing replaces them, and lists those it replaces', () => {
    const document = withUnreadInfo();
    const change = setMetadata(document, { modificationDate: MODIFIED, producer: 'P' });
    const values = readMetadata(saved(document)).info?.values;
    const set = setMetadata(withUnreadInfo(), { modificationDate: MODIFIED, title: 'T', creationDate: null });
    expect([
      values?.get('Title'),
      values?.get('CreationDate')?.kind,
      values?.get('Trapped')?.kind,
      change.reconciled,
      change.findings.map(finding => finding.code),
      set.reconciled,
    ]).toStrictEqual([
      { kind: 'name', name: 'Foo' },
      'text',
      'text',
      [
        { key: 'Subject', from: 'xmp', discarded: '/Bar' },
        { key: 'ModDate', from: 'input', discarded: '12' },
      ],
      ['info-value-kept', 'info-value-kept', 'info-value-kept'],
      [
        { key: 'Title', from: 'input', discarded: '/Foo' },
        { key: 'Subject', from: 'xmp', discarded: '/Bar' },
        { key: 'CreationDate', from: 'input', discarded: 'Tue May 06 2020' },
        { key: 'ModDate', from: 'input', discarded: '12' },
      ],
    ]);
  });

  it('keeps packet values it cannot read when nothing replaces them, and lists those it replaces', () => {
    const kept = withUnparsedXmp('<<>>');
    const change = setMetadata(kept, { modificationDate: MODIFIED, producer: 'P' });
    const bytes = latin1Text(kept.save().toBytes());
    const fromInfo = setMetadata(withUnparsedXmp('<</CreationDate(D:2020)/Trapped/True>>'), { modificationDate: MODIFIED });
    const fromInput = setMetadata(withUnparsedXmp('<<>>'), { modificationDate: MODIFIED, creationDate: null, trapped: 'False' });
    expect([
      bytes.includes('<xmp:CreateDate>not a date</xmp:CreateDate>'),
      bytes.includes('<pdf:Trapped>maybe</pdf:Trapped>'),
      change.findings.map(finding => finding.code),
      fromInfo.reconciled,
      fromInput.reconciled,
    ]).toStrictEqual([
      true,
      true,
      ['xmp-value-kept', 'xmp-value-kept'],
      [
        { key: 'CreationDate', from: 'info', discarded: 'not a date' },
        { key: 'Trapped', from: 'info', discarded: 'maybe' },
      ],
      [
        { key: 'CreationDate', from: 'input', discarded: 'not a date' },
        { key: 'Trapped', from: 'input', discarded: 'maybe' },
      ],
    ]);
  });

  it('reconciles values the input leaves out from the authoritative side and reports what it discarded', () => {
    const document = load(
      '/Metadata 4 0 R',
      [
        {
          number: 4,
          body: streamBody(
            '/Type/Metadata/Subtype/XML',
            packet(
              '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Packet title</rdf:li></rdf:Alt></dc:title><xmp:MetadataDate>2020-01-01T00:00:00Z</xmp:MetadataDate>',
            ),
          ),
        },
        { number: 5, body: '<</Title(Info title)/ModDate(D:20210101000000Z)>>' },
      ],
      `${ID}/Info 5 0 R`,
    );
    const change = setMetadata(document, { modificationDate: MODIFIED });
    const reloaded = saved(document);
    expect([change.reconciled, infoText(reloaded, 'Title'), agreements(reloaded)['Title']]).toStrictEqual([
      [{ key: 'Title', from: 'info', discarded: 'Packet title' }],
      'Info title',
      'agree',
    ]);
  });

  it('replaces the packet in place, keeps its DocumentID and unmanaged properties, and removes legacy duplicates', () => {
    const existing = packet(
      '<pdf:Title>Legacy</pdf:Title><xmpMM:DocumentID>xmp.did:kept</xmpMM:DocumentID><xmpMM:InstanceID>uuid:old</xmpMM:InstanceID><xmp:Rating>3</xmp:Rating>',
    );
    const document = load('/Metadata 4 0 R', [
      {
        number: 4,
        body: streamBody('/Type/Metadata/Subtype/XML/Filter/ASCIIHexDecode', `${hexOf(existing)}>`),
      },
    ]);
    const change = setMetadata(document, INPUT);
    const reloaded = saved(document);
    expect([
      change.documentId,
      change.removedLegacy,
      readMetadata(reloaded).xmp?.reference,
      codes(reloaded),
      packetProperties(reloaded).includes('Rating'),
      change.instanceId === 'uuid:old',
    ]).toStrictEqual(['xmp.did:kept', ['pdf:Title'], pdfReference(4, 0), [], true, false]);
  });

  it('deletes orphaned metadata streams and keeps component packets', () => {
    const document = load('/Metadata 4 0 R', [
      { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) },
      { number: 5, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) },
      { number: 6, body: '<</Type/Metadata>>' },
    ]);
    const change = setMetadata(document, INPUT);
    const reloaded = saved(document);
    expect([change.deletedOrphans, readMetadata(reloaded).packets.orphans, packetCount(document)]).toStrictEqual([
      [pdfReference(5, 0), pdfReference(6, 0)],
      [],
      1,
    ]);
  });

  it('adds a new packet when the catalog names a dictionary or a stream a component also uses', () => {
    const dictionary = load('/Metadata 4 0 R', [{ number: 4, body: '<</Type/Metadata/Subtype/XML>>' }]);
    setMetadata(dictionary, INPUT);
    const shared = load('/Metadata 4 0 R/Extra 5 0 R', [
      { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) },
      { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Metadata 4 0 R', '') },
    ]);
    setMetadata(shared, INPUT);
    const [fromDictionary, fromShared] = [saved(dictionary), saved(shared)].map(document => readMetadata(document));
    expect([
      fromDictionary?.xmp?.reference.objectNumber,
      fromDictionary?.packets.orphans,
      fromShared?.xmp?.reference.objectNumber,
      fromShared?.packets.components.map(component => component.reference.objectNumber),
    ]).toStrictEqual([6, [], 7, [4]]);
  });

  it('preserves a document packet shared through a direct dictionary in the catalog', () => {
    const document = load('/Metadata 4 0 R/Extra<</Metadata 4 0 R>>', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) }]);
    setMetadata(document, INPUT);
    const component = document.get(pdfReference(4, 0));
    const metadata = readMetadata(saved(document));
    expect([
      metadata.xmp?.reference.objectNumber,
      metadata.packets.components.map(item => [item.owner.objectNumber, item.reference.objectNumber]),
    ]).toStrictEqual([6, [[1, 4]]]);
    expect(component).toMatchObject({ kind: 'stream', data: new TextEncoder().encode(packet('')) });
  });

  it('requires a DocumentID source and uses a supplied one', () => {
    expect(() => setMetadata(load('', [], ''), INPUT)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'document-id-required' }));
    expect(setMetadata(load('', [], ''), INPUT, { documentId: { value: 'uuid:given' } }).documentId).toBe('uuid:given');
  });

  it('keeps a DocumentID written as a URI', () => {
    const document = load('/Metadata 4 0 R', [
      { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('<xmpMM:DocumentID rdf:resource="uuid:resource"/>')) },
    ]);
    expect(setMetadata(document, INPUT).documentId).toBe('uuid:resource');
  });

  it('derives the DocumentID from a file identifier held indirectly', () => {
    const first = `<${'0123456789abcdef'.repeat(2)}>`;
    const array = load('', [{ number: 4, body: `[${first}<00>]` }], '/ID 4 0 R');
    const string = load('', [{ number: 4, body: first }], '/ID[4 0 R<00>]');
    expect([setMetadata(array, INPUT).documentId, setMetadata(string, INPUT).documentId]).toStrictEqual([formatUuid(FIRST_ID), formatUuid(FIRST_ID)]);
  });

  it('refuses an unreadable packet unless told to replace it, and changes nothing when it refuses', () => {
    const refused = unreadable();
    expect(() => setMetadata(refused, INPUT)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'xmp-unreadable' }));
    expect(() => setMetadata(refused, { ...INPUT, title: 'a\u{1}' }, { unreadableXmp: 'replace' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'xmp-unrepresentable' }),
    );
    const replaced = unreadable();
    setMetadata(replaced, INPUT, { unreadableXmp: 'replace' });
    expect([refused.save().mode, codes(saved(replaced))]).toStrictEqual(['incremental', []]);
  });

  it('changes nothing when a step after the first edit it plans fails', () => {
    const document = load('', [], `${ID}/Info 4 0 R`);
    document.set(pdfReference(1, 0), pdfInteger(1));
    expect(() => setMetadata(document, INPUT)).toThrow(InvalidArgumentError);
    expect(editState(document)).toStrictEqual([[1], [], undefined, false]);
  });

  it('refuses documents with signatures unless revisions are kept, and then allows an incremental save', () => {
    expect(() => setMetadata(signed(), INPUT)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'signed-document' }));
    expect(() => setMetadata(load('/AcroForm<</Fields[]/SigFlags 1>>'), INPUT)).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'signed-document' }),
    );
    const kept = signed();
    const change = setMetadata(kept, INPUT, { revisions: 'keep' });
    const update = kept.save({ mode: 'incremental' });
    expect([change.saveMode, change.supersededPackets, update.mode, readMetadata(loadDocument(update.chunks)).packets.scanned.superseded]).toStrictEqual([
      'incremental-required',
      1,
      'incremental',
      1,
    ]);
  });

  it('prevents a full save after keeping signed revisions unless invalidation is explicit', () => {
    const document = signed();
    setMetadata(document, INPUT, { revisions: 'keep' });
    expect(() => document.save({ mode: 'full' })).toThrow(expect.objectContaining({ reason: 'signed-document' }));
    expect(document.save({ mode: 'full', invalidateSignatures: true }).mode).toBe('full');
  });

  it('refuses an incremental save after a default edit', () => {
    const document = load('');
    setMetadata(document, INPUT);
    expect(() => document.save({ mode: 'incremental' })).toThrow(expect.objectContaining({ constructor: InvalidArgumentError, reason: 'metadata-history' }));
  });

  it('derives the InstanceID at save time from everything the save writes', () => {
    const [plain, again, extra] = [instanceIds([]), instanceIds([]), instanceIds([pdfInteger(1)])];
    expect([plain[0] === plain[1], again[1] === plain[1], extra[0] === extra[1], extra[1] === plain[1]]).toStrictEqual([true, true, false, false]);
  });

  it('derives different InstanceIDs for edits that set different values', () => {
    const ids = [
      editedInstanceId({ modificationDate: MODIFIED, title: 'A' }),
      editedInstanceId({ modificationDate: MODIFIED, title: 'B' }),
      editedInstanceId({ modificationDate: MODIFIED, author: 'someone' }),
    ];
    expect([new Set(ids).size, ids[0] === editedInstanceId({ modificationDate: MODIFIED, title: 'A' })]).toStrictEqual([3, true]);
  });

  it('writes the same InstanceID on every save of one state, edits made after setMetadata included', () => {
    const document = load('');
    setMetadata(document, INPUT);
    document.object(pdfInteger(1));
    const first = instanceIdOf(saved(document));
    expect([first === instanceIdOf(saved(document)), first === '']).toStrictEqual([true, false]);
  });

  it('digests changed objects as the save writes them, so values a save copies from the source are accepted', () => {
    const added = load('/Big 1000000000000');
    setMetadata(added, INPUT);
    const edited = load('/Big 1000000000000/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) }]);
    setMetadata(edited, INPUT);
    edited.set(pdfReference(1, 0), { kind: 'dictionary', entries: edited.catalog() });
    expect([saved(added).catalog().get(new TextEncoder().encode('Big')), saved(edited).catalog().get(new TextEncoder().encode('Big'))]).toStrictEqual([
      { kind: 'integer', value: 1_000_000_000_000 },
      { kind: 'integer', value: 1_000_000_000_000 },
    ]);
  });

  it('writes identical bytes for identical edits', () => {
    expect(editedBytes()).toBe(editedBytes());
  });
});

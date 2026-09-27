import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { MetadataInput } from './setMetadata.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
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

const hexOf = (text: string): string => [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, '0')).join('');

const packetCount = (document: LoadedDocument): number => latin1Text(document.save().toBytes()).split('<?xpacket begin=').length - 1;

describe('setting document metadata', () => {
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

  it('requires a DocumentID source and uses a supplied one', () => {
    expect(() => setMetadata(load('', [], ''), INPUT)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'document-id-required' }));
    expect(setMetadata(load('', [], ''), INPUT, { documentId: { value: 'uuid:given' } }).documentId).toBe('uuid:given');
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

  it('refuses documents with AppendOnly signatures unless revisions are kept, and then allows an incremental save', () => {
    expect(() => setMetadata(signed(), INPUT)).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'signed-document' }));
    const kept = signed();
    const change = setMetadata(kept, INPUT, { revisions: 'keep' });
    const update = kept.save({ mode: 'incremental' });
    expect([change.saveMode, change.supersededPackets, update.mode, readMetadata(loadDocument(update.chunks)).packets.scanned.superseded]).toStrictEqual([
      'any',
      1,
      'incremental',
      1,
    ]);
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

  it('writes the same InstanceID on every save of one state, edits made after setMetadata included', () => {
    const document = load('');
    setMetadata(document, INPUT);
    document.object(pdfInteger(1));
    const first = instanceIdOf(saved(document));
    expect([first === instanceIdOf(saved(document)), first === '']).toStrictEqual([true, false]);
  });

  it('writes identical bytes for identical edits', () => {
    expect(editedBytes()).toBe(editedBytes());
  });
});

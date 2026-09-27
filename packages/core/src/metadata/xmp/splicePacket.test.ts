import type { ManagedValues } from './writeXmp.ts';

import { describe, expect, it } from 'vitest';

import { readXmp } from './readXmp.ts';
import { splicePacket } from './splicePacket.ts';
import { managedDescription } from './writeXmp.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

const VALUES: ManagedValues = {
  title: 'New title',
  author: undefined,
  subject: undefined,
  keywords: undefined,
  creator: undefined,
  producer: 'New producer',
  trapped: undefined,
  createDate: undefined,
  modifyDate: '2024-01-02T00:00:00Z',
  metadataDate: '2024-01-02T00:00:00Z',
  documentId: 'uuid:00000000-0000-0000-0000-000000000001',
  instanceId: 'uuid:00000000-0000-0000-0000-000000000002',
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const splice = (text: string | Uint8Array): ReturnType<typeof splicePacket> | undefined => {
  const read = readXmp(typeof text === 'string' ? encode(text) : text);
  return read.ok ? splicePacket(read.packet, VALUES) : undefined;
};

const properties = (bytes: Uint8Array | undefined): readonly (readonly [string, unknown])[] => {
  const read = readXmp(bytes ?? new Uint8Array());
  return read.ok ? read.packet.properties.map(property => [`${property.namespace}${property.localName}`, property.value] as const) : [];
};

// The XML declaration of a UTF-16 packet that starts with `declaration`, after a splice.
const declarationAfterSplice = (declaration: string): string => {
  const source = `${declaration}<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about=""/></rdf:RDF>`;
  const utf16 = Uint8Array.from([0xfe, 0xff, ...[...encode(source)].flatMap(byte => [0, byte])]);
  const text = new TextDecoder().decode(splice(utf16)?.bytes);
  return text.slice(0, text.indexOf('?>') + 2);
};

// The source packet in pieces: the removed ones are managed or legacy properties, with the white space before them.
const KEPT_START =
  '<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Tool 1.0">\n' +
  `<rdf:RDF xmlns:rdf="${RDF}" xml:lang="de">\n<!-- kept -->\n` +
  '<rdf:Description rdf:about="uuid:subject" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1"';
const REMOVED_ATTRIBUTE = '\n  pdf:Producer="Old producer"';
const KEPT_MIDDLE = '>';
const REMOVED_LEGACY = '\n  <pdf:Title>Legacy</pdf:Title>';
const KEPT_HISTORY =
  '\n  <xmpMM:History xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>saved</stEvt:action></rdf:li></rdf:Seq></xmpMM:History>';
const REMOVED_TITLE = '\n  <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Alt><rdf:li xml:lang="x-default">Old title</rdf:li></rdf:Alt></dc:title>';
const KEPT_END = '\n</rdf:Description>\n';
const TRAILER = `</rdf:RDF>\n</x:xmpmeta>\n${' '.repeat(100)}\n<?xpacket end="w"?>`;

describe('splicing managed properties into an existing packet', () => {
  it('removes managed and legacy properties, inserts one rdf:Description, and copies every other byte', () => {
    const source = KEPT_START + REMOVED_ATTRIBUTE + KEPT_MIDDLE + REMOVED_LEGACY + KEPT_HISTORY + REMOVED_TITLE + KEPT_END + TRAILER;
    const description = managedDescription(VALUES, { about: 'uuid:subject', declareRdf: true, resetLanguage: true });
    const result = splice(source);
    expect([new TextDecoder().decode(result?.bytes), result?.removedLegacy, result?.transcoded]).toStrictEqual([
      `${KEPT_START}${KEPT_MIDDLE}${KEPT_HISTORY}${KEPT_END}${description}\n${TRAILER}`,
      ['pdf:Title'],
      false,
    ]);
  });

  it('gives the new values no inherited language and keeps the properties it does not manage', () => {
    const source = KEPT_START + REMOVED_ATTRIBUTE + KEPT_MIDDLE + REMOVED_LEGACY + KEPT_HISTORY + REMOVED_TITLE + KEPT_END + TRAILER;
    expect(properties(splice(source)?.bytes)).toStrictEqual([
      ['http://www.aiim.org/pdfa/ns/id/part', { kind: 'text', text: '1', language: 'de' }],
      ['http://ns.adobe.com/xap/1.0/mm/History', { kind: 'opaque' }],
      ['http://purl.org/dc/elements/1.1/title', { kind: 'array', type: 'Alt', items: [{ text: 'New title', language: 'x-default' }] }],
      ['http://ns.adobe.com/pdf/1.3/Producer', { kind: 'text', text: 'New producer', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/ModifyDate', { kind: 'text', text: '2024-01-02T00:00:00Z', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/MetadataDate', { kind: 'text', text: '2024-01-02T00:00:00Z', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/mm/DocumentID', { kind: 'text', text: 'uuid:00000000-0000-0000-0000-000000000001', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/mm/InstanceID', { kind: 'text', text: 'uuid:00000000-0000-0000-0000-000000000002', language: undefined }],
    ]);
  });

  it('declares rdf on the new element where the packet binds the prefix to another namespace', () => {
    const source = `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://example.com/"><r:RDF xmlns:r="${RDF}"><r:Description r:about=""/></r:RDF></x:xmpmeta>`;
    expect(properties(splice(source)?.bytes).map(([name]) => name)).toStrictEqual([
      'http://purl.org/dc/elements/1.1/title',
      'http://ns.adobe.com/pdf/1.3/Producer',
      'http://ns.adobe.com/xap/1.0/ModifyDate',
      'http://ns.adobe.com/xap/1.0/MetadataDate',
      'http://ns.adobe.com/xap/1.0/mm/DocumentID',
      'http://ns.adobe.com/xap/1.0/mm/InstanceID',
    ]);
  });

  it('writes an rdf:RDF element with no content as a start and an end tag around the new element', () => {
    const result = splice(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${RDF}" /></x:xmpmeta>`);
    const description = managedDescription(VALUES, { about: '', declareRdf: true, resetLanguage: false });
    expect(new TextDecoder().decode(result?.bytes)).toBe(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${RDF}" >${description}\n</r:RDF></x:xmpmeta>`);
  });

  it('declares UTF-8 in the XML declaration of a re-encoded packet', () => {
    expect([
      declarationAfterSplice('<?xml version="1.0" encoding="UTF-16"?>'),
      declarationAfterSplice("<?xml version='1.0' encoding = 'utf-16' standalone='yes'?>"),
      declarationAfterSplice('<?xml version="1.0"?>'),
    ]).toStrictEqual(['<?xml version="1.0" encoding="UTF-8"?>', "<?xml version='1.0' encoding = 'UTF-8' standalone='yes'?>", '<?xml version="1.0"?>']);
  });

  it('keeps unmanaged properties within the packet limit', () => {
    const repeated = '<pdf:X>1</pdf:X>'.repeat(2000);
    const source = `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">${repeated}</rdf:Description></rdf:RDF>`;
    const result = splice(source);
    const copied = new TextDecoder().decode(result?.bytes).split('<pdf:X>').length - 1;
    expect([result?.transcoded, copied]).toStrictEqual([false, 2000]);
  });

  it('re-encodes a packet in another encoding as UTF-8', () => {
    const source = `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about=""/></rdf:RDF>`;
    const utf16 = Uint8Array.from([0xff, 0xfe, ...[...encode(source)].flatMap(byte => [byte, 0])]);
    const result = splice(utf16);
    const expected = `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about=""/>${managedDescription(VALUES, { about: '', declareRdf: true, resetLanguage: false })}\n</rdf:RDF>`;
    expect([new TextDecoder().decode(result?.bytes), result?.transcoded]).toStrictEqual([expected, true]);
  });
});

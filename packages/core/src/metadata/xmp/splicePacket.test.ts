import type { ManagedValues } from './writeXmp.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../error/validationError.ts';

import { readXmp } from './readXmp.ts';
import { splicePacket } from './splicePacket.ts';
import { managedDescription } from './writeXmp.ts';
import { tokenizeXml } from './xmlTokenizer.ts';

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

const properties = (bytes: Uint8Array | undefined): ReadonlyArray<readonly [string, unknown]> => {
  const read = readXmp(bytes ?? new Uint8Array());
  return read.ok ? read.packet.properties.map(property => [`${property.namespace}${property.localName}`, property.value] as const) : [];
};

const escaped = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const unmanagedOf = (bytes: Uint8Array | undefined): ReadonlyArray<readonly [string, unknown]> =>
  properties(bytes).filter(([name]) => name.startsWith('urn:p'));

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
  it('discards a second packet after the first packet trailer', () => {
    const first = `${KEPT_START}${KEPT_MIDDLE}${KEPT_END}${TRAILER}`;
    const second = `${KEPT_START}${KEPT_MIDDLE}${KEPT_END}${TRAILER}`;
    const result = new TextDecoder().decode(splice(`${first}${second}`)?.bytes);
    expect(result.split('<?xpacket begin=').length - 1).toBe(1);
    expect(result.slice(-TRAILER.length)).toBe(TRAILER);
  });

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

  it('copies 2,000 repeated unmanaged properties and reads the result back under the cap it is given', () => {
    const repeated = '<pdf:X>1</pdf:X>'.repeat(2000);
    const read = readXmp(
      encode(`<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">${repeated}</rdf:Description></rdf:RDF>`),
    );
    const packet = read.ok ? read.packet : undefined;
    const result = packet === undefined ? undefined : splicePacket(packet, VALUES);
    const text = new TextDecoder().decode(result?.bytes);
    const tokens = tokenizeXml(text);
    const count = tokens.ok ? tokens.tokens.length : 0;
    expect([result?.transcoded, text.split('<pdf:X>').length - 1]).toStrictEqual([false, 2000]);
    expect(packet === undefined ? undefined : splicePacket(packet, VALUES, { maxTokens: count }).bytes).toStrictEqual(result?.bytes);
    expect(() => (packet === undefined ? undefined : splicePacket(packet, VALUES, { maxTokens: count - 1 }))).toThrow(
      expect.objectContaining({ reason: 'xmp-unreadable' }),
    );
  });

  it('re-encodes a packet in another encoding as UTF-8', () => {
    const source = `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about=""/></rdf:RDF>`;
    const utf16 = Uint8Array.from([0xff, 0xfe, ...[...encode(source)].flatMap(byte => [byte, 0])]);
    const result = splice(utf16);
    const expected = `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about=""/>${managedDescription(VALUES, { about: '', declareRdf: true, resetLanguage: false })}\n</rdf:RDF>`;
    expect([new TextDecoder().decode(result?.bytes), result?.transcoded]).toStrictEqual([expected, true]);
  });

  it('leaves the property of a kept key byte for byte and rewrites the others', () => {
    const title = '<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Alt><rdf:li xml:lang="x-default">Kept &amp; title</rdf:li></rdf:Alt></dc:title>';
    const source = `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">${title}<pdf:Producer>Old</pdf:Producer></rdf:Description></rdf:RDF>`;
    const read = readXmp(encode(source));
    const result = read.ok ? splicePacket(read.packet, { ...VALUES, title: undefined }, { kept: new Set(['Title']) }) : undefined;
    const text = new TextDecoder().decode(result?.bytes);
    expect([
      text.includes(title),
      text.includes('<pdf:Producer>Old</pdf:Producer>'),
      properties(result?.bytes).filter(([name]) => name.endsWith('title') || name.endsWith('Producer')),
    ]).toStrictEqual([
      true,
      false,
      [
        ['http://purl.org/dc/elements/1.1/title', { kind: 'array', type: 'Alt', items: [{ text: 'Kept & title', language: 'x-default' }] }],
        ['http://ns.adobe.com/pdf/1.3/Producer', { kind: 'text', text: 'New producer', language: undefined }],
      ],
    ]);
  });

  // The result is read back, so a property the splice did not know of and left in place is caught rather than shipped.
  it.each([
    ['a legacy property', '<pdf:Title>Legacy</pdf:Title>', 'Title'],
    ['a second occurrence of a managed property', '<pdf:Producer>New producer</pdf:Producer>', 'Producer'],
  ])('refuses a result that still holds %s', (_name, property, omitted) => {
    const read = readXmp(
      encode(`<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">${property}</rdf:Description></rdf:RDF>`),
    );
    const packet = read.ok ? { ...read.packet, properties: read.packet.properties.filter(item => item.localName !== omitted) } : undefined;
    expect(() => (packet === undefined ? undefined : splicePacket(packet, VALUES))).toThrow(ValidationError);
    expect(() => (packet === undefined ? undefined : splicePacket(packet, VALUES))).toThrow(expect.objectContaining({ reason: 'xmp-unreadable' }));
  });

  it.each([
    ['two adjacent attributes', ' pdf:Producer="a" pdf:Keywords="b" pdf:X="c"', ' pdf:X="c"'],
    ['the only attribute', ' pdf:Producer="a"', ''],
  ])('removes %s without leaving white space behind', (_name, attributes, left) => {
    const start = `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"`;
    const result = splice(`${start}${attributes}/></rdf:RDF>`);
    const description = managedDescription(VALUES, { about: '', declareRdf: true, resetLanguage: false });
    expect(new TextDecoder().decode(result?.bytes)).toBe(`${start}${left}/>${description}\n</rdf:RDF>`);
  });

  // XML 1.0, 3.3.3: a tab or line feed in an attribute value reads back as a space unless written as a reference.
  it('gives the new rdf:Description the subject of the packet, quotes and white space included', () => {
    const subject = 'uuid:a"b\tc\nd';
    const result = splice(`<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about="uuid:a&quot;b&#9;c&#10;d"/></rdf:RDF>`);
    const read = readXmp(result?.bytes ?? new Uint8Array());
    expect(read.ok ? [read.packet.subject, read.packet.findings] : read.reason).toStrictEqual([subject, []]);
  });
});

describe('properties', () => {
  // Characters XML can carry, among them the ones it escapes and one outside the Basic Multilingual Plane.
  const text = fc
    .array(fc.constantFrom('a', 'Z', ' ', '&', '<', '>', '"', "'", '\t', '\n', '山', '\u{1F600}'), { maxLength: 12 })
    .map(characters => characters.join(''));
  const unmanaged = fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), text), { maxLength: 6 });
  const managed = fc.subarray(['<pdf:Producer>old</pdf:Producer>', '<pdf:Title>legacy</pdf:Title>', '<pdf:Keywords>k</pdf:Keywords>']);

  it('keeps the unmanaged properties of a packet in order', () => {
    fc.assert(
      fc.property(unmanaged, managed, text, text, (others, ours, title, producer) => {
        const body = [...others.map(([name, value]) => `<p:${name}>${escaped(value)}</p:${name}>`), ...ours].join('');
        const read = readXmp(
          encode(
            `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about="" xmlns:p="urn:p" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">${body}</rdf:Description></rdf:RDF>`,
          ),
        );
        const spliced = read.ok ? splicePacket(read.packet, { ...VALUES, title, producer }) : undefined;
        expect(unmanagedOf(spliced?.bytes)).toStrictEqual(others.map(([name, text]) => [`urn:p${name}`, { kind: 'text', text, language: undefined }]));
      }),
    );
  });
});

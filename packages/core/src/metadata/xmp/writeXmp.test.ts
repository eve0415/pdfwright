import type { ManagedValues } from './writeXmp.ts';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../error/validationError.ts';

import { readXmp } from './readXmp.ts';
import { newPacket } from './writeXmp.ts';

const VALUES: ManagedValues = {
  title: 'Title & <more>',
  author: '山田 太郎',
  subject: 'Subject',
  keywords: 'a, b',
  creator: 'Creator',
  producer: 'Producer',
  trapped: 'True',
  createDate: '2024-01-01T09:00:00+09:00',
  modifyDate: '2024-01-02T00:00:00Z',
  metadataDate: '2024-01-02T00:00:00Z',
  documentId: 'uuid:00000000-0000-0000-0000-000000000001',
  instanceId: 'uuid:00000000-0000-0000-0000-000000000002',
};

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const readBack = (bytes: Uint8Array): readonly (readonly [string, unknown])[] => {
  const result = readXmp(bytes);
  return result.ok ? result.packet.properties.map(property => [`${property.namespace}${property.localName}`, property.value] as const) : [];
};

describe('writing XMP packets', () => {
  it('writes the managed properties in a fixed order, byte for byte', () => {
    expect(text(newPacket(VALUES))).toBe(
      [
        '<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>',
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
        '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">',
        '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Title &amp; &lt;more&gt;</rdf:li></rdf:Alt></dc:title>',
        '<dc:creator><rdf:Seq><rdf:li>山田 太郎</rdf:li></rdf:Seq></dc:creator>',
        '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Subject</rdf:li></rdf:Alt></dc:description>',
        '<pdf:Keywords>a, b</pdf:Keywords>',
        '<pdf:Producer>Producer</pdf:Producer>',
        '<pdf:Trapped>True</pdf:Trapped>',
        '<xmp:CreatorTool>Creator</xmp:CreatorTool>',
        '<xmp:CreateDate>2024-01-01T09:00:00+09:00</xmp:CreateDate>',
        '<xmp:ModifyDate>2024-01-02T00:00:00Z</xmp:ModifyDate>',
        '<xmp:MetadataDate>2024-01-02T00:00:00Z</xmp:MetadataDate>',
        '<xmpMM:DocumentID>uuid:00000000-0000-0000-0000-000000000001</xmpMM:DocumentID>',
        '<xmpMM:InstanceID>uuid:00000000-0000-0000-0000-000000000002</xmpMM:InstanceID>',
        '</rdf:Description>',
        '</rdf:RDF>',
        '</x:xmpmeta>',
        '<?xpacket end="w"?>',
      ].join('\n'),
    );
  });

  it('leaves out properties without a value and reads back what it wrote', () => {
    const values: ManagedValues = {
      ...VALUES,
      title: undefined,
      author: undefined,
      subject: 'a\r\nb\tc',
      keywords: undefined,
      trapped: undefined,
      createDate: undefined,
    };
    expect(readBack(newPacket(values))).toStrictEqual([
      ['http://purl.org/dc/elements/1.1/description', { kind: 'array', type: 'Alt', items: [{ text: 'a\r\nb\tc', language: 'x-default' }] }],
      ['http://ns.adobe.com/pdf/1.3/Producer', { kind: 'text', text: 'Producer', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/CreatorTool', { kind: 'text', text: 'Creator', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/ModifyDate', { kind: 'text', text: '2024-01-02T00:00:00Z', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/MetadataDate', { kind: 'text', text: '2024-01-02T00:00:00Z', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/mm/DocumentID', { kind: 'text', text: 'uuid:00000000-0000-0000-0000-000000000001', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/mm/InstanceID', { kind: 'text', text: 'uuid:00000000-0000-0000-0000-000000000002', language: undefined }],
    ]);
  });

  it('refuses values XML 1.0 cannot carry', () => {
    for (const value of ['\u{1}', 'a\u{FFFE}', '\u{FFFF}', '\u{D800}', 'b\u{DC00}']) {
      expect(() => newPacket({ ...VALUES, title: value })).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'xmp-unrepresentable' }));
    }
  });
});

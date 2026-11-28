import type { DocumentOptions } from '../document/pdfDocument.ts';
import type { DocumentInfo } from './documentInfo.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { createDocument } from '../document/pdfDocument.ts';
import { rect } from '../document/rect.ts';
import { ValidationError } from '../error/validationError.ts';
import { md5 } from '../hash/md5.ts';
import { pt } from '../length/length.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { formatUuid } from './identifiers.ts';
import { readMetadata } from './readMetadata.ts';

const MODIFIED = pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' });
const INFO = { title: 'Proof', author: '山田 太郎', producer: 'pdfwright', trapped: 'False', creationDate: MODIFIED, modificationDate: MODIFIED } as const;

const bytes = (options: DocumentOptions): Uint8Array => {
  const document = createDocument(options);
  document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  return document.save().toBytes();
};

const packetText = (data: Uint8Array, name: string): string | undefined => {
  const { xmp } = readMetadata(loadDocument(data));
  const value = xmp !== undefined && 'packet' in xmp ? xmp.packet.properties.find(property => property.localName === name)?.value : undefined;
  return value?.kind === 'text' ? value.text : undefined;
};

const firstId = (data: Uint8Array): Uint8Array => {
  const id = loadDocument(data).structure.trailer.get(new TextEncoder().encode('ID'));
  const first = id?.kind === 'array' ? id.items[0] : undefined;
  return first?.kind === 'string' ? first.bytes : new Uint8Array();
};

// The InstanceID of a created document with one page of the given width; the file identifier is fixed, so that the DocumentID is the same for every document.
const instanceId = (info: DocumentInfo, width: number): string | undefined => {
  const document = createDocument({ info, fileIdentifier: [new Uint8Array(16).fill(0xab), new Uint8Array(16).fill(0xcd)] });
  document.addPage({ mediaBox: rect(pt(0), pt(0), pt(width), pt(100)) });
  return packetText(document.save().toBytes(), 'InstanceID');
};

describe('metadata in created documents', () => {
  it('requires a modification date for XMP', () => {
    expect(() => createDocument({ info: { title: 'T' } })).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'metadata-date-required' }));
  });

  it('refuses values XMP cannot carry when the document is created', () => {
    expect(() => createDocument({ info: { ...INFO, title: 'a\u{1}' }, metadata: { xmp: true } })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'xmp-unrepresentable' }),
    );
    expect(() => createDocument({ info: INFO, metadata: { xmp: true, documentId: 'uuid:\u{FFFE}' } })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'xmp-unrepresentable' }),
    );
  });

  it('writes a packet that agrees with Info, whose DocumentID is the first file identifier', () => {
    const data = bytes({ info: INFO });
    const metadata = readMetadata(loadDocument(data));
    expect([
      metadata.authority,
      metadata.findings,
      metadata.packets.scanned,
      metadata.properties.filter(property => !['agree', 'absent'].includes(property.agreement)),
      packetText(data, 'DocumentID') === formatUuid(firstId(data)),
      packetText(data, 'InstanceID')?.startsWith('uuid:'),
    ]).toStrictEqual(['xmp', [], { document: 1, components: 0, orphans: 0, superseded: 0, insideOtherStreams: 0 }, [], true, true]);
  });

  it('writes identical bytes by default and omits the packet with an explicit opt-out', () => {
    const plain = latin1Text(bytes({ info: INFO, metadata: { xmp: false } }));
    const first = latin1Text(bytes({ info: INFO }));
    const second = latin1Text(bytes({ info: INFO }));
    expect([first === second, first.includes('/Metadata'), plain.includes('/Metadata')]).toStrictEqual([true, true, false]);
  });

  it('uses a supplied DocumentID, or derives it from a supplied file identifier', () => {
    const sixteen: [Uint8Array, Uint8Array] = [new Uint8Array(16).fill(0xab), new Uint8Array(16).fill(0xcd)];
    const other: [Uint8Array, Uint8Array] = [new Uint8Array(4).fill(1), new Uint8Array(4).fill(2)];
    expect([
      packetText(bytes({ info: INFO, metadata: { xmp: true, documentId: 'uuid:given' } }), 'DocumentID'),
      packetText(bytes({ info: INFO, fileIdentifier: sixteen, metadata: { xmp: true } }), 'DocumentID'),
      packetText(bytes({ info: INFO, fileIdentifier: other, metadata: { xmp: true } }), 'DocumentID'),
    ]).toStrictEqual(['uuid:given', formatUuid(sixteen[0]), formatUuid(md5(other[0]))]);
  });

  it('writes a caller-supplied InstanceID', () => {
    expect(packetText(bytes({ info: INFO, metadata: { xmp: true, instanceId: 'uuid:given-instance' } }), 'InstanceID')).toBe('uuid:given-instance');
  });

  it('requires a modification date for XMP when there is no Info at all', () => {
    expect(() => createDocument({ metadata: { xmp: true } })).toThrow(ValidationError);
    expect(() => createDocument({ metadata: { xmp: true } })).toThrow(expect.objectContaining({ reason: 'metadata-date-required' }));
  });

  // XMP Part 2 3.1: pdf:Trapped is Boolean, so Info Unknown has no XMP form.
  it('writes Trapped Unknown in Info only', () => {
    const data = bytes({ info: { ...INFO, trapped: 'Unknown' } });
    const metadata = readMetadata(loadDocument(data));
    expect([
      metadata.info?.values.get('Trapped'),
      packetText(data, 'Trapped'),
      metadata.properties.find(property => property.key === 'Trapped')?.agreement,
      metadata.findings,
    ]).toStrictEqual([{ kind: 'name', name: 'Unknown' }, undefined, 'agree', []]);
  });

  it('writes the creation date as xmp:CreateDate', () => {
    const data = bytes({ info: INFO });
    const row = readMetadata(loadDocument(data)).properties.find(property => property.key === 'CreationDate');
    expect([packetText(data, 'CreateDate'), row?.agreement]).toStrictEqual(['2024-03-01T12:00:00Z', 'agree']);
  });

  // ISO 32000-1:2008, 14.3.3: a value that is not known "should be omitted from the dictionary rather than included with an empty string as its value".
  const TEXT_KEYS = [
    ['title', 'Title', 'title'],
    ['author', 'Author', 'creator'],
    ['subject', 'Subject', 'description'],
    ['keywords', 'Keywords', 'Keywords'],
    ['creator', 'Creator', 'CreatorTool'],
    ['producer', 'Producer', 'Producer'],
  ] as const;
  const EVERY_TEXT = { title: 'T', author: 'A', subject: 'S', keywords: 'K', creator: 'C', producer: 'P', modificationDate: MODIFIED };

  it.each(TEXT_KEYS)('omits an empty %s from Info and the packet and keeps every other value', field => {
    const metadata = readMetadata(loadDocument(bytes({ info: { ...EVERY_TEXT, [field]: '' } })));
    const xmpNames = metadata.xmp !== undefined && 'packet' in metadata.xmp ? metadata.xmp.packet.properties.map(property => property.localName) : [];
    const others = TEXT_KEYS.flatMap(([other]) => (other === field ? [] : [other]));
    expect([
      metadata.findings,
      TEXT_KEYS.flatMap(([other, key]) => (metadata.info?.values.has(key) === true ? [other] : [])),
      TEXT_KEYS.flatMap(([other, , name]) => (xmpNames.includes(name) ? [other] : [])),
    ]).toStrictEqual([[], others, others]);
  });

  it('omits an empty Info value without a packet', () => {
    const metadata = readMetadata(loadDocument(bytes({ info: { title: '', author: 'A', modificationDate: MODIFIED }, metadata: { xmp: false } })));
    expect([...(metadata.info?.values.keys() ?? [])]).toStrictEqual(['Author', 'ModDate']);
  });

  it('derives different InstanceIDs for documents that differ in one page or one Info value', () => {
    const base = instanceId(INFO, 100);
    expect([instanceId(INFO, 100) === base, instanceId({ ...INFO, title: 'Other' }, 100) === base, instanceId(INFO, 200) === base]).toStrictEqual([
      true,
      false,
      false,
    ]);
  });
});

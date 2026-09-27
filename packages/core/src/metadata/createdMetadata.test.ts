import type { DocumentOptions } from '../document/pdfDocument.ts';

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

describe('metadata in created documents', () => {
  it('requires a modification date for XMP', () => {
    expect(() => createDocument({ info: { title: 'T' }, metadata: { xmp: true } })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'metadata-date-required' }),
    );
  });

  it('writes a packet that agrees with Info, whose DocumentID is the first file identifier', () => {
    const data = bytes({ info: INFO, metadata: { xmp: true } });
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

  it('writes identical bytes for identical documents and none of it without the option', () => {
    const plain = latin1Text(bytes({ info: INFO }));
    const first = latin1Text(bytes({ info: INFO, metadata: { xmp: true } }));
    const second = latin1Text(bytes({ info: INFO, metadata: { xmp: true } }));
    expect([first === second, plain.includes('/Metadata')]).toStrictEqual([true, false]);
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
});

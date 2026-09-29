import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PacketRoles } from './packetScan.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { scanPackets } from './packetScan.ts';

const PACKET = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x/><?xpacket end="w"?>';
const hex = (text: string): string => [...latin1Bytes(text)].map(byte => byte.toString(16).padStart(2, '0')).join('');

const internals = (document: LoadedDocument): DocumentInternals => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new Error('the document has no internals');
  return parts;
};

const roles = (document: number, components: readonly number[], orphans: readonly number[]): PacketRoles => ({
  document,
  components: new Set(components),
  orphans: new Set(orphans),
});

const source = (): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R/Metadata 3 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
        { number: 3, body: streamBody('/Type/Metadata/Subtype/XML', `${PACKET} old`) },
        { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', PACKET) },
        {
          number: 5,
          body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceGray/Filter/DCTDecode', `JPEG ${PACKET}`),
        },
        { number: 6, body: streamBody('/Type/Metadata/Subtype/XML/Filter/ASCIIHexDecode', `${hex(PACKET)}>`) },
        { number: 7, body: streamBody('/Type/Metadata/Subtype/XML', PACKET) },
      ],
      trailer: '/Root 1 0 R',
    },
    { xref: 'classic', objects: [{ number: 3, body: streamBody('/Type/Metadata/Subtype/XML', PACKET) }], trailer: '/Root 1 0 R' },
  ]).bytes;

describe('locating packets in file bytes', () => {
  it('attributes each packet to the object whose bytes hold it, decoding filtered metadata streams', () => {
    const document = loadDocument(source());
    expect(scanPackets(internals(document), roles(3, [6], [4]))).toStrictEqual({
      document: 1,
      components: 1,
      orphans: 1,
      superseded: 1,
      insideOtherStreams: 2,
    });
  });

  it('finds packets that cross the boundary between two segments of the source', () => {
    const bytes = source();
    const text = new TextDecoder('latin1').decode(bytes);
    const split = text.lastIndexOf('<?xpacket begin') + 5;
    const document = loadDocument([bytes.subarray(0, split), bytes.subarray(split)]);
    expect(scanPackets(internals(document), roles(3, [6], [4]))).toStrictEqual({
      document: 1,
      components: 1,
      orphans: 1,
      superseded: 1,
      insideOtherStreams: 2,
    });
  });
});

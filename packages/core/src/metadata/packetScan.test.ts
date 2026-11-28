import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { BuildOptions, TestObject } from '../testing/pdfBuilder.ts';
import type { PacketRoles, ScannedPackets } from './packetScan.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { scanPackets } from './packetScan.ts';

const PACKET = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x/><?xpacket end="w"?>';
const hex = (text: string): string => [...latin1Bytes(text)].map(byte => byte.toString(16).padStart(2, '0')).join('');

const internals = (document: LoadedDocument): DocumentInternals => {
  const parts = internalsOf(document);
  if (parts === undefined) {
    throw new Error('the document has no internals');
  }
  return parts;
};

const roles = (document: number, components: ReadonlyArray<number>, orphans: ReadonlyArray<number>): PacketRoles => ({
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

const scanOne = (objects: ReadonlyArray<TestObject>, packetRoles: PacketRoles, options: BuildOptions = {}): ScannedPackets =>
  scanPackets(
    internals(
      loadDocument(
        buildPdf(
          [
            {
              xref: 'classic',
              objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }, ...objects],
              trailer: '/Root 1 0 R',
            },
          ],
          options,
        ).bytes,
      ),
    ),
    packetRoles,
  );

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

  it.each([
    [
      'a filtered stream that cannot be decoded, without counting its raw bytes',
      [{ number: 3, body: streamBody('/Type/Metadata/Subtype/XML/Filter/FlateDecode', PACKET) }],
      { document: 0, components: 0, orphans: 0, superseded: 0, insideOtherStreams: 0 },
    ],
    [
      'two headers in one stream',
      [{ number: 3, body: streamBody('/Type/Metadata/Subtype/XML', `${PACKET}${PACKET}`) }],
      { document: 0, components: 0, orphans: 2, superseded: 0, insideOtherStreams: 0 },
    ],
    [
      'a header in an object that does not parse, up to where the next object starts',
      [
        { number: 5, body: `<</Type/Metadata ${PACKET}` },
        { number: 6, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
      ],
      { document: 0, components: 0, orphans: 0, superseded: 0, insideOtherStreams: 1 },
    ],
  ] satisfies Array<[string, Array<TestObject>, ScannedPackets]>)('counts %s', (_name, objects, expected) => {
    expect(scanOne(objects, roles(9, [], [3]))).toStrictEqual(expected);
  });

  it('counts a header before the first object as superseded', () => {
    expect(scanOne([], roles(9, [], []), { header: `%PDF-1.7\n%${PACKET}` })).toStrictEqual({
      document: 0,
      components: 0,
      orphans: 0,
      superseded: 1,
      insideOtherStreams: 0,
    });
  });
});

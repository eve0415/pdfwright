import type { TestObject } from '../testing/pdfBuilder.ts';
import type { DocumentMetadata } from './readMetadata.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { readMetadata } from './readMetadata.ts';

const NAMESPACES =
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"';

const packet = (body: string): string =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ${NAMESPACES}><rdf:Description rdf:about="">${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const PRODUCER = packet('<pdf:Producer>P</pdf:Producer><xmp:MetadataDate>2024-01-01T00:00:00Z</xmp:MetadataDate>');

const read = (catalog: string, objects: readonly TestObject[], trailer: string): DocumentMetadata =>
  readMetadata(
    loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<</XObject<</Im0 6 0 R>>/Properties<</MC0<</Metadata 8 0 R>>>>>>>>' },
            ...objects,
          ],
          trailer: `/Root 1 0 R${trailer}`,
        },
      ]).bytes,
    ),
  );

const IMAGE = { number: 6, body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceGray/Metadata 7 0 R', 'x') };
const COMPONENTS: readonly TestObject[] = [
  IMAGE,
  { number: 7, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) },
  { number: 8, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) },
];

const infoKeys = (metadata: DocumentMetadata): readonly string[] => [...(metadata.info?.values.keys() ?? [])];

const unreadable = (metadata: DocumentMetadata): string | undefined =>
  metadata.xmp !== undefined && 'unreadable' in metadata.xmp ? metadata.xmp.unreadable : undefined;

const codes = (metadata: DocumentMetadata): readonly string[] => metadata.findings.map(finding => finding.code);

describe('reading document metadata', () => {
  it('reports an extra packet inside the catalog metadata stream', () => {
    const metadata = read('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', `${PRODUCER}${PRODUCER}`) }], '');
    expect(codes(metadata)).toContain('extra-xmp-packet');
  });

  it('finds a component packet inside a direct dictionary in the catalog', () => {
    const metadata = read('/Metadata 4 0 R/Extra<</Metadata 4 0 R>>', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', PRODUCER) }], '');
    expect(metadata.packets.components).toStrictEqual([
      { owner: pdfReference(1, 0), reference: pdfReference(4, 0) },
      { owner: pdfReference(3, 0), reference: pdfReference(8, 0) },
    ]);
  });

  it('reads Info and the document packet, maps them, and lists components, orphans and scanned packets', () => {
    const metadata = read(
      '/Metadata 4 0 R',
      [
        { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', PRODUCER) },
        { number: 5, body: '<</Producer(P)/ModDate(D:20240101000000Z)>>' },
        ...COMPONENTS,
        { number: 9, body: streamBody('/Type/Metadata/Subtype/XML', packet('')) },
      ],
      '/Info 5 0 R',
    );
    expect({
      info: metadata.info?.reference,
      values: infoKeys(metadata),
      xmp: metadata.xmp?.reference,
      producer: metadata.properties.find(property => property.key === 'Producer')?.agreement,
      authority: metadata.authority,
      components: metadata.packets.components,
      orphans: metadata.packets.orphans,
      scanned: metadata.packets.scanned,
      findings: codes(metadata),
    }).toStrictEqual({
      info: { kind: 'reference', objectNumber: 5, generation: 0 },
      values: ['Producer', 'ModDate'],
      xmp: { kind: 'reference', objectNumber: 4, generation: 0 },
      producer: 'agree',
      authority: 'xmp',
      components: [
        { owner: { kind: 'reference', objectNumber: 3, generation: 0 }, reference: { kind: 'reference', objectNumber: 8, generation: 0 } },
        { owner: { kind: 'reference', objectNumber: 6, generation: 0 }, reference: { kind: 'reference', objectNumber: 7, generation: 0 } },
      ],
      orphans: [{ kind: 'reference', objectNumber: 9, generation: 0 }],
      scanned: { document: 1, components: 2, orphans: 1, superseded: 0, insideOtherStreams: 0 },
      findings: ['orphan-metadata'],
    });
  });

  it('reports a missing packet, missing Info and a direct Info dictionary', () => {
    const direct = read('', [], '/Info<</Producer(P)>>');
    const none = read('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', PRODUCER) }], '');
    expect([codes(direct), direct.info?.reference, direct.authority, codes(none), none.authority]).toStrictEqual([
      ['info-not-indirect', 'xmp-missing'],
      undefined,
      'info',
      ['info-missing'],
      'xmp',
    ]);
  });

  it('reports metadata that is not a stream, not typed, filtered, refused or not well-formed', () => {
    const cases = [
      read('/Metadata 4 0 R', [{ number: 4, body: '<</Type/Metadata/Subtype/XML>>' }], '/Info<</Producer(P)>>'),
      read('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Filter/ASCIIHexDecode', '3c782f3e>') }], ''),
      read('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', '<!DOCTYPE x><x/>') }], ''),
      read('/Metadata 4 0 R', [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', '<x>') }], ''),
    ];
    expect(cases.map(metadata => [codes(metadata), unreadable(metadata)])).toStrictEqual([
      [['info-not-indirect', 'metadata-not-stream'], 'not-a-stream'],
      [['info-missing', 'metadata-dictionary', 'metadata-filtered', 'xmp-unreadable'], 'no-rdf'],
      [['info-missing', 'xmp-doctype'], 'doctype'],
      [['info-missing', 'xmp-unreadable'], 'not-well-formed'],
    ]);
  });
});

describe('reading metadata of an edited document', () => {
  it('reads the Info dictionary the trailer names as edited', () => {
    const document = loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
            { number: 3, body: '<</Producer(P)>>' },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    );
    internalsOf(document)?.objects.setTrailerEntry(pdfName('Info').bytes, pdfReference(3, 0));
    expect(readMetadata(document).info?.reference).toStrictEqual(pdfReference(3, 0));
  });
});

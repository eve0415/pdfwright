import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { readMetadata } from '../metadata/readMetadata.ts';
import { pdfName } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { writePdfX4Metadata } from './writeMetadata.ts';

const DATE = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const ID = `/ID[<${'0123456789abcdef'.repeat(2)}><${'ff'.repeat(16)}>]`;
const original =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"><rdf:Description rdf:about=""><xmpMM:DocumentID>xmp.did:original</xmpMM:DocumentID><xmpMM:RenditionClass>proof:pdf</xmpMM:RenditionClass><xmpMM:VersionID>7</xmpMM:VersionID></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

const document = (existing: boolean) =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: `<</Type/Catalog/Pages 2 0 R${existing ? '/Metadata 4 0 R' : ''}>>` },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
          ...(existing ? [{ number: 4, body: streamBody('/Type/Metadata/Subtype/XML', original) }] : []),
        ],
        trailer: `/Root 1 0 R${ID}`,
      },
    ]).bytes,
  );

const property = (input: ReturnType<typeof document>, name: string): string | undefined => {
  const { xmp } = readMetadata(input);
  const value = xmp !== undefined && 'packet' in xmp ? xmp.packet.properties.find(item => item.localName === name)?.value : undefined;
  return value?.kind === 'text' ? value.text : undefined;
};

describe('pdfx metadata', () => {
  it('keeps document and rendition identities and writes the PDF/X version', () => {
    const first = document(true);
    writePdfX4Metadata(first, { metadataDate: DATE, trapped: 'False' });
    expect(['DocumentID', 'RenditionClass', 'VersionID', 'GTS_PDFXVersion'].map(name => property(first, name))).toStrictEqual([
      'xmp.did:original',
      'proof:pdf',
      '7',
      'PDF/X-4',
    ]);
  });

  it('writes a given DocumentID in place of the existing one', () => {
    const replaced = document(true);
    writePdfX4Metadata(replaced, { metadataDate: DATE, trapped: 'False', documentId: 'xmp.did:new' });
    expect(property(replaced, 'DocumentID')).toBe('xmp.did:new');
  });

  it('writes the metadata date to Info ModDate and to the XMP modify and metadata dates', () => {
    // ISO 32000-1:2008, 7.9.4 and Table 317 for ModDate; XMP Part 3, Table 20 maps ModDate to xmp:ModifyDate.
    const dated = document(true);
    const date = pdfDate({ year: 2025, month: 11, day: 28, hour: 9, minute: 5, second: 7, offset: { sign: '+', hours: 9, minutes: 0 } });
    writePdfX4Metadata(dated, { metadataDate: date, trapped: 'False' });
    const modified = readMetadata(dated).info?.values.get('ModDate');
    expect([modified?.kind === 'text' ? modified.text : modified, property(dated, 'ModifyDate'), property(dated, 'MetadataDate')]).toStrictEqual([
      "D:20251128090507+09'00",
      '2025-11-28T09:05:07+09:00',
      '2025-11-28T09:05:07+09:00',
    ]);
  });

  it.each<['True' | 'False']>([['True'], ['False']])('writes Trapped %s to Info and to XMP pdf:Trapped', trapped => {
    // ISO 32000-1:2008, Table 317, and XMP Part 3, Table 20, which maps Trapped to pdf:Trapped.
    const marked = document(true);
    writePdfX4Metadata(marked, { metadataDate: DATE, trapped });
    expect([readMetadata(marked).info?.values.get('Trapped'), property(marked, 'Trapped')]).toStrictEqual([{ kind: 'name', name: trapped }, trapped]);
  });

  it('writes Info and XMP version together on a new packet', () => {
    const first = document(false);
    writePdfX4Metadata(first, { metadataDate: DATE, trapped: 'True' });
    const saved = loadDocument(first.save().toBytes());
    const info = readMetadata(saved).info?.values.get('GTS_PDFXVersion');
    expect(info).toStrictEqual({ kind: 'text', text: 'PDF/X-4', encoding: 'pdfdoc', languages: [], replaced: 0 });
    expect(property(saved, 'GTS_PDFXVersion')).toBe('PDF/X-4');
    expect(property(saved, 'VersionID')).toBe('1');
    expect(readMetadata(saved).info?.values.get('Trapped')).toStrictEqual({ kind: 'name', name: 'True' });
    expect(saved.catalog().get(pdfName('Metadata').bytes)?.kind).toBe('reference');
  });
});

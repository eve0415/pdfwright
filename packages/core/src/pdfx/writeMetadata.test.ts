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
  it('keeps document and rendition identities, writes PDF/X version and deterministic InstanceID', () => {
    const first = document(true);
    writePdfX4Metadata(first, { metadataDate: DATE, trapped: 'False' });
    expect(property(first, 'DocumentID')).toBe('xmp.did:original');
    expect(property(first, 'RenditionClass')).toBe('proof:pdf');
    expect(property(first, 'VersionID')).toBe('7');
    expect(property(first, 'GTS_PDFXVersion')).toBe('PDF/X-4');
    const second = document(true);
    writePdfX4Metadata(second, { metadataDate: DATE, trapped: 'False' });
    expect(property(first, 'InstanceID')).toBe(property(second, 'InstanceID'));
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

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ValidationError } from '../error/validationError.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { readMetadata } from './readMetadata.ts';
import { setMetadata } from './setMetadata.ts';

const ancestors = Array.from({ length: 50_000 }, (_, index) => `<rdf:li>uuid:${String(index)}</rdf:li>`).join('');
const packet = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"><photoshop:DocumentAncestors><rdf:Bag>${ancestors}</rdf:Bag></photoshop:DocumentAncestors></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
const source = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R/Metadata 4 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>' },
      { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', packet) },
    ],
    trailer: `/Root 1 0 R/ID[<${'11'.repeat(16)}><${'22'.repeat(16)}>]`,
  },
]).bytes;
const input = { modificationDate: pdfDate({ year: 2026, month: 9, day: 27, hour: 0, minute: 0, second: 0, offset: 'Z' }) };

describe('xmp token cap', () => {
  it('reads and preserves a packet with 50,000 DocumentAncestors entries at the default', () => {
    const document = loadDocument(source);
    expect(readMetadata(document).xmp).toHaveProperty('packet.properties.0.localName', 'DocumentAncestors');
    setMetadata(document, input);
    const saved = document.save().toBytes();
    expect(readMetadata(loadDocument(saved)).xmp).toHaveProperty('packet.properties.0.localName', 'DocumentAncestors');
    expect(new TextDecoder('latin1').decode(saved)).toContain(ancestors);
  });

  it('treats a packet above a caller cap as unreadable without discarding it', () => {
    const document = loadDocument(source);
    expect(readMetadata(document, { maxXmpTokens: 8192 }).xmp).toMatchObject({ unreadable: 'too-many-tokens' });
    expect(() => setMetadata(document, input, { maxXmpTokens: 8192 })).toThrow(ValidationError);
    expect(document.save().toBytes()).toStrictEqual(source);
  });

  it('rejects an invalid cap before reading or editing', () => {
    const document = loadDocument(source);
    expect(() => readMetadata(document, { maxXmpTokens: 0 })).toThrow(InvalidArgumentError);
    expect(() => setMetadata(document, input, { maxXmpTokens: Number.POSITIVE_INFINITY })).toThrow(InvalidArgumentError);
  });
});

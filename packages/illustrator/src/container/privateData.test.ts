import type { LoadedDocument, PdfDictionaryEntries, PdfObject, PdfReference } from '@pdfwright/core';

import { createDocument, loadDocument, pdfDate, pdfName, pt, rect } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { attachPrivateData } from './privateData.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const key = (name: string): Uint8Array => pdfName(name).bytes;
const dictionary = (value: PdfObject | undefined): PdfDictionaryEntries => {
  if (value?.kind !== 'dictionary') throw new Error('expected dictionary');
  return value.entries;
};
const reference = (value: PdfObject | undefined): PdfReference => {
  if (value?.kind !== 'reference') throw new Error('expected reference');
  return value;
};
const streamData = (loaded: LoadedDocument, entries: PdfDictionaryEntries, name: string): Uint8Array => {
  const entry = entries.get(key(name));
  const value = loaded.get(reference(entry));
  if (value.kind !== 'stream') throw new Error('expected stream');
  if (value.dictionary.get(key('Filter')) !== undefined) throw new Error('unexpected stream filter');
  return value.data;
};
const privateData = (loaded: LoadedDocument) => {
  const pieceInfo = dictionary(loaded.page(0).pieceInfo());
  const illustrator = dictionary(pieceInfo.get(key('Illustrator')));
  const privateEntry = illustrator.get(key('Private'));
  const privateObject = loaded.get(reference(privateEntry));
  const entries = dictionary(privateObject);
  return { illustrator, entries };
};

describe('illustrator private-data container', () => {
  it('writes a single unfiltered block, metadata prefix and equal dates', () => {
    const native = new TextEncoder().encode('%!PS-Adobe-3.0 \r%%EndComments\r%%BeginProlog\r');
    const metaDataLength = new TextEncoder().encode('%!PS-Adobe-3.0 \r%%EndComments\r').length;
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, {
      native: { bytes: native, metaDataLength },
      lastModified: date,
      options: { compression: 'zstandard-raw-blocks' },
    });
    const loaded = loadDocument(document.save().toBytes());
    const { illustrator, entries } = privateData(loaded);
    expect(layout.blockLengths).toHaveLength(1);
    expect(loaded.page(0).lastModified()).toStrictEqual(illustrator.get(key('LastModified')));
    expect(['ContainerVersion', 'CreatorVersion', 'RoundtripStreamType', 'RoundtripVersion', 'NumBlock'].map(name => entries.get(key(name)))).toStrictEqual([
      { kind: 'integer', value: 9 },
      { kind: 'integer', value: 30 },
      { kind: 'integer', value: 2 },
      { kind: 'integer', value: 30 },
      undefined,
    ]);
    expect(streamData(loaded, entries, 'AIMetaData')).toStrictEqual(native.slice(0, metaDataLength));
    const block = streamData(loaded, entries, 'AIPDFPrivateData1');
    expect(block.slice(0, 26)).toStrictEqual(new Uint8Array([...new TextEncoder().encode('%AI24_ZStandard_Data'), 0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]));
  });

  it('splits wrapped data every 65536 bytes and sets NumBlock only for multiple streams', () => {
    const bytes = new Uint8Array(70000);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, {
      native: { bytes, metaDataLength: 10 },
      lastModified: date,
      options: { compression: 'zstandard-raw-blocks' },
    });
    const loaded = loadDocument(document.save().toBytes());
    const { entries } = privateData(loaded);
    expect(layout.blockLengths).toStrictEqual([65536, 4493]);
    expect(entries.get(key('NumBlock'))).toStrictEqual({ kind: 'integer', value: 2 });
    expect(streamData(loaded, entries, 'AIPDFPrivateData1')).toHaveLength(65536);
    expect(streamData(loaded, entries, 'AIPDFPrivateData2')).toHaveLength(4493);
  });

  it('uses compressed blocks for the default native compression', () => {
    const bytes = new TextEncoder().encode('%!PS-Adobe-3.0\r'.repeat(5000));
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, { native: { bytes, metaDataLength: 16 }, lastModified: date, options: { compression: 'zstandard' } });
    expect(layout.blockLengths[0]).toBeLessThan(bytes.length / 4);
  });

  it('can package unnormalized frame and zlib-wrapper diagnostic variants', () => {
    const bytes = new TextEncoder().encode('%!PS-Adobe-3.0\r%%EndComments\r');
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 5, 0, 0, 0, 0x29, 0, 0, 1, 2, 3, 4, 5]);
    const first = createDocument();
    const firstPage = first.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    attachPrivateData(first, firstPage, {
      native: { bytes, metaDataLength: bytes.length },
      lastModified: date,
      options: { compression: 'zstandard', frameOverride: frame },
    });
    const second = createDocument();
    const secondPage = second.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    attachPrivateData(second, secondPage, {
      native: { bytes, metaDataLength: bytes.length },
      lastModified: date,
      options: { compression: 'zstandard', wrapper: 'zlib' },
    });
    expect(new TextDecoder('latin1').decode(first.save().toBytes())).toContain('%AI24_ZStandard_Data');
    expect(new TextDecoder('latin1').decode(second.save().toBytes())).toContain('%AI12_CompressedData');
  });
});

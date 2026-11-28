import type { LoadedDocument, PdfDictionaryEntries, PdfObject, PdfReference } from '@pdfwright/core';

import { InvalidArgumentError, createDocument, loadDocument, pdfDate, pdfName, pt, rect } from '@pdfwright/core';
import fc from 'fast-check';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { readIllustratorContainer } from '../read/readContainer.ts';
import { encodeRawFrame } from '../zstd/frame.ts';

import { attachPrivateData } from './privateData.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const key = (name: string): Uint8Array => pdfName(name).bytes;
const wrapper = new TextEncoder().encode('%AI24_ZStandard_Data');
const dictionary = (value: PdfObject | undefined): PdfDictionaryEntries => {
  if (value?.kind !== 'dictionary') {
    throw new Error('expected dictionary');
  }
  return value.entries;
};
const reference = (value: PdfObject | undefined): PdfReference => {
  if (value?.kind !== 'reference') {
    throw new Error('expected reference');
  }
  return value;
};
const streamData = (loaded: LoadedDocument, entries: PdfDictionaryEntries, name: string): Uint8Array => {
  const entry = entries.get(key(name));
  const value = loaded.get(reference(entry));
  if (value.kind !== 'stream') {
    throw new Error('expected stream');
  }
  if (value.dictionary.get(key('Filter')) !== undefined) {
    throw new Error('unexpected stream filter');
  }
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
    const bytes = new Uint8Array(70_000);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 256;
    }
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, {
      native: { bytes, metaDataLength: 10 },
      lastModified: date,
      options: { compression: 'zstandard-raw-blocks' },
    });
    const loaded = loadDocument(document.save().toBytes());
    const { entries } = privateData(loaded);
    expect(layout.blockLengths).toStrictEqual([65_536, 4493]);
    expect(entries.get(key('NumBlock'))).toStrictEqual({ kind: 'integer', value: 2 });
    expect(streamData(loaded, entries, 'AIPDFPrivateData1')).toHaveLength(65_536);
    expect(streamData(loaded, entries, 'AIPDFPrivateData2')).toHaveLength(4493);
  });

  it('uses compressed blocks for the default native compression', () => {
    const bytes = new TextEncoder().encode('%!PS-Adobe-3.0\r'.repeat(5000));
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, { native: { bytes, metaDataLength: 16 }, lastModified: date, options: { compression: 'zstandard' } });
    expect(layout.blockLengths[0]).toBeLessThan(bytes.length / 4);
  });

  it('packages an unnormalized diagnostic frame byte for byte', () => {
    const bytes = new TextEncoder().encode('%!PS-Adobe-3.0\r%%EndComments\r');
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 5, 0, 0, 0, 0x29, 0, 0, 1, 2, 3, 4, 5]);
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, {
      native: { bytes, metaDataLength: bytes.length },
      lastModified: date,
      options: { compression: 'zstandard', frameOverride: frame },
    });
    const loaded = loadDocument(document.save().toBytes());
    expect(layout.frame).toStrictEqual({ headerDescriptor: 0xa0, windowDescriptor: 5 });
    expect(streamData(loaded, privateData(loaded).entries, 'AIPDFPrivateData1')).toStrictEqual(new Uint8Array([...wrapper, ...frame]));
  });

  it.each([-1, 1.5, 30])('rejects metadata length %d outside the 29 native bytes', metaDataLength => {
    const bytes = new TextEncoder().encode('%!PS-Adobe-3.0\r%%EndComments\r');
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const attach = () =>
      attachPrivateData(document, page, { native: { bytes, metaDataLength }, lastModified: date, options: { compression: 'zstandard-raw-blocks' } });
    expect(attach).toThrow(InvalidArgumentError);
    expect(attach).toThrow(/metadata length/u);
  });

  it.each([0, 29])('writes a metadata stream of the first %d of 29 native bytes', metaDataLength => {
    const bytes = new TextEncoder().encode('%!PS-Adobe-3.0\r%%EndComments\r');
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    attachPrivateData(document, page, { native: { bytes, metaDataLength }, lastModified: date, options: { compression: 'zstandard-raw-blocks' } });
    const loaded = loadDocument(document.save().toBytes());
    expect(streamData(loaded, privateData(loaded).entries, 'AIMetaData')).toStrictEqual(bytes.slice(0, metaDataLength));
  });

  // A raw frame of n bytes up to 131,072 is 9 + n bytes long, so the wrapped data is 29 + n bytes; each further raw block adds a three-byte header.
  it.each([
    { nativeLength: 65_507, blockLengths: [65_536], numBlock: undefined },
    { nativeLength: 65_508, blockLengths: [65_536, 1], numBlock: { kind: 'integer', value: 2 } },
    { nativeLength: 131_043, blockLengths: [65_536, 65_536], numBlock: { kind: 'integer', value: 2 } },
    { nativeLength: 131_044, blockLengths: [65_536, 65_536, 1], numBlock: { kind: 'integer', value: 3 } },
    { nativeLength: 131_073, blockLengths: [65_536, 65_536, 33], numBlock: { kind: 'integer', value: 3 } },
  ])('splits $nativeLength native bytes into blocks of $blockLengths', ({ nativeLength, blockLengths, numBlock }) => {
    const bytes = new Uint8Array(nativeLength).fill(7);
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, {
      native: { bytes, metaDataLength: 0 },
      lastModified: date,
      options: { compression: 'zstandard-raw-blocks' },
    });
    const loaded = loadDocument(document.save().toBytes());
    const { entries } = privateData(loaded);
    expect(layout.blockLengths).toStrictEqual(blockLengths);
    expect(entries.get(key('NumBlock'))).toStrictEqual(numBlock);
    expect(blockLengths.map((_, index) => streamData(loaded, entries, `AIPDFPrivateData${String(index + 1)}`).length)).toStrictEqual(blockLengths);
    expect(entries.get(key(`AIPDFPrivateData${String(blockLengths.length + 1)}`))).toBeUndefined();
  });

  it('normalizes the frame a caller encoder returns', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blocks = encodeRawFrame(bytes).slice(6);
    const received: Array<Uint8Array> = [];
    // RFC 8878, 3.1.1.1.1: descriptor 0x24 sets Single_Segment_flag and Content_Checksum_flag, with a one-byte content size.
    const zstandard = (data: Uint8Array): Uint8Array => {
      received.push(data);
      return new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x24, data.length, ...blocks, 1, 2, 3, 4]);
    };
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const layout = attachPrivateData(document, page, { native: { bytes, metaDataLength: 0 }, lastModified: date, options: { compression: { zstandard } } });
    const loaded = loadDocument(document.save().toBytes());
    expect(received).toStrictEqual([bytes]);
    expect(layout.frame).toStrictEqual({ headerDescriptor: 0, windowDescriptor: 0x58 });
    expect(streamData(loaded, privateData(loaded).entries, 'AIPDFPrivateData1')).toStrictEqual(
      new Uint8Array([...wrapper, 0x28, 0xb5, 0x2f, 0xfd, 0, 0x58, ...blocks]),
    );
  });
});

describe('properties', () => {
  // Lengths stay inside one 65,536-byte block, whose boundaries the tests above cover.
  const nativeLength = fc.integer({ min: 0, max: 1024 });

  it('reads back the native bytes and metadata prefix it packages', () => {
    fc.assert(
      fc.property(nativeLength, fc.nat(), fc.integer(), (length, metaDataSeed, seed) => {
        const bytes = new Uint8Array(length);
        let state = seed >>> 0;
        for (let index = 0; index < length; index++) {
          state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
          bytes[index] = state >>> 24;
        }
        const metaDataLength = metaDataSeed % (length + 1);
        const document = createDocument();
        const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
        const layout = attachPrivateData(document, page, {
          native: { bytes, metaDataLength },
          lastModified: date,
          options: { compression: 'zstandard-raw-blocks' },
        });
        const read = readIllustratorContainer(document.save().toBytes(), decompress);
        // RFC 8878, 3.1.1 and 3.1.1.2: a six-byte frame header, then a three-byte header per 131,072-byte raw block.
        const wrappedLength = wrapper.length + 6 + 3 * Math.max(1, Math.ceil(length / 131_072)) + length;
        const fullBlocks = Math.floor((wrappedLength - 1) / 65_536);
        expect(read.native).toStrictEqual(bytes);
        expect(read.metaData).toStrictEqual(bytes.slice(0, metaDataLength));
        expect(read.blockLengths).toStrictEqual([...Array.from({ length: fullBlocks }, () => 65_536), wrappedLength - fullBlocks * 65_536]);
        expect(layout.blockLengths).toStrictEqual(read.blockLengths);
        expect(read.numBlock).toBe(fullBlocks > 0 ? fullBlocks + 1 : undefined);
      }),
    );
  });
});

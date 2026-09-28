import type { NativeCompression } from '../zstd/frame.ts';
import type { PdfDate, PdfDocument, PdfPage } from '@pdfwright/core';

import { InvalidArgumentError, PdfDictionaryEntries, pdfDictionary, pdfInteger, pdfName } from '@pdfwright/core';

import { encodeRawFrame, encodeZstandardFrame, normalizeZstandardFrame } from '../zstd/frame.ts';

export interface NativeData {
  readonly bytes: Uint8Array;
  /** Offset after the CR that closes %%EndComments. */
  readonly metaDataLength: number;
}

export interface PrivateDataOptions {
  readonly compression: NativeCompression;
}

export interface PrivateDataInput {
  readonly native: NativeData;
  readonly lastModified: PdfDate;
  readonly options: PrivateDataOptions;
}

export interface PrivateDataLayout {
  readonly blockLengths: readonly number[];
  readonly frame: { readonly headerDescriptor: number; readonly windowDescriptor: number };
}

const WRAPPER = new TextEncoder().encode('%AI24_ZStandard_Data');
const CHUNK_SIZE = 65536;
const compress = (bytes: Uint8Array, compression: NativeCompression): Uint8Array => {
  if (compression === 'zstandard') return encodeZstandardFrame(bytes);
  if (compression === 'zstandard-raw-blocks') return encodeRawFrame(bytes);
  return normalizeZstandardFrame(compression.zstandard(bytes));
};

/** Adds Illustrator page-piece data, including one unfiltered metadata stream and 65536-byte private chunks. */
export const attachPrivateData = (document: PdfDocument, page: PdfPage, input: PrivateDataInput): PrivateDataLayout => {
  const { native, lastModified, options } = input;
  if (!Number.isInteger(native.metaDataLength) || native.metaDataLength < 0 || native.metaDataLength > native.bytes.length) {
    throw new InvalidArgumentError('metadata length must be within native data');
  }
  const frame = compress(native.bytes, options.compression);
  const wrapped = new Uint8Array(WRAPPER.length + frame.length);
  wrapped.set(WRAPPER);
  wrapped.set(frame, WRAPPER.length);

  const entries = new PdfDictionaryEntries();
  const metadata = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: native.bytes.slice(0, native.metaDataLength) });
  entries.set(pdfName('AIMetaData').bytes, metadata);
  const blockLengths: number[] = [];
  for (let index = 1, offset = 0; offset < wrapped.length; offset += CHUNK_SIZE, index++) {
    const block = wrapped.slice(offset, offset + CHUNK_SIZE);
    const reference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: block });
    entries.set(pdfName(`AIPDFPrivateData${String(index)}`).bytes, reference);
    blockLengths.push(block.length);
  }
  entries.set(pdfName('ContainerVersion').bytes, pdfInteger(9));
  entries.set(pdfName('CreatorVersion').bytes, pdfInteger(30));
  if (blockLengths.length > 1) entries.set(pdfName('NumBlock').bytes, pdfInteger(blockLengths.length));
  entries.set(pdfName('RoundtripStreamType').bytes, pdfInteger(2));
  entries.set(pdfName('RoundtripVersion').bytes, pdfInteger(30));

  // ISO 32000-1:2008, 14.5: the page and application entry share one LastModified value for equality comparison.
  const privateReference = document.object(pdfDictionary(entries));
  page.pieceInfo({ lastModified, data: { Illustrator: { private: privateReference } } });
  return { blockLengths, frame: { headerDescriptor: frame[4] ?? 0, windowDescriptor: frame[5] ?? 0 } };
};

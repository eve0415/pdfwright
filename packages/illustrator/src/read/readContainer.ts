import type { LoadedDocument, PdfDictionaryEntries, PdfObject } from '@pdfwright/core';

import { InvalidArgumentError, ParseError, UnsupportedFeatureError, ValidationError, inflateZlib, loadDocument, pdfName } from '@pdfwright/core';

/** Decodes one complete Zstandard frame (RFC 8878, 3.1.1) and returns its decompressed content. */
export type ZstandardDecompressor = (frame: Uint8Array) => Uint8Array;

/** The compression the native payload's wrapper names; Zstandard reports the frame header's descriptor bytes. */
export type NativePayloadCompression =
  | {
      readonly kind: 'zstandard';
      /** RFC 8878, 3.1.1.1.1: the Frame_Header_Descriptor byte. */
      readonly frameHeaderDescriptor: number;
      /** RFC 8878, 3.1.1.1.2: the Window_Descriptor byte, absent when the Single_Segment_flag is set. */
      readonly windowDescriptor: number | undefined;
    }
  | { readonly kind: 'zlib' };

export interface ContainerFacts {
  readonly privateKeys: readonly string[];
  readonly containerVersion: number | undefined;
  readonly creatorVersion: number | undefined;
  readonly roundtripStreamType: number | undefined;
  readonly roundtripVersion: number | undefined;
  readonly numBlock: number | undefined;
  readonly blockLengths: readonly number[];
  readonly compression: NativePayloadCompression;
  readonly frameHeaderDescriptor: number | undefined;
  readonly windowDescriptor: number | undefined;
  readonly pageDate: Uint8Array;
  readonly applicationDate: Uint8Array;
  readonly metaData: Uint8Array | undefined;
  readonly native: Uint8Array;
}

const decoder = new TextDecoder();
const key = (name: string): Uint8Array => pdfName(name).bytes;

const ZSTANDARD_WRAPPER = '%AI24_ZStandard_Data';
const ZLIB_WRAPPER = '%AI12_CompressedData';
const WRAPPER_LENGTH = 20;

const resolve = (loaded: LoadedDocument, value: PdfObject | undefined, what: string): PdfObject => {
  if (value === undefined) throw new ParseError(`Illustrator ${what} is missing`, 0);
  return value.kind === 'reference' ? loaded.get(value) : value;
};

const dictionary = (loaded: LoadedDocument, value: PdfObject | undefined, what: string): PdfDictionaryEntries => {
  const object = resolve(loaded, value, what);
  if (object.kind !== 'dictionary') throw new ParseError(`Illustrator ${what} is not a dictionary`, 0);
  return object.entries;
};

const stringBytes = (loaded: LoadedDocument, value: PdfObject | undefined, what: string): Uint8Array => {
  const object = resolve(loaded, value, what);
  if (object.kind !== 'string') throw new ParseError(`Illustrator ${what} is not a string`, 0);
  return object.bytes;
};

// The private-data entries other than the blocks are reported when present and never required to read the native data.
const optionalInteger = (loaded: LoadedDocument, entries: PdfDictionaryEntries, name: string): number | undefined => {
  const value = entries.get(key(name));
  if (value === undefined) return undefined;
  const object = resolve(loaded, value, name);
  if (object.kind !== 'integer') throw new ParseError(`Illustrator ${name} is not an integer`, 0);
  return object.value;
};

const stream = (loaded: LoadedDocument, value: PdfObject | undefined, what: string): Uint8Array => {
  const object = resolve(loaded, value, what);
  if (object.kind !== 'stream') throw new ParseError(`Illustrator ${what} is not a stream`, 0);
  const filter = object.dictionary.get(key('Filter'));
  if (filter === undefined) return object.data;
  // ISO 32000-1:2008, 7.4.4: FlateDecode data is a zlib stream.
  if (filter.kind !== 'name' || decoder.decode(filter.bytes) !== 'FlateDecode') {
    throw new UnsupportedFeatureError(`Illustrator ${what} has a filter other than FlateDecode`);
  }
  return inflateZlib(object.data).data;
};

const join = (chunks: readonly Uint8Array[]): Uint8Array => {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};

interface Decoded {
  readonly native: Uint8Array;
  readonly compression: NativePayloadCompression;
}

const decompressZstandard = (frame: Uint8Array, zstandard: ZstandardDecompressor): Decoded => {
  // RFC 8878, 3.1.1: a four-byte magic number precedes the Frame_Header_Descriptor, which the Window_Descriptor follows.
  const frameHeaderDescriptor = frame.at(4);
  const windowDescriptor = frame.at(5);
  if (frameHeaderDescriptor === undefined) throw new ParseError('Zstandard frame header is truncated', WRAPPER_LENGTH + frame.length);
  // RFC 8878, 3.1.1.1.1: bit 5 of the Frame_Header_Descriptor is the Single_Segment_flag, and a single-segment frame has no Window_Descriptor.
  const singleSegment = Math.floor(frameHeaderDescriptor / 32) % 2 === 1;
  const native: unknown = zstandard(frame);
  if (!(native instanceof Uint8Array)) throw new InvalidArgumentError('zstandard must return a Uint8Array');
  return { native, compression: { kind: 'zstandard', frameHeaderDescriptor, windowDescriptor: singleSegment ? undefined : windowDescriptor } };
};

const decodeWrapped = (wrapped: Uint8Array, zstandard: ZstandardDecompressor): Decoded => {
  const wrapper = decoder.decode(wrapped.subarray(0, WRAPPER_LENGTH));
  const data = wrapped.subarray(WRAPPER_LENGTH);
  if (wrapper === ZSTANDARD_WRAPPER) return decompressZstandard(data, zstandard);
  if (wrapper === ZLIB_WRAPPER) return { native: inflateZlib(data).data, compression: { kind: 'zlib' } };
  throw new UnsupportedFeatureError('Illustrator native data has an unsupported compression wrapper');
};

/** Resolves the first page's Illustrator page-piece data, joins its private-data blocks and decompresses the native payload they wrap. */
export const readIllustratorContainer = (pdf: Uint8Array, zstandard: ZstandardDecompressor): ContainerFacts => {
  const loaded = loadDocument(pdf);
  if (loaded.pageCount === 0) throw new ValidationError('the PDF has no page');
  const page = loaded.page(0);
  // ISO 32000-1:2008, 14.5: page-piece data lives in the page's PieceInfo dictionary, keyed by the conforming product's name.
  const pieceInfo = page.pieceInfo();
  if (pieceInfo === undefined) throw new ValidationError('the first page has no page-piece data');
  const pieces = dictionary(loaded, pieceInfo, 'PieceInfo');
  const illustratorEntry = pieces.get(key('Illustrator'));
  if (illustratorEntry === undefined) throw new ValidationError('the first page has no Illustrator page-piece data');
  const illustrator = dictionary(loaded, illustratorEntry, 'page-piece dictionary');
  const pageDate = stringBytes(loaded, page.lastModified(), 'page LastModified');
  const applicationDate = stringBytes(loaded, illustrator.get(key('LastModified')), 'application LastModified');
  const privateData = dictionary(loaded, illustrator.get(key('Private')), 'Private dictionary');
  const privateKeys = [...privateData.entries()].map(([name]) => decoder.decode(name));
  const blocks = privateKeys
    .flatMap(name => {
      const match = /^AIPDFPrivateData(\d+)$/u.exec(name);
      return match === null ? [] : [{ name, index: Number(match[1]) }];
    })
    .toSorted((left, right) => left.index - right.index)
    .map(({ name }) => stream(loaded, privateData.get(key(name)), name));
  if (blocks.length === 0) throw new ValidationError('the Illustrator page-piece data has no native private-data blocks');
  const { native, compression } = decodeWrapped(join(blocks), zstandard);
  return {
    privateKeys,
    containerVersion: optionalInteger(loaded, privateData, 'ContainerVersion'),
    creatorVersion: optionalInteger(loaded, privateData, 'CreatorVersion'),
    roundtripStreamType: optionalInteger(loaded, privateData, 'RoundtripStreamType'),
    roundtripVersion: optionalInteger(loaded, privateData, 'RoundtripVersion'),
    numBlock: optionalInteger(loaded, privateData, 'NumBlock'),
    blockLengths: blocks.map(block => block.length),
    compression,
    frameHeaderDescriptor: compression.kind === 'zstandard' ? compression.frameHeaderDescriptor : undefined,
    windowDescriptor: compression.kind === 'zstandard' ? compression.windowDescriptor : undefined,
    pageDate,
    applicationDate,
    metaData: privateData.has(key('AIMetaData')) ? stream(loaded, privateData.get(key('AIMetaData')), 'AIMetaData') : undefined,
    native,
  };
};

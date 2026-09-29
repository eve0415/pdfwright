import type { IllustratorDocument } from '../model/illustratorDocument.ts';
import type { NativeOrigin } from '../native/nativeOrigin.ts';
import type { ContainerFacts, NativePayloadCompression, ZstandardDecompressor } from './readContainer.ts';
import type { NativeReadResult } from './readNative.ts';
import type { PdfDate } from '@pdfwright/core';

import { InvalidArgumentError, ParseError, parsePdfDate } from '@pdfwright/core';

import { readIllustratorContainer } from './readContainer.ts';
import { readNative } from './readNative.ts';

/** Options for `readIllustratorPdf`. */
export interface ReadIllustratorPdfOptions {
  /** Decodes the `%AI24_ZStandard_Data` payload's Zstandard frame; the package supplies no Zstandard decoder. A `%AI12_CompressedData` payload is zlib data and is inflated without it. */
  readonly zstandard: ZstandardDecompressor;
}

/** What `readIllustratorPdf` recovers from the first page's Illustrator page-piece data. */
export interface IllustratorPdfContents {
  /** The layer artwork in model coordinates under either native origin, with every optional field materialized and every number at the native copy's precision. */
  readonly document: IllustratorDocument;
  /** The origin the native copy's `%AI3_Cropmarks` declares. */
  readonly nativeOrigin: NativeOrigin;
  /** The native header comments through `%%EndComments`, keyed by the text before the first colon, with values as written, so bounding boxes stay in native coordinates. */
  readonly header: ReadonlyMap<string, string>;
  /** The decompressed native data. */
  readonly native: Uint8Array;
  /** The bytes of the page's and the Illustrator page-piece dictionary's `/LastModified` strings. */
  readonly lastModified: { readonly page: Uint8Array; readonly application: Uint8Array };
  /** The keys of the Illustrator `/Private` dictionary in file order. */
  readonly privateDataKeys: readonly string[];
  /** The length of each `AIPDFPrivateData` block in block order, after any stream filter is removed. */
  readonly blockLengths: readonly number[];
  /** The payload's compression and, for Zstandard, its frame header bytes. */
  readonly compression: NativePayloadCompression;
}

/** The container facts and the native read, for the public entry and the package's own tests. */
export interface IllustratorPdfRead {
  readonly facts: ContainerFacts;
  readonly read: NativeReadResult;
}

const decoder = new TextDecoder();

const pageDate = (bytes: Uint8Array): PdfDate => {
  const parsed = parsePdfDate(decoder.decode(bytes));
  if (parsed === undefined) throw new ParseError('the page LastModified is not a PDF date', 0);
  return parsed.date;
};

/** Reads the container and its native data; every public refusal comes from here. */
export const readIllustratorPdfParts = (pdf: Uint8Array, zstandard: ZstandardDecompressor): IllustratorPdfRead => {
  const facts = readIllustratorContainer(pdf, zstandard);
  return { facts, read: readNative(facts.native, pageDate(facts.pageDate)) };
};

/**
 * Reads the Illustrator-native layer copy of a PDF's first page back into an `IllustratorDocument`, with the native header and the container facts a test asserts on.
 *
 * A PDF without Illustrator page-piece data raises `ValidationError`; malformed container objects, dates, native bytes and numbers raise `ParseError`; an unknown compression wrapper, a block filter other than FlateDecode and native grammar the reader does not support raise `UnsupportedFeatureError`; and an `options.zstandard` that is not a function or returns something other than a `Uint8Array` raises `InvalidArgumentError`.
 */
export const readIllustratorPdf = (pdf: Uint8Array, options: ReadIllustratorPdfOptions): IllustratorPdfContents => {
  const supplied: unknown = options;
  if (typeof supplied !== 'object' || supplied === null || !('zstandard' in supplied) || typeof supplied.zstandard !== 'function') {
    throw new InvalidArgumentError('options.zstandard must be a Zstandard frame decoder');
  }
  const { facts, read } = readIllustratorPdfParts(pdf, options.zstandard);
  return {
    document: read.document,
    nativeOrigin: read.nativeOrigin,
    header: read.header,
    native: facts.native,
    lastModified: { page: facts.pageDate, application: facts.applicationDate },
    privateDataKeys: facts.privateKeys,
    blockLengths: facts.blockLengths,
    compression: facts.compression,
  };
};

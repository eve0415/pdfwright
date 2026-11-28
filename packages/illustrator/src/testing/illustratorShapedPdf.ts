import type { TestObject, TestSection } from '../../../core/src/testing/pdfBuilder.ts';

import { deflateZlib } from '@pdfwright/core';

import { buildPdf, latin1Text, streamBody } from '../../../core/src/testing/pdfBuilder.ts';

/** One stream in the Illustrator `/Private` dictionary, stored as given under its filter. */
export interface ShapedStream {
  readonly key: string;
  readonly stored: Uint8Array;
  readonly filter?: string;
}

/** The parts of an Illustrator page-piece container that a test replaces; every other object is fixed. */
export interface ShapedPdfInput {
  readonly streams: ReadonlyArray<ShapedStream>;
  /** Direct `/Private` entries after the stream references, such as `/ContainerVersion 9`. */
  readonly privateEntries?: string;
  /** The page's `/LastModified` string body. */
  readonly pageDate?: string;
  /** The page's `/PieceInfo` value. */
  readonly pieceInfo?: string;
  /** The entries of the Illustrator page-piece dictionary, object 5. */
  readonly applicationEntries?: string;
  /** Puts the page in an object stream indexed by a cross-reference stream. */
  readonly pageInObjectStream?: boolean;
  /** An incremental update appended to the file. */
  readonly update?: ReadonlyArray<TestObject>;
}

export const SHAPED_DATE = "D:20260927204901+09'00'";
const STREAM_BASE = 10;

/** The `%AI12_CompressedData` wrapper around zlib data, which the reader inflates without a Zstandard decoder. */
export const zlibWrapped = (native: Uint8Array): Uint8Array => {
  const header = new TextEncoder().encode('%AI12_CompressedData');
  const data = deflateZlib(native);
  const wrapped = new Uint8Array(header.length + data.length);
  wrapped.set(header);
  wrapped.set(data, header.length);
  return wrapped;
};

/** Writes a one-page PDF shaped like an Illustrator export, with each object written as text so a test can make any entry malformed. */
export const illustratorShapedPdf = (input: ShapedPdfInput): Uint8Array => {
  const pageDate = input.pageDate ?? SHAPED_DATE;
  const page = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R/PieceInfo ${input.pieceInfo ?? '<< /Illustrator 5 0 R >>'}/LastModified(${pageDate})>>`;
  const references = input.streams.map((stream, index) => `/${stream.key} ${String(STREAM_BASE + index)} 0 R`).join(' ');
  const objects: Array<TestObject> = [
    { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    ...(input.pageInObjectStream === true ? [] : [{ number: 3, body: page }]),
    { number: 4, body: streamBody('', 'q 0 0 0 1 k 20 20 30 30 re f Q') },
    { number: 5, body: `<<${input.applicationEntries ?? `/LastModified(${SHAPED_DATE})/Private 6 0 R`}>>` },
    { number: 6, body: `<< ${references} ${input.privateEntries ?? ''} >>` },
    ...input.streams.map((stream, index) => ({
      number: STREAM_BASE + index,
      body: streamBody(stream.filter === undefined ? '' : `/Filter/${stream.filter}`, latin1Text(stream.stored)),
    })),
  ];
  const first: TestSection =
    input.pageInObjectStream === true
      ? { xref: 'stream', objects, objectStreams: [{ number: 9, members: [{ number: 3, body: page }] }], trailer: '/Root 1 0 R' }
      : { xref: 'classic', objects, trailer: '/Root 1 0 R' };
  const sections: Array<TestSection> = input.update === undefined ? [first] : [first, { xref: 'classic', objects: input.update, trailer: '/Root 1 0 R' }];
  return buildPdf(sections).bytes;
};

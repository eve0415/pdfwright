import type { LoadedDocument, PdfDate, PdfDictionaryEntries, PdfDirectObject, PdfObject } from '@pdfwright/core';

import { inflateZlib, loadDocument, parsePdfDate, pdfName } from '@pdfwright/core';
import { decompress } from 'fzstd';

import { readNative } from './readNative.ts';

export interface ContainerFacts {
  readonly privateKeys: readonly string[];
  readonly containerVersion: number;
  readonly creatorVersion: number;
  readonly roundtripStreamType: number;
  readonly roundtripVersion: number;
  readonly numBlock: number | undefined;
  readonly blockLengths: readonly number[];
  readonly frameHeaderDescriptor: number;
  readonly windowDescriptor: number;
  readonly pageDate: Uint8Array;
  readonly applicationDate: Uint8Array;
  readonly metaData: Uint8Array;
  readonly native: Uint8Array;
}

export interface ReadResult extends ContainerFacts {
  readonly document: ReturnType<typeof readNative>['document'];
  readonly header: ReadonlyMap<string, string>;
}

const decoder = new TextDecoder();
const key = (name: string): Uint8Array => pdfName(name).bytes;

const resolve = (loaded: LoadedDocument, value: PdfObject | undefined): PdfObject => {
  if (value === undefined) throw new Error('missing Illustrator PDF object');
  return value.kind === 'reference' ? loaded.get(value) : value;
};

const dictionary = (loaded: LoadedDocument, value: PdfObject | undefined): PdfDictionaryEntries => {
  const object = resolve(loaded, value);
  if (object.kind !== 'dictionary') throw new Error('expected Illustrator dictionary');
  return object.entries;
};

const stringBytes = (loaded: LoadedDocument, value: PdfObject | undefined): Uint8Array => {
  const object = resolve(loaded, value);
  if (object.kind !== 'string') throw new Error('expected Illustrator date string');
  return object.bytes;
};

const integer = (loaded: LoadedDocument, value: PdfDirectObject | undefined): number => {
  const object = resolve(loaded, value);
  if (object.kind !== 'integer') throw new Error('expected Illustrator integer');
  return object.value;
};

const stream = (loaded: LoadedDocument, value: PdfDirectObject | undefined): Uint8Array => {
  const object = resolve(loaded, value);
  if (object.kind !== 'stream') throw new Error('expected Illustrator stream');
  const filter = object.dictionary.get(key('Filter'));
  if (filter === undefined) return object.data;
  if (filter.kind !== 'name' || decoder.decode(filter.bytes) !== 'FlateDecode') throw new Error('unsupported Illustrator stream filter');
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

/** Resolves Illustrator page-piece streams and decompresses their native Zstandard payload. */
export const readIllustratorContainer = (pdf: Uint8Array): ContainerFacts => {
  const loaded = loadDocument(pdf);
  const pageDate = stringBytes(loaded, loaded.page(0).lastModified());
  const pieceInfo = dictionary(loaded, loaded.page(0).pieceInfo());
  const illustrator = dictionary(loaded, pieceInfo.get(key('Illustrator')));
  const applicationDate = stringBytes(loaded, illustrator.get(key('LastModified')));
  const privateData = dictionary(loaded, illustrator.get(key('Private')));
  const privateKeys = [...privateData.entries()].map(([name]) => decoder.decode(name));
  const blocks = privateKeys
    .flatMap(name => {
      const match = /^AIPDFPrivateData(\d+)$/u.exec(name);
      return match === null ? [] : [{ name, index: Number(match[1]) }];
    })
    .toSorted((left, right) => left.index - right.index)
    .map(({ name }) => stream(loaded, privateData.get(key(name))));
  const wrapped = join(blocks);
  if (decoder.decode(wrapped.subarray(0, 20)) !== '%AI24_ZStandard_Data') throw new Error('unsupported Illustrator compression wrapper');
  const frame = wrapped.subarray(20);
  const native = decompress(frame);
  return {
    privateKeys,
    containerVersion: integer(loaded, privateData.get(key('ContainerVersion'))),
    creatorVersion: integer(loaded, privateData.get(key('CreatorVersion'))),
    roundtripStreamType: integer(loaded, privateData.get(key('RoundtripStreamType'))),
    roundtripVersion: integer(loaded, privateData.get(key('RoundtripVersion'))),
    numBlock: privateData.has(key('NumBlock')) ? integer(loaded, privateData.get(key('NumBlock'))) : undefined,
    blockLengths: blocks.map(block => block.length),
    frameHeaderDescriptor: frame[4] ?? 0,
    windowDescriptor: frame[5] ?? 0,
    pageDate,
    applicationDate,
    metaData: stream(loaded, privateData.get(key('AIMetaData'))),
    native,
  };
};

const dateFrom = (bytes: Uint8Array): PdfDate => {
  const parsed = parsePdfDate(decoder.decode(bytes));
  if (parsed === undefined) throw new Error('unreadable Illustrator page date');
  return parsed.date;
};

/** Reads the supported Illustrator-native layer model from a PDF page-piece container. */
export const readIllustratorPdf = (pdf: Uint8Array): ReadResult => {
  const facts = readIllustratorContainer(pdf);
  const read = readNative(facts.native, dateFrom(facts.pageDate));
  return { ...facts, document: read.document, header: read.header };
};

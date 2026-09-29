import type { ContainerFacts } from '../read/readContainer.ts';
import type { NativeReadResult } from '../read/readNative.ts';

import { decompress } from 'fzstd';

import { readIllustratorContainer as readContainer } from '../read/readContainer.ts';
import { readIllustratorPdfParts } from '../read/readIllustratorPdf.ts';

export type { ContainerFacts } from '../read/readContainer.ts';

export interface ReadResult extends ContainerFacts {
  readonly document: NativeReadResult['document'];
  readonly nativeOrigin: NativeReadResult['nativeOrigin'];
  readonly header: ReadonlyMap<string, string>;
  readonly unknownBlocks: readonly string[];
}

/** Resolves Illustrator page-piece streams and decompresses their native payload with fzstd, a development dependency. */
export const readIllustratorContainer = (pdf: Uint8Array): ContainerFacts => readContainer(pdf, decompress);

/** Reads the supported Illustrator-native layer model and every container fact, decompressing with fzstd. */
export const readIllustratorPdf = (pdf: Uint8Array): ReadResult => {
  const { facts, read } = readIllustratorPdfParts(pdf, decompress);
  return { ...facts, document: read.document, nativeOrigin: read.nativeOrigin, header: read.header, unknownBlocks: read.unknownBlocks };
};

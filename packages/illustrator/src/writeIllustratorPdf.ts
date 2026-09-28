import type { IllustratorDocument } from './model/illustratorDocument.ts';
import type { NativeCompression } from './zstd/frame.ts';

import { ValidationError, createDocument } from '@pdfwright/core';

import { attachPrivateData } from './container/privateData.ts';
import { writeNative } from './native/writeNative.ts';
import { drawPage } from './page/drawPage.ts';

export interface WriteIllustratorPdfOptions {
  /** Native-data compression or a caller-supplied complete Zstandard frame encoder. */
  readonly compression?: NativeCompression;
  /** ASCII Creator comment in the native header. */
  readonly creator?: string;
}

/** Writes one visible PDF page and a matching Illustrator-native layer copy in its page-piece data. */
export const writeIllustratorPdf = (model: IllustratorDocument, options: WriteIllustratorPdfOptions = {}): Uint8Array => {
  const { compression } = options;
  const supplied: unknown = compression;
  if (
    supplied !== undefined &&
    supplied !== 'zstandard' &&
    supplied !== 'zstandard-raw-blocks' &&
    (typeof supplied !== 'object' || supplied === null || !('zstandard' in supplied) || typeof supplied.zstandard !== 'function')
  ) {
    throw new ValidationError('compression must be a supported mode or a Zstandard encoder', 'illustrator-model');
  }
  const native = writeNative(model, options.creator === undefined ? {} : { creator: options.creator });
  const document = createDocument();
  const page = drawPage(document, model);
  attachPrivateData(document, page, { native, lastModified: model.lastModified, options: { compression: options.compression ?? 'zstandard' } });
  return document.save().toBytes();
};

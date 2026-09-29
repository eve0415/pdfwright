import type { IllustratorDocument } from './model/illustratorDocument.ts';
import type { NativeOrigin } from './native/nativeOrigin.ts';
import type { WriteNativeOptions } from './native/writeNative.ts';
import type { NativeCompression } from './zstd/frame.ts';

import { ValidationError, createDocument } from '@pdfwright/core';

import { attachPrivateData } from './container/privateData.ts';
import { prepareDocument } from './model/prepareDocument.ts';
import { writeNative } from './native/writeNative.ts';
import { drawPage } from './page/drawPage.ts';

export interface WriteIllustratorPdfOptions {
  /** Native-data compression or a caller-supplied complete Zstandard frame encoder. */
  readonly compression?: NativeCompression;
  /** ASCII Creator comment in the native header. */
  readonly creator?: string;
  /** Origin of the native layer copy's coordinates, `'artboard-bottom-left'` by default. The visible page is the same for both. */
  readonly nativeOrigin?: NativeOrigin;
}

const nativeOptions = (options: WriteIllustratorPdfOptions): WriteNativeOptions => {
  const origin: unknown = options.nativeOrigin;
  if (origin !== undefined && origin !== 'artboard-bottom-left' && origin !== 'artboard-top-left') {
    throw new ValidationError('nativeOrigin must be artboard-bottom-left or artboard-top-left', 'illustrator-model');
  }
  const { creator, nativeOrigin } = options;
  if (creator === undefined) return nativeOrigin === undefined ? {} : { nativeOrigin };
  return nativeOrigin === undefined ? { creator } : { creator, nativeOrigin };
};

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
  const prepared = prepareDocument(model);
  const native = writeNative(model, nativeOptions(options), prepared);
  const document = createDocument();
  const page = drawPage(document, model, prepared);
  attachPrivateData(document, page, { native, lastModified: model.lastModified, options: { compression: options.compression ?? 'zstandard' } });
  return document.save().toBytes();
};

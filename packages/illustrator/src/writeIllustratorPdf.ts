import type { IllustratorDocument } from './model/illustratorDocument.ts';
import type { NativeOrigin } from './native/nativeOrigin.ts';
import type { WriteNativeOptions } from './native/writeNative.ts';
import type { NativeCompression } from './zstd/frame.ts';
import type { DocumentInfo, DocumentOptions } from '@pdfwright/core';

import { InvalidArgumentError, ValidationError, createDocument } from '@pdfwright/core';

import { attachPrivateData } from './container/privateData.ts';
import { prepareDocument } from './model/prepareDocument.ts';
import { writeNative } from './native/writeNative.ts';
import { drawPage } from './page/drawPage.ts';

/** Options for `writeIllustratorPdf`. */
export interface WriteIllustratorPdfOptions {
  /** Native-data compression or a caller-supplied complete Zstandard frame encoder. */
  readonly compression?: NativeCompression;
  /** ASCII Creator comment in the native header. */
  readonly creator?: string;
  /** Origin of the native layer copy's coordinates, `'artboard-bottom-left'` by default. The visible page is the same for both. */
  readonly nativeOrigin?: NativeOrigin;
  /** Values for the PDF's document information dictionary, written with an agreeing XMP packet; `modificationDate` defaults to the model's `lastModified`. Without `info` the PDF has neither. */
  readonly info?: DocumentInfo;
  /** Fractional digits, 0 to 10, for the reals written on the visible page, such as coordinates and spot alternate components; 5 by default. The native copy keeps its own fixed precision. */
  readonly fractionDigits?: number;
}

const documentOptions = (model: IllustratorDocument, options: WriteIllustratorPdfOptions): DocumentOptions => {
  const { info, fractionDigits } = options;
  if (fractionDigits !== undefined && (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 10)) {
    throw new InvalidArgumentError('fractionDigits must be an integer from 0 to 10');
  }
  // ISO 32000-1:2008, 14.3.3, Table 317: ModDate is the date the document was most recently modified, which is the model's lastModified unless the caller says otherwise.
  const dated = info === undefined ? undefined : { ...info, modificationDate: info.modificationDate ?? model.lastModified };
  if (dated === undefined) return fractionDigits === undefined ? {} : { fractionDigits };
  return fractionDigits === undefined ? { info: dated } : { info: dated, fractionDigits };
};

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
  const document = createDocument(documentOptions(model, options));
  const page = drawPage(document, model, prepared);
  attachPrivateData(document, page, { native, lastModified: model.lastModified, options: { compression: options.compression ?? 'zstandard' } });
  return document.save().toBytes();
};

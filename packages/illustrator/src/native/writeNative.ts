import type { NativeData } from '../container/privateData.ts';
import type { IllustratorDocument } from '../model/illustratorDocument.ts';

import { coordinateNumber } from '../model/coordinateNumber.ts';
import { validateDocument } from '../model/validateDocument.ts';

import { nameBasedUuid } from './nameBasedUuid.ts';
import { createNativeWriter } from './nativeWriter.ts';
import { writeDocumentData } from './writeDocumentData.ts';
import { writeHeader } from './writeHeader.ts';
import { writeLayer } from './writeLayer.ts';
import { writePalette } from './writePalette.ts';

export interface WriteNativeOptions {
  readonly creator?: string;
  readonly convention?: 'bottom-left' | 'top-left';
}

const number = coordinateNumber;

/** Serializes the native layer copy with a metadata prefix ending at `%%EndComments`. */
export const writeNative = (document: IllustratorDocument, options: WriteNativeOptions = {}): NativeData => {
  validateDocument(document);
  const layerWriter = createNativeWriter();
  const yOffset = options.convention === 'top-left' ? -number(document.artboard.height) : 0;
  for (const [index, layer] of document.layers.entries()) writeLayer(layerWriter, layer, { index, yOffset });
  const layers = layerWriter.finish();
  const artboardUuid = nameBasedUuid('artboard', layers);
  const writer = createNativeWriter();
  const metaDataLength = writeHeader(writer, document, options);
  writer.line('%%BeginProlog');
  writer.line('%%EndProlog');
  writer.line('%%BeginSetup');
  writePalette(writer, document);
  writeDocumentData(writer, document, options.convention === undefined ? { artboardUuid } : { artboardUuid, convention: options.convention });
  writer.line('%%EndSetup');
  writer.raw(layers);
  writer.line('%%PageTrailer');
  writer.line('gsave annotatepage grestore showpage');
  writer.line('%%Trailer');
  writer.line('%%EOF');
  return { bytes: writer.finish(), metaDataLength };
};

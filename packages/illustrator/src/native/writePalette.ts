import type { IllustratorDocument } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';
import { documentColors } from './writeHeader.ts';

/** Writes the observed spot palette without a locale-specific registration swatch. */
export const writePalette = (writer: NativeWriter, document: IllustratorDocument): void => {
  writer.line('%AI5_BeginPalette');
  writer.line('0 0 Pb');
  for (const spot of documentColors(document).spots) {
    writer.line(...spot.alternate.map(component => formatNativeNumber(component)), { utf8: spot.name }, '0 x');
    writer.line({ utf8: spot.name });
    writer.line('Pc');
  }
  writer.line('PB');
  writer.line('%AI5_EndPalette');
};

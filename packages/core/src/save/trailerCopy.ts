import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';

import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName } from '../object/pdfObject.ts';

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

// ISO 32000-1:2008, 7.5.6: "The added trailer shall contain all the entries except the Prev entry (if present) from the previous trailer".
// XRefStm is also left out: 7.5.8.4 ties it to the section whose stream it names, and copying it forward would search that stream before the sections it follows.
const CLASSIC_EXCLUDED = new Set(['Prev', 'XRefStm']);

// A cross-reference stream dictionary also describes the stream itself: Table 5 (Length, Filter, DecodeParms, F, FFilter, FDecodeParms, DL) and Table 17 (Type, Index, W, Prev); Size is recomputed.
const STREAM_EXCLUDED = new Set([...CLASSIC_EXCLUDED, 'Length', 'Filter', 'DecodeParms', 'F', 'FFilter', 'FDecodeParms', 'DL', 'Type', 'Index', 'W']);

/** The entries of the base trailer that a new trailer carries over, in their order. */
export const copiedTrailerEntries = (base: PdfDictionaryEntries, baseKind: 'classic' | 'stream'): PdfDictionaryEntries => {
  const excluded = baseKind === 'classic' ? CLASSIC_EXCLUDED : STREAM_EXCLUDED;
  return parsedDictionaryEntries([...base.entries()].filter(([key]) => !excluded.has(latin1(key))));
};

export const TRAILER_KEYS = {
  size: pdfName('Size').bytes,
  prev: pdfName('Prev').bytes,
  id: pdfName('ID').bytes,
  root: pdfName('Root').bytes,
  info: pdfName('Info').bytes,
  type: pdfName('Type').bytes,
  index: pdfName('Index').bytes,
  w: pdfName('W').bytes,
} as const;

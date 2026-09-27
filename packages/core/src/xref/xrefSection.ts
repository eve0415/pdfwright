import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';

/**
 * One cross-reference entry: a free object, an object at a file offset, or an object inside an object stream.
 * For `file`, `location` is the byte offset; for `compressed`, it is the object stream's number and `generation` is the index within that stream.
 */
export interface XrefEntry {
  readonly objectNumber: number;
  readonly type: 'free' | 'file' | 'compressed';
  readonly location: number;
  readonly generation: number;
}

export interface XrefSection {
  readonly kind: 'classic' | 'stream';
  /** Offset of the keyword xref, or of the cross-reference stream's object header. */
  readonly offset: number;
  readonly entries: readonly XrefEntry[];
  readonly trailer: PdfDictionaryEntries;
  /** Byte span of the trailer dictionary, or of the cross-reference stream's dictionary. */
  readonly trailerStart: number;
  readonly trailerEnd: number;
}

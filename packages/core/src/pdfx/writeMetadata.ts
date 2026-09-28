import type { PdfDate } from '../date/pdfDate.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { MetadataChange } from '../metadata/setMetadata.ts';

import { setMetadata } from '../metadata/setMetadata.ts';

export interface PdfX4MetadataOptions {
  readonly metadataDate: PdfDate;
  readonly trapped: 'True' | 'False';
  readonly documentId?: string;
}

/** Writes the PDF/X-4 identification alongside synchronized Info and XMP values, using the metadata editor's deterministic identifiers. */
export const writePdfX4Metadata = (document: LoadedDocument, options: PdfX4MetadataOptions): MetadataChange =>
  setMetadata(
    document,
    { modificationDate: options.metadataDate, trapped: options.trapped, pdfxVersion: 'PDF/X-4' },
    { documentId: options.documentId === undefined ? 'keep' : { value: options.documentId } },
  );

import type { PdfDate } from '../date/pdfDate.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { MetadataChange } from '../metadata/setMetadata.ts';

import { setMetadata } from '../metadata/setMetadata.ts';

export interface PdfX4MetadataOptions {
  readonly metadataDate: PdfDate;
  readonly trapped: 'True' | 'False';
  readonly documentId?: string;
}

/** Calls setMetadata with the PDF/X-4 identification, `trapped`, and `metadataDate` as the modification and metadata date, keeping xmpMM:DocumentID unless `documentId` is given. */
export const writePdfX4Metadata = (document: LoadedDocument, options: PdfX4MetadataOptions): MetadataChange =>
  setMetadata(
    document,
    { modificationDate: options.metadataDate, trapped: options.trapped, pdfxVersion: 'PDF/X-4' },
    { documentId: options.documentId === undefined ? 'keep' : { value: options.documentId } },
  );

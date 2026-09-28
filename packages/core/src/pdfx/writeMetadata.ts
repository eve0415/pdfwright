import type { PdfDate } from '../date/pdfDate.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { MetadataChange } from '../metadata/setMetadata.ts';

import { setMetadata } from '../metadata/setMetadata.ts';

/** Requires a caller date and Trapped state, keeps an existing DocumentID unless given a replacement, and writes PDF/X-4 Info and XMP identification under ISO 32000-1:2008, Table 317 and XMP Part 3, Table 20. */
export interface PdfX4MetadataOptions {
  /** Date written to modification and XMP metadata dates. */
  readonly metadataDate: PdfDate;
  /** Info and XMP trapped state, True or False. */
  readonly trapped: 'True' | 'False';
  /** xmpMM:DocumentID to write in place of an existing ID. */
  readonly documentId?: string;
}

/** Calls setMetadata with the PDF/X-4 identification, `trapped`, and `metadataDate` as the modification and metadata date, keeping xmpMM:DocumentID unless `documentId` is given. */
export const writePdfX4Metadata = (document: LoadedDocument, options: PdfX4MetadataOptions): MetadataChange =>
  setMetadata(
    document,
    { modificationDate: options.metadataDate, trapped: options.trapped, pdfxVersion: 'PDF/X-4' },
    { documentId: options.documentId === undefined ? 'keep' : { value: options.documentId } },
  );

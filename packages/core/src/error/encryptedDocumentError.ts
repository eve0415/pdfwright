import { PdfwrightError } from './pdfwrightError.ts';

/** A PDF with encryption that loadDocument does not open. */
export class EncryptedDocumentError extends PdfwrightError {
  override readonly code = 'encrypted-document' as const;

  constructor(message: string) {
    super(message, 'encrypted-document');
    this.name = 'EncryptedDocumentError';
  }
}

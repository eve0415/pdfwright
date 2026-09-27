import { PdfwrightError } from './pdfwrightError.ts';

/** Why a validation failed, for the failures callers are expected to handle by reason. */
export type ValidationReason = 'document-id-required' | 'metadata-date-required' | 'xmp-unreadable' | 'xmp-unrepresentable' | 'signed-document';

export class ValidationError extends PdfwrightError {
  override readonly code = 'validation' as const;
  readonly reason: ValidationReason | undefined;

  constructor(message: string, reason?: ValidationReason) {
    super(message, 'validation');
    this.name = 'ValidationError';
    this.reason = reason;
  }
}

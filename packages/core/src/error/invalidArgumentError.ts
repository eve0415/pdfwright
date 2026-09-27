import { PdfwrightError } from './pdfwrightError.ts';

/** Why an argument was refused, for the refusals callers are expected to handle by reason. */
export type InvalidArgumentReason = 'metadata-history' | 'signed-document';

export class InvalidArgumentError extends PdfwrightError {
  override readonly code = 'invalid-argument' as const;
  readonly reason: InvalidArgumentReason | undefined;

  constructor(message: string, reason?: InvalidArgumentReason) {
    super(message, 'invalid-argument');
    this.name = 'InvalidArgumentError';
    this.reason = reason;
  }
}

import { PdfwrightError } from './pdfwrightError.ts';

/** An input exceeds a documented size, depth or work limit. */
export class ResourceLimitError extends PdfwrightError {
  override readonly code = 'resource-limit' as const;

  constructor(message: string) {
    super(message, 'resource-limit');
    this.name = 'ResourceLimitError';
  }
}

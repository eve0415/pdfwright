import { PdfwrightError } from './pdfwrightError.ts';

export class ResourceLimitError extends PdfwrightError {
  override readonly code = 'resource-limit' as const;

  constructor(message: string) {
    super(message, 'resource-limit');
    this.name = 'ResourceLimitError';
  }
}

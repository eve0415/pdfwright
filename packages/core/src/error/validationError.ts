import { PdfwrightError } from './pdfwrightError.ts';

export class ValidationError extends PdfwrightError {
  override readonly code = 'validation' as const;

  constructor(message: string) {
    super(message, 'validation');
    this.name = 'ValidationError';
  }
}

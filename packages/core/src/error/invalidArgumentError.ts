import { PdfwrightError } from './pdfwrightError.ts';

export class InvalidArgumentError extends PdfwrightError {
  override readonly code = 'invalid-argument' as const;

  constructor(message: string) {
    super(message, 'invalid-argument');
    this.name = 'InvalidArgumentError';
  }
}

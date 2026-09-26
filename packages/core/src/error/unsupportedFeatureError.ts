import { PdfwrightError } from './pdfwrightError.ts';

export class UnsupportedFeatureError extends PdfwrightError {
  override readonly code = 'unsupported-feature' as const;

  constructor(message: string) {
    super(message, 'unsupported-feature');
    this.name = 'UnsupportedFeatureError';
  }
}

export type PdfwrightErrorCode = 'invalid-argument' | 'parse' | 'encrypted-document' | 'unsupported-feature' | 'validation';

export class PdfwrightError extends Error {
  readonly code: PdfwrightErrorCode;

  constructor(message: string, code: PdfwrightErrorCode) {
    super(message);
    this.name = 'PdfwrightError';
    this.code = code;
  }
}

export type PdfwrightErrorCode =
  | 'invalid-argument'
  | 'invalid-profile'
  | 'parse'
  | 'encrypted-document'
  | 'unsupported-feature'
  | 'validation'
  | 'resource-limit';

export class PdfwrightError extends Error {
  readonly code: PdfwrightErrorCode;

  constructor(message: string, code: PdfwrightErrorCode) {
    super(message);
    this.name = 'PdfwrightError';
    this.code = code;
  }
}

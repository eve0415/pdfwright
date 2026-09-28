/** Stable top-level codes for invalid arguments or profiles, parsing, encryption, unsupported features, validation, and resource limits; subclasses may add a typed reason. */
export type PdfwrightErrorCode =
  | 'invalid-argument'
  | 'invalid-profile'
  | 'parse'
  | 'encrypted-document'
  | 'unsupported-feature'
  | 'validation'
  | 'resource-limit';

/** Base class for errors raised by pdfwright. */
export class PdfwrightError extends Error {
  readonly code: PdfwrightErrorCode;

  constructor(message: string, code: PdfwrightErrorCode) {
    super(message);
    this.name = 'PdfwrightError';
    this.code = code;
  }
}

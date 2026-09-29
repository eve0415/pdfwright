import { PdfwrightError } from './pdfwrightError.ts';

/** PDF or compressed data could not be parsed at the reported offset. */
export class ParseError extends PdfwrightError {
  override readonly code = 'parse' as const;
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message, 'parse');
    this.name = 'ParseError';
    this.offset = offset;
  }
}
